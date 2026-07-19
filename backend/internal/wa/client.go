package wa

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rust-meow/rust-meow/backend/internal/domain"
	searchutil "github.com/rust-meow/rust-meow/backend/internal/search"
	"github.com/rust-meow/rust-meow/backend/internal/store"
	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	_ "golang.org/x/image/webp"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

type Event struct {
	Kind                              string
	Message                           domain.Message
	Reaction                          domain.Reaction
	Chat                              domain.Chat
	ChatJID                           string
	OldChatJID                        string
	MessageID                         string
	Status                            domain.MessageStatus
	QR                                string
	QRExpires                         time.Time
	Detail                            string
	ChatsProcessed, MessagesProcessed uint64
	Complete                          bool
	RecoveredReactions                uint32
	RepairComplete                    bool
}
type Sink func(Event)

type Client struct {
	ctx                context.Context
	wa                 *whatsmeow.Client
	sessions           *sqlstore.Container
	db                 *sql.DB
	store              *store.Store
	sink               Sink
	log                *slog.Logger
	pairingMu          sync.Mutex
	pairing            bool
	handlerID          uint32
	reducer            chan func()
	reducerWG          sync.WaitGroup
	reducerDone        chan struct{}
	closeOnce          sync.Once
	accepting          atomic.Bool
	generation         atomic.Uint64
	logoutFn           func(context.Context) error
	clearAccountDataFn func(context.Context) error
	avatarDir          string
	mediaDir           string
	contactCache       sync.Map
	avatarFetchMu      sync.Mutex
	avatarFetches      map[string]*avatarFetch
	negativeAvatarMu   sync.Mutex
	negativeAvatars    map[string]time.Time
}

type avatarFetch struct {
	done chan struct{}
	path string
	err  error
}

type cachedContactDetails struct {
	details   ContactDetails
	expiresAt time.Time
	complete  bool
}

type ContactDetails struct {
	PhoneNumber  string
	ContactName  string
	PushName     string
	BusinessName string
}

type ContactSearchResult struct {
	JID, ChatID, DisplayName, SecondaryName, PhoneNumber string
	Score                                                int
}

type LogoutError struct {
	Stage         string
	Remote, Local error
}

func (e *LogoutError) Error() string {
	switch e.Stage {
	case "isolation":
		return "logout_isolation_failed: " + e.Local.Error()
	case "local_clear":
		return fmt.Sprintf("logout_local_clear_failed: remote=%v local=%v", e.Remote, e.Local)
	default:
		return "logout_remote_failed_after_local_clear: " + e.Remote.Error()
	}
}

func New(ctx context.Context, dataDir string, productStore *store.Store, sink Sink, log *slog.Logger) (*Client, error) {
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "session.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, "PRAGMA foreign_keys=ON"); err != nil {
		db.Close()
		return nil, err
	}
	container := sqlstore.NewWithDB(db, "sqlite3", nil)
	if err = container.Upgrade(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("upgrade whatsmeow store: %w", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		container.Close()
		return nil, err
	}
	w := whatsmeow.NewClient(device, nil)
	c := &Client{ctx: ctx, wa: w, sessions: container, db: db, store: productStore, sink: sink, log: log, reducer: make(chan func(), 256), reducerDone: make(chan struct{}), avatarDir: filepath.Join(dataDir, "avatars"), mediaDir: filepath.Join(dataDir, "media"), avatarFetches: make(map[string]*avatarFetch), negativeAvatars: make(map[string]time.Time)}
	c.logoutFn = w.Logout
	c.clearAccountDataFn = productStore.ClearAccountData
	c.accepting.Store(true)
	c.reducerWG.Add(1)
	go func() {
		defer c.reducerWG.Done()
		for {
			select {
			case <-c.reducerDone:
				return
			default:
			}
			select {
			case task := <-c.reducer:
				task()
			case <-c.reducerDone:
				return
			}
		}
	}()
	c.handlerID = w.AddEventHandler(c.handleEvent)
	return c, nil
}

func (c *Client) Connect() error {
	c.sink(Event{Kind: "connection", Detail: "connecting"})
	return c.wa.ConnectContext(c.ctx)
}
func (c *Client) IsPaired() bool    { return c.wa.Store.ID != nil }
func (c *Client) IsConnected() bool { return c.wa.IsConnected() }
func (c *Client) OwnID() string {
	if c.wa.Store.ID == nil {
		return ""
	}
	return c.wa.Store.ID.String()
}

func (c *Client) resolveConversation(rawJID string) (string, string, error) {
	jid, err := types.ParseJID(rawJID)
	if err != nil {
		return "", "", err
	}
	jid = jid.ToNonAD()
	transport := jid.String()
	addresses := []string{transport}
	if c.wa != nil && jid.Server == types.HiddenUserServer {
		if pn, mapErr := c.wa.Store.LIDs.GetPNForLID(c.ctx, jid); mapErr != nil {
			c.log.Warn("resolve PN alias for LID", "jid", transport, "error", mapErr)
		} else if !pn.IsEmpty() {
			addresses = append(addresses, pn.ToNonAD().String())
		}
	} else if c.wa != nil && jid.Server == types.DefaultUserServer {
		if lid, mapErr := c.wa.Store.LIDs.GetLIDForPN(c.ctx, jid); mapErr != nil {
			c.log.Warn("resolve LID alias for PN", "jid", transport, "error", mapErr)
		} else if !lid.IsEmpty() {
			addresses = append(addresses, lid.ToNonAD().String())
		}
	}
	chatID, merges, err := c.store.EnsureConversation(c.ctx, addresses...)
	if err != nil {
		return "", "", err
	}
	for _, merge := range merges {
		if c.sink != nil {
			c.sink(Event{Kind: "chat_merge", OldChatJID: merge.OldChatID, ChatJID: merge.NewChatID})
		}
	}
	return chatID, transport, nil
}

func (c *Client) ChatAvatar(ctx context.Context, chatID string) (string, error) {
	addresses, err := c.store.ConversationAddresses(ctx, chatID)
	if err != nil {
		return "", err
	}
	return c.avatarForAddresses(ctx, addresses...)
}

func (c *Client) ContactDetails(ctx context.Context, rawJID string) ContactDetails {
	return c.contactDetailsForAddresses(ctx, rawJID)
}

func (c *Client) ContactDetailsForChat(ctx context.Context, chatID string) ContactDetails {
	addresses, err := c.store.ConversationAddresses(ctx, chatID)
	if err != nil {
		return ContactDetails{}
	}
	return c.contactDetailsForAddresses(ctx, addresses...)
}

func (c *Client) ChatPresentation(ctx context.Context, chatID string) (ContactDetails, string) {
	addresses, err := c.store.ConversationAddresses(ctx, chatID)
	if err != nil {
		return ContactDetails{}, ""
	}
	details := c.contactDetailsForAddresses(ctx, addresses...)
	for _, jid := range c.identityJIDs(ctx, addresses...) {
		if path := c.cachedAvatarForJID(jid); path != "" {
			return details, path
		}
	}
	return details, ""
}

func (c *Client) contactDetailsForAddresses(ctx context.Context, rawJIDs ...string) ContactDetails {
	for _, rawJID := range rawJIDs {
		if cached, ok := c.contactCache.Load(rawJID); ok {
			entry, valid := cached.(cachedContactDetails)
			if valid && time.Now().Before(entry.expiresAt) && (entry.complete || len(rawJIDs) == 1) {
				return entry.details
			}
			c.contactCache.Delete(rawJID)
		}
	}
	candidates := c.identityJIDs(ctx, rawJIDs...)
	if len(candidates) == 0 || candidates[0].Server == types.GroupServer {
		return ContactDetails{}
	}
	var info types.ContactInfo
	phone := ""
	for _, jid := range candidates {
		resolved, _ := c.wa.Store.Contacts.GetContact(ctx, jid)
		info = mergeContactInfo(info, resolved)
		if phone == "" && jid.Server == types.DefaultUserServer && jid.User != "" {
			phone = "+" + jid.User
		}
	}
	if phone == "" && info.RedactedPhone != "" {
		phone = info.RedactedPhone
	}
	contactName := info.FullName
	if contactName == "" {
		contactName = info.FirstName
	}
	details := ContactDetails{
		PhoneNumber:  phone,
		ContactName:  contactName,
		PushName:     info.PushName,
		BusinessName: info.BusinessName,
	}
	// Identity mappings and push names are imported asynchronously. Only cache a
	// complete identity for a long period; partial/negative entries must be
	// retried soon so an early list request cannot poison the whole session.
	complete := details.PhoneNumber != "" && (details.ContactName != "" || details.PushName != "" || details.BusinessName != "")
	ttl := 5 * time.Second
	if complete {
		ttl = 10 * time.Minute
	}
	entry := cachedContactDetails{details: details, expiresAt: time.Now().Add(ttl), complete: complete}
	for _, jid := range candidates {
		c.contactCache.Store(jid.String(), entry)
	}
	for _, rawJID := range rawJIDs {
		c.contactCache.Store(rawJID, entry)
	}
	return details
}

func (c *Client) identityJIDs(ctx context.Context, rawJIDs ...string) []types.JID {
	candidates := make([]types.JID, 0, len(rawJIDs)+1)
	seen := make(map[string]bool, len(rawJIDs)+1)
	add := func(jid types.JID) {
		jid = jid.ToNonAD()
		if jid.IsEmpty() || seen[jid.String()] {
			return
		}
		seen[jid.String()] = true
		candidates = append(candidates, jid)
	}
	for _, rawJID := range rawJIDs {
		jid, err := types.ParseJID(rawJID)
		if err != nil {
			continue
		}
		add(jid)
	}
	// Conversation callers already supply both aliases. Avoid querying the
	// whatsmeow mapping database once per alias (and again for cached avatars)
	// when the explicit set is sufficient.
	hasLID, hasPN := false, false
	for _, jid := range candidates {
		hasLID = hasLID || jid.Server == types.HiddenUserServer
		hasPN = hasPN || jid.Server == types.DefaultUserServer
	}
	if c.wa != nil && c.wa.Store != nil && !(hasLID && hasPN) {
		original := append([]types.JID(nil), candidates...)
		for _, jid := range original {
			if jid.Server != types.HiddenUserServer && jid.Server != types.DefaultUserServer {
				continue
			}
			if alt, altErr := c.wa.Store.GetAltJID(ctx, jid); altErr == nil {
				add(alt)
			}
		}
	}
	return candidates
}

func mergeContactInfo(first, second types.ContactInfo) types.ContactInfo {
	if first.FirstName == "" {
		first.FirstName = second.FirstName
	}
	if first.FullName == "" {
		first.FullName = second.FullName
	}
	if first.PushName == "" {
		first.PushName = second.PushName
	}
	if first.BusinessName == "" {
		first.BusinessName = second.BusinessName
	}
	if first.RedactedPhone == "" {
		first.RedactedPhone = second.RedactedPhone
	}
	return first
}

func (c *Client) SearchContacts(ctx context.Context, query string, limit int) ([]ContactSearchResult, error) {
	contacts, err := c.wa.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		return nil, err
	}
	addressMap, err := c.store.ConversationAddressMap(ctx)
	if err != nil {
		return nil, err
	}
	type aggregate struct {
		jid        types.JID
		identities []types.JID
		info       types.ContactInfo
	}
	aggregates := make(map[string]*aggregate)
	for jid, info := range contacts {
		jid = jid.ToNonAD()
		if jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer {
			continue
		}
		identities := c.identityJIDs(ctx, jid.String())
		canonical := jid
		for _, identity := range identities {
			if identity.Server == types.DefaultUserServer {
				canonical = identity
				break
			}
		}
		key := canonical.String()
		entry := aggregates[key]
		if entry == nil {
			entry = &aggregate{jid: canonical}
			aggregates[key] = entry
		}
		entry.info = mergeContactInfo(entry.info, info)
		for _, identity := range identities {
			if !slices.ContainsFunc(entry.identities, func(existing types.JID) bool { return existing.String() == identity.String() }) {
				entry.identities = append(entry.identities, identity)
			}
		}
	}
	matcher := searchutil.New(query)
	queryDigits := searchutil.Digits(query)
	ownID := c.OwnID()
	if parsedOwn, parseErr := types.ParseJID(ownID); parseErr == nil {
		ownID = parsedOwn.ToNonAD().String()
	}
	results := make([]ContactSearchResult, 0, len(aggregates))
	for _, entry := range aggregates {
		if slices.ContainsFunc(entry.identities, func(identity types.JID) bool { return identity.ToNonAD().String() == ownID }) {
			continue
		}
		info := entry.info
		phone := info.RedactedPhone
		for _, identity := range entry.identities {
			if identity.Server == types.DefaultUserServer && identity.User != "" {
				phone = "+" + identity.User
				break
			}
		}
		displayName := info.FullName
		if displayName == "" {
			displayName = info.FirstName
		}
		if displayName == "" {
			displayName = info.BusinessName
		}
		if displayName == "" {
			displayName = info.PushName
		}
		if displayName == "" {
			displayName = phone
		}
		if displayName == "" {
			displayName = entry.jid.User
		}
		secondary := info.BusinessName
		if secondary == "" || secondary == displayName {
			secondary = info.PushName
		}
		if secondary == displayName {
			secondary = ""
		}
		score := searchutil.NoMatch
		for _, field := range []struct {
			value string
			bonus int
		}{{info.FullName, 300}, {info.FirstName, 280}, {info.BusinessName, 220}, {info.PushName, 180}} {
			if match := matcher.Score(field.value); match != searchutil.NoMatch && match+field.bonus > score {
				score = match + field.bonus
			}
		}
		if queryDigits != "" {
			if match := searchutil.New(queryDigits).Score(searchutil.Digits(phone)); match != searchutil.NoMatch && match+140 > score {
				score = match + 140
			}
		}
		if score == searchutil.NoMatch {
			continue
		}
		chatID := ""
		for _, identity := range entry.identities {
			if mapped := addressMap[identity.String()]; mapped != "" {
				chatID = mapped
				break
			}
		}
		results = append(results, ContactSearchResult{JID: entry.jid.String(), ChatID: chatID, DisplayName: displayName, SecondaryName: secondary, PhoneNumber: phone, Score: score})
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		return results[i].DisplayName < results[j].DisplayName
	})
	if limit <= 0 || limit > 8 {
		limit = 8
	}
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (c *Client) OpenContact(ctx context.Context, rawJID string) (domain.Chat, error) {
	jid, err := types.ParseJID(rawJID)
	if err != nil || (jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer) {
		return domain.Chat{}, fmt.Errorf("invalid direct-contact JID")
	}
	chatID, _, err := c.resolveConversation(jid.ToNonAD().String())
	if err != nil {
		return domain.Chat{}, err
	}
	return c.store.Chat(ctx, chatID)
}

func (c *Client) Avatar(ctx context.Context, rawJID string) (string, error) {
	return c.avatarForAddresses(ctx, rawJID)
}

func (c *Client) avatarForAddresses(ctx context.Context, rawJIDs ...string) (string, error) {
	candidates := c.identityJIDs(ctx, rawJIDs...)
	if len(candidates) == 0 {
		return "", fmt.Errorf("invalid avatar JID")
	}
	for _, jid := range candidates {
		if path := c.cachedAvatarForJID(jid); path != "" {
			return path, nil
		}
	}
	keys := make([]string, len(candidates))
	for i := range candidates {
		keys[i] = candidates[i].String()
	}
	sort.Strings(keys)
	key := strings.Join(keys, "\x00")
	c.avatarFetchMu.Lock()
	if existing := c.avatarFetches[key]; existing != nil {
		c.avatarFetchMu.Unlock()
		select {
		case <-existing.done:
			return existing.path, existing.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	call := &avatarFetch{done: make(chan struct{})}
	c.avatarFetches[key] = call
	c.avatarFetchMu.Unlock()

	var lastErr error
	hadCleanResult := false
	for _, jid := range candidates {
		call.path, call.err = c.fetchAvatar(ctx, jid)
		if call.path != "" {
			break
		}
		if call.err != nil {
			lastErr = call.err
		} else {
			hadCleanResult = true
		}
	}
	if call.path == "" {
		if hadCleanResult {
			call.err = nil
		} else {
			call.err = lastErr
		}
	}
	c.avatarFetchMu.Lock()
	delete(c.avatarFetches, key)
	close(call.done)
	c.avatarFetchMu.Unlock()
	return call.path, call.err
}

func (c *Client) fetchAvatar(ctx context.Context, jid types.JID) (string, error) {
	if err := os.MkdirAll(c.avatarDir, 0o700); err != nil {
		return "", fmt.Errorf("create avatar cache: %w", err)
	}
	path := c.avatarPath(jid)
	if stat, statErr := os.Lstat(path); statErr == nil && stat.Mode().IsRegular() && stat.Size() > 0 && time.Since(stat.ModTime()) < 24*time.Hour {
		return path, nil
	}
	c.negativeAvatarMu.Lock()
	negativeUntil := c.negativeAvatars[jid.String()]
	c.negativeAvatarMu.Unlock()
	if time.Now().Before(negativeUntil) {
		return "", nil
	}
	if !c.wa.IsConnected() {
		return "", fmt.Errorf("WhatsApp is not connected")
	}

	fetchCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	info, err := c.wa.GetProfilePictureInfo(fetchCtx, jid, &whatsmeow.GetProfilePictureParams{Preview: true})
	if errors.Is(err, whatsmeow.ErrProfilePictureUnauthorized) || errors.Is(err, whatsmeow.ErrProfilePictureNotSet) {
		c.negativeAvatarMu.Lock()
		c.negativeAvatars[jid.String()] = time.Now().Add(6 * time.Hour)
		c.negativeAvatarMu.Unlock()
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get profile picture: %w", err)
	}
	if info == nil || info.URL == "" {
		return "", nil
	}
	if err = validateAvatarURL(info.URL); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, info.URL, nil)
	if err != nil {
		return "", err
	}
	httpClient := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("too many profile picture redirects")
			}
			return validateAvatarURL(req.URL.String())
		},
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download profile picture: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download profile picture: HTTP %s", resp.Status)
	}
	const maxAvatarBytes = 2 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAvatarBytes+1))
	if err != nil {
		return "", fmt.Errorf("read profile picture: %w", err)
	}
	if len(data) == 0 || len(data) > maxAvatarBytes {
		return "", fmt.Errorf("profile picture has invalid size")
	}
	contentType := strings.Split(http.DetectContentType(data), ";")[0]
	if contentType != "image/jpeg" && contentType != "image/png" {
		return "", fmt.Errorf("profile picture has unsupported content type %s", contentType)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 2048 || config.Height > 2048 || int64(config.Width)*int64(config.Height) > 4_000_000 {
		return "", fmt.Errorf("profile picture has invalid dimensions")
	}
	temporary, err := os.CreateTemp(c.avatarDir, ".avatar-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create avatar cache file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0o600); err == nil {
		_, err = temporary.Write(data)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("cache profile picture: %w", err)
	}
	if err = os.Rename(temporaryPath, path); err != nil {
		return "", fmt.Errorf("publish profile picture cache: %w", err)
	}
	c.pruneAvatarCache(128 * 1024 * 1024)
	return path, nil
}

func (c *Client) CachedAvatar(rawJID string) string {
	for _, jid := range c.identityJIDs(c.ctx, rawJID) {
		if path := c.cachedAvatarForJID(jid); path != "" {
			return path
		}
	}
	return ""
}

func (c *Client) CachedChatAvatar(chatID string) string {
	addresses, err := c.store.ConversationAddresses(c.ctx, chatID)
	if err != nil {
		return ""
	}
	for _, jid := range c.identityJIDs(c.ctx, addresses...) {
		if path := c.cachedAvatarForJID(jid); path != "" {
			return path
		}
	}
	return ""
}

func (c *Client) cachedAvatarForJID(jid types.JID) string {
	path := c.avatarPath(jid.ToNonAD())
	if stat, statErr := os.Lstat(path); statErr == nil && stat.Mode().IsRegular() && stat.Size() > 0 && time.Since(stat.ModTime()) < 24*time.Hour {
		return path
	}
	return ""
}

func validateAvatarURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return fmt.Errorf("profile picture URL is not valid HTTPS")
	}
	return nil
}

func (c *Client) pruneAvatarCache(maxBytes int64) {
	entries, err := os.ReadDir(c.avatarDir)
	if err != nil {
		return
	}
	type cachedFile struct {
		path string
		size int64
		mod  time.Time
	}
	files := make([]cachedFile, 0, len(entries))
	var total int64
	for _, entry := range entries {
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() || filepath.Ext(entry.Name()) != ".jpg" {
			continue
		}
		files = append(files, cachedFile{path: filepath.Join(c.avatarDir, entry.Name()), size: info.Size(), mod: info.ModTime()})
		total += info.Size()
	}
	if total <= maxBytes {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, file := range files {
		if total <= maxBytes {
			break
		}
		if os.Remove(file.path) == nil {
			total -= file.size
		}
	}
}

func (c *Client) avatarPath(jid types.JID) string {
	name := fmt.Sprintf("%x.jpg", sha256.Sum256([]byte(jid.String())))
	return filepath.Join(c.avatarDir, name)
}

func (c *Client) StartPairing(ctx context.Context) error {
	c.sink(Event{Kind: "connection", Detail: "pairing"})
	c.pairingMu.Lock()
	if c.pairing {
		c.pairingMu.Unlock()
		return nil
	}
	c.pairing = true
	c.pairingMu.Unlock()
	qr, err := c.wa.GetQRChannel(ctx)
	if err != nil {
		c.finishPairing()
		return err
	}
	if !c.wa.IsConnected() {
		if err = c.wa.ConnectContext(ctx); err != nil {
			c.finishPairing()
			return err
		}
	}
	go func() {
		defer c.finishPairing()
		for item := range qr {
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				c.sink(Event{Kind: "qr", QR: item.Code, QRExpires: time.Now().Add(item.Timeout)})
			case "success":
				c.sink(Event{Kind: "connection", Detail: "connected"})
			case whatsmeow.QRChannelEventError:
				detail := "pairing failed"
				if item.Error != nil {
					detail = item.Error.Error()
				}
				c.sink(Event{Kind: "problem", Detail: detail})
			case "timeout":
				c.sink(Event{Kind: "connection", Detail: "offline"})
			default:
				c.sink(Event{Kind: "problem", Detail: "pairing ended: " + item.Event})
			}
		}
	}()
	return nil
}
func (c *Client) finishPairing() { c.pairingMu.Lock(); c.pairing = false; c.pairingMu.Unlock() }

func (c *Client) replyContext(ctx context.Context, chatID, messageID string) (*waE2E.ContextInfo, error) {
	if messageID == "" {
		return nil, nil
	}
	target, err := c.store.Message(ctx, chatID, messageID)
	if err != nil {
		return nil, err
	}
	return &waE2E.ContextInfo{
		StanzaID:      proto.String(target.ID),
		Participant:   proto.String(target.SenderJID),
		RemoteJID:     proto.String(target.TransportJID),
		QuotedMessage: quotedMessage(target),
	}, nil
}

func quotedMessage(message domain.Message) *waE2E.Message {
	switch message.Kind {
	case "image":
		mimeType, caption := "", message.Text
		if message.Image != nil {
			mimeType, caption = message.Image.MIMEType, message.Image.Caption
		}
		return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String(mimeType), Caption: proto.String(caption)}}
	case "sticker":
		mimeType := "image/webp"
		if message.Image != nil && message.Image.MIMEType != "" {
			mimeType = message.Image.MIMEType
		}
		return &waE2E.Message{StickerMessage: &waE2E.StickerMessage{Mimetype: proto.String(mimeType)}}
	default:
		return &waE2E.Message{Conversation: proto.String(message.Text)}
	}
}

func (c *Client) SendText(ctx context.Context, clientID, chatID, text, replyToID string) (domain.Message, error) {
	transport, err := c.store.PreferredJID(ctx, chatID)
	if err != nil {
		return domain.Message{}, err
	}
	resolvedChat, _, err := c.resolveConversation(transport)
	if err != nil {
		return domain.Message{}, err
	}
	chatID = resolvedChat
	resolvedTransport, err := c.store.PreferredJID(ctx, chatID)
	if err != nil {
		return domain.Message{}, err
	}
	jid, err := types.ParseJID(resolvedTransport)
	if err != nil {
		return domain.Message{}, err
	}
	replyContext, err := c.replyContext(ctx, chatID, replyToID)
	if err != nil {
		return domain.Message{}, err
	}
	waID := string(c.wa.GenerateMessageID())
	pending := domain.Message{ID: waID, ChatJID: chatID, TransportJID: jid.String(), SenderJID: c.OwnID(), Text: text, Timestamp: time.Now(), FromMe: true, Status: domain.StatusPending, Kind: "text", ReplyToID: replyToID}
	waID, existed, err := c.store.ReserveOutgoingMessage(ctx, clientID, pending)
	if err != nil {
		return domain.Message{}, err
	}
	if existed {
		return c.store.Message(ctx, chatID, waID)
	}
	msg := pending
	sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	outgoing := &waE2E.Message{Conversation: proto.String(text)}
	if replyContext != nil {
		outgoing = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(text), ContextInfo: replyContext}}
	}
	resp, err := c.wa.SendMessage(sendCtx, jid, outgoing, whatsmeow.SendRequestExtra{ID: types.MessageID(waID)})
	if err != nil {
		msg.Status = domain.StatusFailed
		_ = c.store.ApplyMessage(ctx, msg, false)
		c.emitChat(chatID)
		return msg, err
	}
	msg.Timestamp = resp.Timestamp
	msg.Status = domain.StatusSent
	err = c.store.ApplyMessage(ctx, msg, false)
	c.emitChat(chatID)
	return msg, err
}

const maxImageBytes = 32 * 1024 * 1024

func supportedImageMIME(data []byte) (string, error) {
	mimeType := strings.Split(http.DetectContentType(data), ";")[0]
	switch mimeType {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return mimeType, nil
	default:
		return "", fmt.Errorf("unsupported image type %s", mimeType)
	}
}

func imageExtension(mimeType string) string {
	switch mimeType {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".img"
	}
}

func (c *Client) mediaPath(chatID, messageID, mimeType string) string {
	name := fmt.Sprintf("%x%s", sha256.Sum256([]byte(chatID+"\x00"+messageID)), imageExtension(mimeType))
	return filepath.Join(c.mediaDir, name)
}

func (c *Client) CachedImagePath(chatID, messageID, mimeType string) string {
	path := c.mediaPath(chatID, messageID, mimeType)
	stat, err := os.Lstat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > maxImageBytes {
		return ""
	}
	return path
}

func (c *Client) cacheImageBytes(chatID, messageID, mimeType string, data []byte) (string, error) {
	if err := os.MkdirAll(c.mediaDir, 0o700); err != nil {
		return "", fmt.Errorf("create media cache: %w", err)
	}
	path := c.mediaPath(chatID, messageID, mimeType)
	temporary, err := os.CreateTemp(c.mediaDir, ".image-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create image cache file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0o600); err == nil {
		_, err = temporary.Write(data)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("write image cache: %w", err)
	}
	if err = os.Rename(temporaryPath, path); err != nil {
		return "", fmt.Errorf("publish image cache: %w", err)
	}
	c.pruneMediaCache(512 * 1024 * 1024)
	return path, nil
}

func (c *Client) SendImage(ctx context.Context, clientID, chatID, sourcePath, caption, replyToID string) (domain.Message, error) {
	transport, err := c.store.PreferredJID(ctx, chatID)
	if err != nil {
		return domain.Message{}, err
	}
	resolvedChat, _, err := c.resolveConversation(transport)
	if err != nil {
		return domain.Message{}, err
	}
	chatID = resolvedChat
	resolvedTransport, err := c.store.PreferredJID(ctx, chatID)
	if err != nil {
		return domain.Message{}, err
	}
	chat, err := types.ParseJID(resolvedTransport)
	if err != nil {
		return domain.Message{}, err
	}
	replyContext, err := c.replyContext(ctx, chatID, replyToID)
	if err != nil {
		return domain.Message{}, err
	}
	file, err := os.Open(sourcePath)
	if err != nil {
		return domain.Message{}, fmt.Errorf("open image: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxImageBytes {
		return domain.Message{}, fmt.Errorf("image must be a regular file between 1 byte and %d MiB", maxImageBytes/(1024*1024))
	}
	data, err := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxImageBytes {
		return domain.Message{}, fmt.Errorf("read image: invalid size or data")
	}
	mimeType, err := supportedImageMIME(data)
	if err != nil {
		return domain.Message{}, err
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return domain.Message{}, fmt.Errorf("decode image: %w", err)
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 100_000_000 {
		return domain.Message{}, fmt.Errorf("image dimensions are invalid or too large")
	}
	width, height := uint32(config.Width), uint32(config.Height)
	waID := string(c.wa.GenerateMessageID())
	localPath, err := c.cacheImageBytes(chatID, waID, mimeType, data)
	if err != nil {
		return domain.Message{}, err
	}
	pending := domain.Message{ID: waID, ChatJID: chatID, TransportJID: chat.String(), SenderJID: c.OwnID(), Text: caption, Timestamp: time.Now(), FromMe: true, Status: domain.StatusPending, Kind: "image", ReplyToID: replyToID,
		Image: &domain.Image{Caption: caption, MIMEType: mimeType, LocalPath: localPath, Width: width, Height: height, FileSize: uint64(len(data))}}
	if pending.Text == "" {
		pending.Text = "📷 Photo"
	}
	waID, existed, err := c.store.ReserveOutgoingMessage(ctx, clientID, pending)
	if err != nil {
		return domain.Message{}, err
	}
	if existed {
		if pending.ID != waID {
			_ = os.Remove(localPath)
		}
		return c.store.Message(ctx, chatID, waID)
	}
	uploadCtx, cancelUpload := context.WithTimeout(ctx, 90*time.Second)
	upload, err := c.wa.Upload(uploadCtx, data, whatsmeow.MediaImage)
	cancelUpload()
	if err != nil {
		pending.Status = domain.StatusFailed
		_ = c.store.ApplyMessage(ctx, pending, false)
		return pending, fmt.Errorf("upload image: %w", err)
	}
	pending.Image.DirectPath = upload.DirectPath
	pending.Image.MediaKey = upload.MediaKey
	pending.Image.FileSHA256 = upload.FileSHA256
	pending.Image.FileEncSHA256 = upload.FileEncSHA256
	imageMessage := &waE2E.ImageMessage{
		Caption: proto.String(caption), Mimetype: proto.String(mimeType), Width: proto.Uint32(width), Height: proto.Uint32(height),
		URL: &upload.URL, DirectPath: &upload.DirectPath, MediaKey: upload.MediaKey, FileEncSHA256: upload.FileEncSHA256,
		FileSHA256: upload.FileSHA256, FileLength: &upload.FileLength, ContextInfo: replyContext,
	}
	sendCtx, cancelSend := context.WithTimeout(ctx, 30*time.Second)
	response, err := c.wa.SendMessage(sendCtx, chat, &waE2E.Message{ImageMessage: imageMessage}, whatsmeow.SendRequestExtra{ID: types.MessageID(waID)})
	cancelSend()
	if err != nil {
		pending.Status = domain.StatusFailed
		_ = c.store.ApplyMessage(ctx, pending, false)
		c.emitChat(chatID)
		return pending, err
	}
	pending.Timestamp = response.Timestamp
	pending.Status = domain.StatusSent
	err = c.store.ApplyMessage(ctx, pending, false)
	c.emitChat(chatID)
	return pending, err
}

func (c *Client) DownloadImage(ctx context.Context, chatID, messageID string) (string, error) {
	message, err := c.store.Message(ctx, chatID, messageID)
	if err != nil {
		return "", err
	}
	chatID = message.ChatJID
	if message.Image == nil {
		return "", fmt.Errorf("message is not an image")
	}
	imageInfo := message.Image
	if imageInfo.DirectPath == "" || len(imageInfo.MediaKey) == 0 {
		imageInfo, err = c.recoverImageDescriptor(ctx, message, imageInfo)
		if err != nil {
			return "", err
		}
	}
	path := c.mediaPath(chatID, messageID, imageInfo.MIMEType)
	if cachedPath := c.CachedImagePath(chatID, messageID, imageInfo.MIMEType); cachedPath != "" {
		if imageInfo.LocalPath != path {
			_ = c.store.SetImageLocalPath(ctx, chatID, messageID, path)
		}
		return cachedPath, nil
	}
	if imageInfo.DirectPath == "" || len(imageInfo.MediaKey) == 0 {
		return "", fmt.Errorf("image is not downloadable")
	}
	if err = os.MkdirAll(c.mediaDir, 0o700); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(c.mediaDir, ".download-*.tmp")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return "", err
	}
	downloadCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	err = c.wa.DownloadToFile(downloadCtx, downloadableImage(message.Kind, imageInfo), temporary)
	cancel()
	if err != nil {
		// History often contains an expired direct path. Ask the primary for the
		// current descriptor only after a failed fetch, then retry once; this
		// keeps normal scrolling network-free and avoids infinite retry loops.
		refreshed, refreshErr := c.recoverImageDescriptor(ctx, message, imageInfo)
		if refreshErr == nil {
			imageInfo = refreshed
			path = c.mediaPath(chatID, messageID, imageInfo.MIMEType)
			resetErr := temporary.Truncate(0)
			if resetErr == nil {
				_, resetErr = temporary.Seek(0, io.SeekStart)
			}
			if resetErr == nil {
				downloadCtx, cancel = context.WithTimeout(ctx, 60*time.Second)
				err = c.wa.DownloadToFile(downloadCtx, downloadableImage(message.Kind, imageInfo), temporary)
				cancel()
			}
		}
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("download image: %w", err)
	}
	stat, err := os.Stat(temporaryPath)
	if err != nil || stat.Size() <= 0 || stat.Size() > maxImageBytes {
		return "", fmt.Errorf("downloaded image has invalid size")
	}
	if err = os.Rename(temporaryPath, path); err != nil {
		return "", err
	}
	if err = c.store.SetImageLocalPath(ctx, chatID, messageID, path); err != nil {
		return "", err
	}
	c.pruneMediaCache(512 * 1024 * 1024)
	return path, nil
}

func downloadableImage(kind string, image *domain.Image) whatsmeow.DownloadableMessage {
	if kind == "sticker" {
		return &waE2E.StickerMessage{Mimetype: &image.MIMEType, DirectPath: &image.DirectPath, MediaKey: image.MediaKey,
			FileSHA256: image.FileSHA256, FileEncSHA256: image.FileEncSHA256, FileLength: &image.FileSize,
			Width: &image.Width, Height: &image.Height, IsAnimated: &image.Animated}
	}
	return &waE2E.ImageMessage{Mimetype: &image.MIMEType, DirectPath: &image.DirectPath, MediaKey: image.MediaKey,
		FileSHA256: image.FileSHA256, FileEncSHA256: image.FileEncSHA256, FileLength: &image.FileSize,
		Width: &image.Width, Height: &image.Height}
}

func (c *Client) recoverImageDescriptor(ctx context.Context, message domain.Message, previous *domain.Image) (*domain.Image, error) {
	if !c.wa.IsConnected() {
		return nil, fmt.Errorf("image metadata is missing and WhatsApp is offline")
	}
	chat, err := types.ParseJID(message.TransportJID)
	if err != nil {
		return nil, err
	}
	sender := types.EmptyJID
	if !message.FromMe {
		sender, err = types.ParseJID(message.SenderJID)
		if err != nil {
			return nil, err
		}
		sender = sender.ToNonAD()
	}
	requestCtx, cancelRequest := context.WithTimeout(ctx, 20*time.Second)
	_, err = c.wa.SendPeerMessage(requestCtx, c.wa.BuildUnavailableMessageRequest(chat, sender, message.ID))
	cancelRequest()
	if err != nil {
		return nil, fmt.Errorf("request image metadata from primary phone: %w", err)
	}
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, fmt.Errorf("primary phone did not return image metadata in time")
		case <-ticker.C:
			refreshed, loadErr := c.store.Message(ctx, message.ChatJID, message.ID)
			if loadErr != nil {
				return nil, loadErr
			}
			if refreshed.Image != nil && refreshed.Image.DirectPath != "" && len(refreshed.Image.MediaKey) > 0 && imageDescriptorChanged(previous, refreshed.Image) {
				return refreshed.Image, nil
			}
		}
	}
}

func imageDescriptorChanged(previous, current *domain.Image) bool {
	if current == nil || current.DirectPath == "" || len(current.MediaKey) == 0 {
		return false
	}
	if previous == nil || previous.DirectPath == "" || len(previous.MediaKey) == 0 {
		return true
	}
	return current.DirectPath != previous.DirectPath || !bytes.Equal(current.MediaKey, previous.MediaKey) || !bytes.Equal(current.FileEncSHA256, previous.FileEncSHA256)
}

func (c *Client) pruneMediaCache(maxBytes int64) {
	entries, err := os.ReadDir(c.mediaDir)
	if err != nil {
		return
	}
	type cachedFile struct {
		path string
		size int64
		mod  time.Time
	}
	files := make([]cachedFile, 0, len(entries))
	var total int64
	for _, entry := range entries {
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		files = append(files, cachedFile{filepath.Join(c.mediaDir, entry.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, file := range files {
		if total <= maxBytes {
			break
		}
		if os.Remove(file.path) == nil {
			total -= file.size
		}
	}
}

func (c *Client) SendReaction(ctx context.Context, clientID, chatID, messageID, emoji string) (domain.Reaction, error) {
	target, err := c.store.Message(ctx, chatID, messageID)
	if err != nil {
		return domain.Reaction{}, err
	}
	chatID = target.ChatJID
	chat, err := types.ParseJID(target.TransportJID)
	if err != nil {
		return domain.Reaction{}, err
	}
	if chat.Server == types.NewsletterServer {
		return domain.Reaction{}, fmt.Errorf("newsletter reactions are not supported")
	}
	sender := types.EmptyJID
	if !target.FromMe {
		sender, err = types.ParseJID(target.SenderJID)
		if err != nil {
			return domain.Reaction{}, err
		}
	}
	own, err := types.ParseJID(c.OwnID())
	if err != nil {
		return domain.Reaction{}, err
	}
	reaction := domain.Reaction{ChatJID: chatID, MessageID: messageID, SenderJID: own.ToNonAD().String(), Emoji: emoji, FromMe: true}
	reaction, completed, err := c.store.ReserveOutgoingReaction(ctx, clientID, reaction)
	if err != nil {
		return domain.Reaction{}, err
	}
	if completed {
		return reaction, nil
	}
	sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	response, err := c.wa.SendMessage(sendCtx, chat, c.wa.BuildReaction(chat, sender, types.MessageID(messageID), emoji))
	if err != nil {
		return domain.Reaction{}, err
	}
	reaction.Timestamp = response.Timestamp
	if reaction.Timestamp.IsZero() {
		reaction.Timestamp = time.Now()
	}
	if err = c.store.CompleteOutgoingReaction(ctx, clientID, reaction); err != nil {
		return domain.Reaction{}, err
	}
	c.sink(Event{Kind: "reaction", Reaction: reaction})
	return reaction, nil
}

func (c *Client) RepairRecentReactions(ctx context.Context, chatID string) (uint32, bool, error) {
	items, targeted, err := c.store.ReserveLegacyReactionReplays(ctx, chatID, 16)
	if err != nil {
		return 0, false, err
	}
	if targeted {
		if len(items) == 0 {
			return 0, false, store.ErrReactionRepairNotNeeded
		}
		var attempts uint32
		var firstErr error
		own, ownErr := types.ParseJID(c.OwnID())
		if ownErr != nil {
			return 0, false, ownErr
		}
		requestID := c.wa.GenerateMessageID()
		var replayRequest *waE2E.Message
		for _, item := range items {
			if item.Attempts > attempts {
				attempts = item.Attempts
			}
			sender := types.EmptyJID
			if !item.FromMe {
				var parseErr error
				sender, parseErr = types.ParseJID(item.SenderJID)
				if parseErr != nil {
					if firstErr == nil {
						firstErr = parseErr
					}
					continue
				}
				sender = sender.ToNonAD()
			}
			if markErr := c.store.MarkLegacyReactionReplayRequested(ctx, chatID, item.EventMessageID, string(requestID)); markErr != nil {
				if firstErr == nil {
					firstErr = markErr
				}
				continue
			}
			transport, parseErr := types.ParseJID(item.TransportJID)
			if parseErr != nil {
				if firstErr == nil {
					firstErr = parseErr
				}
				continue
			}
			itemRequest := c.wa.BuildUnavailableMessageRequest(transport, sender, item.EventMessageID)
			if replayRequest == nil {
				replayRequest = itemRequest
			} else {
				target := replayRequest.GetProtocolMessage().GetPeerDataOperationRequestMessage()
				source := itemRequest.GetProtocolMessage().GetPeerDataOperationRequestMessage()
				target.PlaceholderMessageResendRequest = append(target.PlaceholderMessageResendRequest, source.GetPlaceholderMessageResendRequest()...)
			}
		}
		if replayRequest != nil {
			sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			_, sendErr := c.wa.SendMessage(sendCtx, own.ToNonAD(), replayRequest, whatsmeow.SendRequestExtra{ID: requestID, Peer: true})
			cancel()
			if sendErr != nil && firstErr == nil {
				firstErr = sendErr
			}
		}
		return attempts, true, firstErr
	}
	job, requested, err := c.store.BeginReactionRepair(ctx, chatID)
	if err != nil || !requested {
		return job.Attempts, requested, err
	}
	chat, err := types.ParseJID(job.TransportJID)
	if err != nil {
		return job.Attempts, false, err
	}
	info := &types.MessageInfo{
		MessageSource: types.MessageSource{Chat: chat, IsFromMe: job.AnchorFromMe},
		ID:            types.MessageID(job.AnchorMessageID),
		Timestamp:     job.AnchorTimestamp,
	}
	sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, err = c.wa.SendPeerMessage(sendCtx, c.wa.BuildHistorySyncRequest(info, 50))
	return job.Attempts, true, err
}

func (c *Client) MarkRead(ctx context.Context, chatID, messageID string) error {
	m, err := c.store.Message(ctx, chatID, messageID)
	if err != nil {
		return err
	}
	if m.FromMe {
		return fmt.Errorf("message is outgoing")
	}
	chatID = m.ChatJID
	unread, err := c.store.UnreadThrough(ctx, chatID, messageID)
	if err != nil {
		return err
	}
	type receiptGroup struct {
		ids    []types.MessageID
		rawIDs []string
		latest time.Time
		sender types.JID
		chat   types.JID
	}
	groups := make(map[string]*receiptGroup)
	for _, item := range unread {
		transportJID, parseErr := types.ParseJID(item.TransportJID)
		if parseErr != nil {
			return parseErr
		}
		senderJID, parseErr := types.ParseJID(item.SenderJID)
		if parseErr != nil {
			return parseErr
		}
		key := transportJID.String() + "\x00" + senderJID.String()
		group := groups[key]
		if group == nil {
			group = &receiptGroup{sender: senderJID, chat: transportJID}
			groups[key] = group
		}
		group.ids = append(group.ids, types.MessageID(item.ID))
		group.rawIDs = append(group.rawIDs, item.ID)
		if item.Timestamp.After(group.latest) {
			group.latest = item.Timestamp
		}
	}
	for _, group := range groups {
		if err = c.wa.MarkRead(ctx, group.ids, group.latest, group.chat, group.sender); err != nil {
			return err
		}
		if err = c.store.MarkReadIDs(ctx, chatID, group.rawIDs); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) Logout(ctx context.Context) error {
	c.accepting.Store(false)
	c.generation.Add(1)
	if err := c.reducerBarrier(ctx); err != nil {
		return &LogoutError{Stage: "isolation", Local: err}
	}
	remoteErr := c.logoutFn(ctx)
	localErr := c.clearAccountDataFn(ctx)
	if avatarErr := os.RemoveAll(c.avatarDir); localErr == nil && avatarErr != nil {
		localErr = avatarErr
	}
	if mediaErr := os.RemoveAll(c.mediaDir); localErr == nil && mediaErr != nil {
		localErr = mediaErr
	}
	c.contactCache.Range(func(key, _ any) bool {
		c.contactCache.Delete(key)
		return true
	})
	c.negativeAvatarMu.Lock()
	clear(c.negativeAvatars)
	c.negativeAvatarMu.Unlock()
	if localErr != nil {
		return &LogoutError{Stage: "local_clear", Remote: remoteErr, Local: localErr}
	}
	if remoteErr != nil && !errors.Is(remoteErr, whatsmeow.ErrNotLoggedIn) {
		return &LogoutError{Stage: "remote", Remote: remoteErr}
	}
	c.accepting.Store(true)
	return nil
}
func (c *Client) Close() {
	c.closeOnce.Do(func() {
		c.wa.Disconnect()
		c.wa.RemoveEventHandler(c.handlerID)
		close(c.reducerDone)
		c.reducerWG.Wait()
		_ = c.sessions.Close()
	})
}

func (c *Client) handleEvent(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		c.sink(Event{Kind: "connection", Detail: "connected"})
	case *events.Disconnected:
		c.sink(Event{Kind: "connection", Detail: "offline"})
	case *events.LoggedOut:
		c.sink(Event{Kind: "connection", Detail: "logged_out"})
	case *events.StreamReplaced:
		c.sink(Event{Kind: "problem", Detail: "session replaced by another client"})
	case *events.Message:
		c.enqueue(func() { c.reduceMessage(evt, true) })
	case *events.Receipt:
		c.enqueue(func() { c.reduceReceipt(evt) })
	case *events.HistorySync:
		// Identity mappings and push names are stored asynchronously by
		// whatsmeow, so identities resolved against an earlier chunk are stale.
		c.clearContactCache()
		c.enqueue(func() { c.reduceHistory(evt) })
	case *events.Archive:
		c.enqueue(func() { c.reduceArchive(evt) })
	case *events.Contact:
		c.invalidateContact(evt.JID)
	case *events.PushName:
		c.invalidateContact(evt.JID, evt.JIDAlt)
	case *events.BusinessName:
		c.invalidateContact(evt.JID)
	case *events.Picture:
		for _, jid := range c.identityJIDs(c.ctx, evt.JID.String()) {
			_ = os.Remove(c.avatarPath(jid))
			c.negativeAvatarMu.Lock()
			delete(c.negativeAvatars, jid.String())
			c.negativeAvatarMu.Unlock()
		}
	}
}

func (c *Client) clearContactCache() {
	c.contactCache.Range(func(key, _ any) bool {
		c.contactCache.Delete(key)
		return true
	})
}

func (c *Client) invalidateContact(jids ...types.JID) {
	for _, jid := range jids {
		for _, candidate := range c.identityJIDs(c.ctx, jid.String()) {
			c.contactCache.Delete(candidate.String())
		}
	}
}

func (c *Client) enqueue(task func()) {
	generation := c.generation.Load()
	if !c.accepting.Load() {
		return
	}
	guarded := func() {
		if c.generation.Load() == generation {
			task()
		}
	}
	select {
	case c.reducer <- guarded:
	case <-c.reducerDone:
	case <-c.ctx.Done():
	}
}

func (c *Client) reducerBarrier(ctx context.Context) error {
	done := make(chan struct{})
	select {
	case c.reducer <- func() { close(done) }:
	case <-c.reducerDone:
		return fmt.Errorf("reducer stopped")
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-done:
		return nil
	case <-c.reducerDone:
		return fmt.Errorf("reducer stopped")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Client) reduceMessage(evt *events.Message, unread bool) {
	// whatsmeow stores Sender/SenderAlt mappings before dispatching the message.
	// Re-resolve any identity that may have been cached before that mapping was
	// known so the live event carries the phone/name immediately.
	c.invalidateContact(evt.Info.Sender, evt.Info.SenderAlt)
	chatID, transportJID, identityErr := c.resolveConversation(evt.Info.Chat.String())
	if identityErr != nil {
		c.log.Error("resolve message conversation", "chat_id", evt.Info.Chat.String(), "error", identityErr)
		return
	}
	if reaction, ok, err := c.reactionFromEvent(c.ctx, evt); ok {
		if err != nil {
			c.log.Error("decode reaction", "chat_id", evt.Info.Chat.String(), "event_message_id", evt.Info.ID, "unavailable_request_id", evt.UnavailableRequestID, "error", err)
			return
		}
		reaction.ChatJID = chatID
		applied, err := c.store.ApplyReactionIfNewer(c.ctx, reaction)
		if err != nil {
			c.log.Error("persist reaction", "error", err)
			return
		}
		if unread && applied {
			c.sink(Event{Kind: "reaction", Reaction: reaction})
		}
		if evt.UnavailableRequestID != "" {
			matched, remaining, completeErr := c.store.CompleteLegacyReactionReplay(c.ctx, chatID, string(evt.Info.ID), string(evt.UnavailableRequestID), evt.Info.IsFromMe)
			if completeErr != nil {
				c.log.Error("complete targeted reaction replay", "chat_id", evt.Info.Chat.String(), "event_message_id", evt.Info.ID, "unavailable_request_id", evt.UnavailableRequestID, "error", completeErr)
			} else if matched {
				c.sink(Event{Kind: "reaction_repair", ChatJID: chatID, RecoveredReactions: 1, RepairComplete: remaining == 0})
			}
		}
		return
	}
	protocol := evt.Message.GetProtocolMessage()
	if protocol == nil {
		protocol = evt.RawMessage.GetProtocolMessage()
	}
	if protocol != nil && protocol.GetType() == waE2E.ProtocolMessage_PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE {
		return
	}
	m := domainMessage(evt, chatID, transportJID)
	if err := c.store.ApplyMessage(c.ctx, m, unread); err != nil {
		c.log.Error("persist message", "error", err)
		return
	}
	if unread {
		c.sink(Event{Kind: "message", Message: m})
		c.emitChat(m.ChatJID)
	}
}

func (c *Client) reactionFromEvent(ctx context.Context, evt *events.Message) (domain.Reaction, bool, error) {
	reactionMessage := evt.Message.GetReactionMessage()
	encrypted := evt.Message.GetEncReactionMessage() != nil
	if reactionMessage == nil && encrypted {
		var err error
		reactionMessage, err = c.wa.DecryptReaction(ctx, evt)
		if err != nil {
			return domain.Reaction{}, true, err
		}
	}
	if reactionMessage == nil {
		return domain.Reaction{}, false, nil
	}
	key := reactionMessage.GetKey()
	if key == nil || key.GetID() == "" {
		return domain.Reaction{}, true, fmt.Errorf("reaction target is missing")
	}
	timestamp := time.UnixMilli(reactionMessage.GetSenderTimestampMS())
	if reactionMessage.GetSenderTimestampMS() <= 0 {
		timestamp = evt.Info.Timestamp
	}
	sender := evt.Info.Sender.ToNonAD()
	if evt.Info.IsFromMe && c.wa != nil {
		if own, ownErr := types.ParseJID(c.OwnID()); ownErr == nil && !own.IsEmpty() {
			sender = own.ToNonAD()
		}
	}
	return domain.Reaction{ChatJID: evt.Info.Chat.String(), MessageID: key.GetID(), SenderJID: sender.String(), Emoji: reactionMessage.GetText(), Timestamp: timestamp, FromMe: evt.Info.IsFromMe}, true, nil
}

func (c *Client) historyAggregateReactions(evt *events.Message) []domain.Reaction {
	if evt.SourceWebMsg == nil || len(evt.SourceWebMsg.GetReactions()) == 0 {
		return nil
	}
	reactions := make([]domain.Reaction, 0, len(evt.SourceWebMsg.GetReactions()))
	for _, raw := range evt.SourceWebMsg.GetReactions() {
		if raw == nil || raw.GetKey() == nil {
			continue
		}
		key := raw.GetKey()
		var sender string
		if key.GetFromMe() {
			sender = c.OwnID()
		} else if evt.Info.Chat.Server == types.GroupServer {
			sender = key.GetParticipant()
		} else {
			sender = evt.Info.Chat.ToNonAD().String()
		}
		jid, err := types.ParseJID(sender)
		if err != nil {
			c.log.Warn("skip history reaction with invalid sender", "message_id", evt.Info.ID, "sender", sender, "error", err)
			continue
		}
		timestamp := time.UnixMilli(raw.GetSenderTimestampMS())
		if raw.GetSenderTimestampMS() <= 0 {
			timestamp = evt.Info.Timestamp
		}
		reactions = append(reactions, domain.Reaction{
			ChatJID:   evt.Info.Chat.String(),
			MessageID: string(evt.Info.ID),
			SenderJID: jid.ToNonAD().String(),
			Emoji:     raw.GetText(),
			Timestamp: timestamp,
			FromMe:    key.GetFromMe(),
		})
	}
	return reactions
}

func domainMessage(evt *events.Message, chatID, transportJID string) domain.Message {
	var imageInfo *domain.Image
	var attachment *domain.Attachment
	var contacts []domain.Contact
	var location *domain.Location
	text := ""
	kind := "text"
	if imageMessage := evt.Message.GetImageMessage(); imageMessage != nil {
		kind = "image"
		text = imageMessage.GetCaption()
		if text == "" {
			text = "📷 Photo"
		}
		imageInfo = &domain.Image{Caption: imageMessage.GetCaption(), MIMEType: imageMessage.GetMimetype(), DirectPath: imageMessage.GetDirectPath(),
			MediaKey: imageMessage.GetMediaKey(), FileSHA256: imageMessage.GetFileSHA256(), FileEncSHA256: imageMessage.GetFileEncSHA256(),
			Width: imageMessage.GetWidth(), Height: imageMessage.GetHeight(), FileSize: imageMessage.GetFileLength()}
	} else if sticker := evt.Message.GetStickerMessage(); sticker != nil {
		kind, text = "sticker", "Sticker"
		imageInfo = &domain.Image{MIMEType: sticker.GetMimetype(), DirectPath: sticker.GetDirectPath(), MediaKey: sticker.GetMediaKey(),
			FileSHA256: sticker.GetFileSHA256(), FileEncSHA256: sticker.GetFileEncSHA256(), Width: sticker.GetWidth(), Height: sticker.GetHeight(),
			FileSize: sticker.GetFileLength(), Animated: sticker.GetIsAnimated() || sticker.GetIsLottie()}
	} else if video := messageVideo(evt.Message); video != nil {
		kind, text = "video", video.GetCaption()
		if text == "" {
			text = "🎬 Video"
		}
		attachment = &domain.Attachment{Caption: video.GetCaption(), MIMEType: video.GetMimetype(), DirectPath: video.GetDirectPath(), MediaKey: video.GetMediaKey(),
			FileSHA256: video.GetFileSHA256(), FileEncSHA256: video.GetFileEncSHA256(), Width: video.GetWidth(), Height: video.GetHeight(),
			FileSize: video.GetFileLength(), DurationSeconds: video.GetSeconds(), Animated: video.GetGifPlayback()}
	} else if audio := evt.Message.GetAudioMessage(); audio != nil {
		kind = "audio"
		if audio.GetPTT() {
			text = "🎤 Voice message"
		} else {
			text = "🎵 Audio"
		}
		attachment = &domain.Attachment{MIMEType: audio.GetMimetype(), DirectPath: audio.GetDirectPath(), MediaKey: audio.GetMediaKey(),
			FileSHA256: audio.GetFileSHA256(), FileEncSHA256: audio.GetFileEncSHA256(), FileSize: audio.GetFileLength(),
			DurationSeconds: audio.GetSeconds(), VoiceNote: audio.GetPTT()}
	} else if document := messageDocument(evt.Message); document != nil {
		kind, text = "document", document.GetCaption()
		if text == "" {
			text = document.GetFileName()
		}
		if text == "" {
			text = document.GetTitle()
		}
		if text == "" {
			text = "📄 Document"
		}
		attachment = &domain.Attachment{Caption: document.GetCaption(), MIMEType: document.GetMimetype(), FileName: document.GetFileName(),
			DirectPath: document.GetDirectPath(), MediaKey: document.GetMediaKey(), FileSHA256: document.GetFileSHA256(),
			FileEncSHA256: document.GetFileEncSHA256(), FileSize: document.GetFileLength()}
	} else if contact := evt.Message.GetContactMessage(); contact != nil {
		kind, text = "contact", contact.GetDisplayName()
		if text == "" {
			text = "Contact"
		}
		contacts = []domain.Contact{{DisplayName: contact.GetDisplayName(), VCard: contact.GetVcard()}}
	} else if contactArray := evt.Message.GetContactsArrayMessage(); contactArray != nil {
		kind, text = "contacts", contactArray.GetDisplayName()
		if text == "" {
			text = fmt.Sprintf("%d contacts", len(contactArray.GetContacts()))
		}
		contacts = make([]domain.Contact, 0, len(contactArray.GetContacts()))
		for _, contact := range contactArray.GetContacts() {
			if contact != nil {
				contacts = append(contacts, domain.Contact{DisplayName: contact.GetDisplayName(), VCard: contact.GetVcard()})
			}
		}
	} else if rawLocation := evt.Message.GetLocationMessage(); rawLocation != nil {
		kind, text = "location", rawLocation.GetName()
		if text == "" {
			text = rawLocation.GetAddress()
		}
		if text == "" {
			text = "📍 Location"
		}
		location = &domain.Location{Latitude: rawLocation.GetDegreesLatitude(), Longitude: rawLocation.GetDegreesLongitude(), Name: rawLocation.GetName(),
			Address: rawLocation.GetAddress(), URL: rawLocation.GetURL(), Live: rawLocation.GetIsLive()}
	} else if liveLocation := evt.Message.GetLiveLocationMessage(); liveLocation != nil {
		kind, text = "location", liveLocation.GetCaption()
		if text == "" {
			text = "📍 Live location"
		}
		location = &domain.Location{Latitude: liveLocation.GetDegreesLatitude(), Longitude: liveLocation.GetDegreesLongitude(), Name: liveLocation.GetCaption(), Live: true}
	} else {
		text = evt.Message.GetConversation()
		if text == "" {
			text = evt.Message.GetExtendedTextMessage().GetText()
		}
		if text == "" {
			kind = evt.Info.Type
			text = "Unsupported message"
		}
	}
	m := domain.Message{ID: string(evt.Info.ID), ChatJID: chatID, TransportJID: transportJID, SenderJID: evt.Info.Sender.ToNonAD().String(), Text: text, Timestamp: evt.Info.Timestamp, FromMe: evt.Info.IsFromMe, Status: domain.StatusDelivered, Kind: kind, ReplyToID: messageContextInfo(evt.Message).GetStanzaID(), Image: imageInfo, Attachment: attachment, Contacts: contacts, Location: location}
	protocol := evt.RawMessage.GetProtocolMessage()
	if protocol == nil {
		protocol = evt.Message.GetProtocolMessage()
	}
	if evt.IsEdit && protocol != nil && protocol.GetKey().GetID() != "" {
		m.ID = protocol.GetKey().GetID()
		m.EditedAt = time.UnixMilli(protocol.GetTimestampMS())
	}
	if protocol != nil && protocol.GetType() == waE2E.ProtocolMessage_REVOKE && protocol.GetKey().GetID() != "" {
		m.ID = protocol.GetKey().GetID()
		m.Text = "Message deleted"
		m.Kind = "revoked"
		m.Revoked = true
		m.EditedAt = evt.Info.Timestamp
	}
	return m
}

func messageContextInfo(message *waE2E.Message) *waE2E.ContextInfo {
	if message == nil {
		return nil
	}
	switch {
	case message.GetExtendedTextMessage() != nil:
		return message.GetExtendedTextMessage().GetContextInfo()
	case message.GetImageMessage() != nil:
		return message.GetImageMessage().GetContextInfo()
	case message.GetStickerMessage() != nil:
		return message.GetStickerMessage().GetContextInfo()
	case messageVideo(message) != nil:
		return messageVideo(message).GetContextInfo()
	case message.GetAudioMessage() != nil:
		return message.GetAudioMessage().GetContextInfo()
	case messageDocument(message) != nil:
		return messageDocument(message).GetContextInfo()
	case message.GetContactMessage() != nil:
		return message.GetContactMessage().GetContextInfo()
	case message.GetContactsArrayMessage() != nil:
		return message.GetContactsArrayMessage().GetContextInfo()
	case message.GetLocationMessage() != nil:
		return message.GetLocationMessage().GetContextInfo()
	case message.GetLiveLocationMessage() != nil:
		return message.GetLiveLocationMessage().GetContextInfo()
	default:
		return nil
	}
}

func messageVideo(message *waE2E.Message) *waE2E.VideoMessage {
	if video := message.GetVideoMessage(); video != nil {
		return video
	}
	return message.GetPtvMessage()
}

func messageDocument(message *waE2E.Message) *waE2E.DocumentMessage {
	if document := message.GetDocumentMessage(); document != nil {
		return document
	}
	if wrapped := message.GetDocumentWithCaptionMessage(); wrapped != nil {
		return wrapped.GetMessage().GetDocumentMessage()
	}
	return nil
}

func (c *Client) emitChat(chatID string) {
	chat, err := c.store.Chat(c.ctx, chatID)
	if err == nil {
		c.sink(Event{Kind: "chat", Chat: chat})
	}
}

func (c *Client) reduceArchive(evt *events.Archive) {
	chatID, _, err := c.resolveConversation(evt.JID.String())
	if err != nil {
		c.log.Error("resolve archived conversation", "chat_id", evt.JID.String(), "error", err)
		return
	}
	archived := evt.Action.GetArchived()
	if err = c.store.UpsertChatMetadata(c.ctx, chatID, "", &archived); err != nil {
		c.log.Error("persist archive state", "chat_id", chatID, "error", err)
		return
	}
	c.emitChat(chatID)
}

func (c *Client) reduceReceipt(evt *events.Receipt) {
	chatID, _, err := c.resolveConversation(evt.Chat.String())
	if err != nil {
		c.log.Error("resolve receipt conversation", "chat_id", evt.Chat.String(), "error", err)
		return
	}
	status := domain.StatusDelivered
	if evt.Type == types.ReceiptTypeRead || evt.Type == types.ReceiptTypeReadSelf {
		status = domain.StatusRead
	}
	for _, id := range evt.MessageIDs {
		_ = c.store.UpdateReceipt(c.ctx, chatID, string(id), status)
		c.sink(Event{Kind: "receipt", ChatJID: chatID, MessageID: string(id), Status: status})
	}
}

func (c *Client) reduceHistory(evt *events.HistorySync) {
	var chats, messages uint64
	pushNames := make(map[types.JID]string)
	isReactionRepair := evt.Data.GetSyncType() == waHistorySync.HistorySync_ON_DEMAND
	for _, conversation := range evt.Data.GetConversations() {
		rawChatID := conversation.GetID()
		chatID, transportJID, identityErr := c.resolveConversation(rawChatID)
		if identityErr != nil {
			c.log.Error("resolve history conversation", "chat_id", rawChatID, "error", identityErr)
			continue
		}
		if err := c.store.UpsertChatMetadata(c.ctx, chatID, conversation.GetName(), conversation.Archived); err != nil {
			c.log.Error("persist history chat metadata", "chat_id", chatID, "error", err)
		}
		chats++
		jid, err := types.ParseJID(rawChatID)
		if err != nil {
			continue
		}
		batch := make([]domain.Message, 0, len(conversation.GetMessages()))
		reactions := make([]domain.Reaction, 0)
		for _, raw := range conversation.GetMessages() {
			parsed, err := c.wa.ParseWebMessage(jid, raw.GetMessage())
			if err != nil {
				continue
			}
			if parsed.Info.PushName != "" && parsed.Info.PushName != "-" && parsed.Info.PushName != "username" && !parsed.Info.Sender.IsEmpty() {
				pushNames[parsed.Info.Sender.ToNonAD()] = parsed.Info.PushName
			}
			if reaction, ok, reactionErr := c.reactionFromEvent(c.ctx, parsed); ok {
				if reactionErr == nil {
					reaction.ChatJID = chatID
					reactions = append(reactions, reaction)
				} else {
					c.log.Error("decode history reaction", "chat_id", chatID, "event_message_id", parsed.Info.ID, "error", reactionErr)
				}
				continue
			}
			aggregates := c.historyAggregateReactions(parsed)
			for i := range aggregates {
				aggregates[i].ChatJID = chatID
			}
			reactions = append(reactions, aggregates...)
			batch = append(batch, domainMessage(parsed, chatID, transportJID))
		}
		if err = c.store.ApplyMessages(c.ctx, batch, false); err != nil {
			c.log.Error("persist history batch", "chat_id", chatID, "count", len(batch), "error", err)
			continue
		}
		messages += uint64(len(batch))
		recovered := len(reactions)
		if err = c.store.ApplyReactions(c.ctx, reactions); err != nil {
			c.log.Error("persist history reactions", "chat_id", chatID, "count", len(reactions), "error", err)
			recovered = 0
		}
		if isReactionRepair {
			marked, complete, repairErr := c.store.CompleteReactionRepair(c.ctx, chatID, recovered)
			if repairErr != nil {
				c.log.Error("update reaction repair", "chat_id", chatID, "error", repairErr)
			} else if marked {
				c.sink(Event{Kind: "reaction_repair", ChatJID: chatID, RecoveredReactions: uint32(recovered), RepairComplete: complete})
			}
		}
	}
	for jid, pushName := range pushNames {
		if _, _, err := c.wa.Store.Contacts.PutPushName(c.ctx, jid, pushName); err != nil {
			c.log.Warn("persist history sender push name", "jid", jid, "error", err)
		}
	}
	if len(pushNames) > 0 {
		c.clearContactCache()
	}
	c.sink(Event{Kind: "sync", ChatsProcessed: chats, MessagesProcessed: messages, Complete: evt.Data.GetProgress() >= 100})
}
