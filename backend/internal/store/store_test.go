package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rust-meow/rust-meow/backend/internal/domain"
)

func TestOpenRestrictsDatabaseAndSQLiteSidecarModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows permissions are enforced by the user-profile ACL")
	}
	path := filepath.Join(t.TempDir(), "client.db")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		info, statErr := os.Stat(candidate)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			t.Fatal(statErr)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("mode for %s = %04o, want 0600", candidate, got)
		}
	}
}

func TestEmptyLegacyCacheRebuildsAsConversationSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "client.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `CREATE TABLE schema_version(version INTEGER NOT NULL);INSERT INTO schema_version VALUES(1);
CREATE TABLE chats(jid TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_message_id TEXT NOT NULL DEFAULT '',last_message_text TEXT NOT NULL DEFAULT '',last_message_at INTEGER NOT NULL DEFAULT 0,unread_count INTEGER NOT NULL DEFAULT 0,muted_until INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages(id TEXT NOT NULL,chat_jid TEXT NOT NULL,sender_jid TEXT NOT NULL DEFAULT '',text TEXT NOT NULL DEFAULT '',timestamp INTEGER NOT NULL,from_me INTEGER NOT NULL DEFAULT 0,status INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL DEFAULT 'text',reply_to_id TEXT NOT NULL DEFAULT '',edited_at INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_jid,id),FOREIGN KEY(chat_jid) REFERENCES chats(jid) ON DELETE CASCADE);`)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	m := domain.Message{ID: "m", ChatJID: "c@g.us", SenderJID: "u@s.whatsapp.net", Timestamp: time.Now()}
	if err = s.ApplyMessage(ctx, m, true); err != nil {
		t.Fatal(err)
	}
	var version int
	if err = s.db.QueryRowContext(ctx, `SELECT version FROM schema_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != supportedSchemaVersion {
		t.Fatalf("version=%d", version)
	}
	var indexCount int
	if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='messages_unread_cursor_idx'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if indexCount != 1 {
		t.Fatal("missing unread cursor index")
	}
}

func TestRichMessageContentRoundTrips(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.UnixMilli(1234)
	messages := []domain.Message{
		{ID: "sticker", ChatJID: "123@g.us", Timestamp: now, Kind: "sticker", Text: "Sticker", Image: &domain.Image{
			MIMEType: "image/webp", DirectPath: "/sticker", MediaKey: []byte{1}, FileSHA256: []byte{2}, FileEncSHA256: []byte{3}, Width: 512, Height: 512, FileSize: 99, Animated: true,
		}},
		{ID: "audio", ChatJID: "123@g.us", Timestamp: now.Add(time.Millisecond), Kind: "audio", Text: "Voice message", Attachment: &domain.Attachment{
			MIMEType: "audio/ogg", DirectPath: "/audio", MediaKey: []byte{4}, FileSHA256: []byte{5}, FileEncSHA256: []byte{6}, FileSize: 100, DurationSeconds: 7, VoiceNote: true,
		}},
		{ID: "contacts", ChatJID: "123@g.us", Timestamp: now.Add(2 * time.Millisecond), Kind: "contacts", Text: "Friends", Contacts: []domain.Contact{
			{DisplayName: "Alice", VCard: "BEGIN:VCARD\nFN:Alice\nEND:VCARD"}, {DisplayName: "Bob", VCard: "BEGIN:VCARD\nFN:Bob\nEND:VCARD"},
		}},
		{ID: "location", ChatJID: "123@g.us", Timestamp: now.Add(3 * time.Millisecond), Kind: "location", Text: "Office", Location: &domain.Location{
			Latitude: 12.9716, Longitude: 77.5946, Name: "Office", Address: "Bengaluru", URL: "https://maps.example/office", Live: true,
		}},
		{ID: "link", ChatJID: "123@g.us", Timestamp: now.Add(4 * time.Millisecond), Kind: "text", Text: "https://example.com/meow", LinkPreview: &domain.LinkPreview{
			URL: "https://example.com/meow", Title: "Meow", Description: "A link preview", JPEGThumbnail: []byte{7, 8, 9}, ThumbnailWidth: 320, ThumbnailHeight: 180,
		}},
	}
	if err = s.ApplyMessages(ctx, messages, false); err != nil {
		t.Fatal(err)
	}
	page, err := s.Messages(ctx, "123@g.us", "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != len(messages) {
		t.Fatalf("messages=%+v", page.Items)
	}
	byID := make(map[string]domain.Message, len(page.Items))
	for _, message := range page.Items {
		byID[message.ID] = message
	}
	if got := byID["sticker"].Image; got == nil || got.MIMEType != "image/webp" || !got.Animated || got.Width != 512 || string(got.MediaKey) != "\x01" {
		t.Fatalf("sticker=%+v", got)
	}
	if got := byID["audio"].Attachment; got == nil || !got.VoiceNote || got.DurationSeconds != 7 || got.DirectPath != "/audio" {
		t.Fatalf("audio=%+v", got)
	}
	if got := byID["contacts"].Contacts; len(got) != 2 || got[0].DisplayName != "Alice" || got[1].DisplayName != "Bob" {
		t.Fatalf("contacts=%+v", got)
	}
	if got := byID["location"].Location; got == nil || got.Latitude != 12.9716 || got.Longitude != 77.5946 || !got.Live {
		t.Fatalf("location=%+v", got)
	}
	if got := byID["link"].LinkPreview; got == nil || got.Title != "Meow" || got.ThumbnailWidth != 320 || string(got.JPEGThumbnail) != "\x07\x08\x09" {
		t.Fatalf("link preview=%+v", got)
	}
}

func TestMessageSearchIndexesUpdatesAndStructuredMetadata(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "search.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.UnixMilli(10_000)
	messages := []domain.Message{
		{ID: "meeting", ChatJID: "team@g.us", Text: "Quarterly meeting notes", Kind: "text", Timestamp: now},
		{ID: "document", ChatJID: "team@g.us", Text: "Document", Kind: "document", Timestamp: now.Add(time.Millisecond), Attachment: &domain.Attachment{FileName: "roadmap-final.pdf"}},
		{ID: "location", ChatJID: "team@g.us", Text: "Location", Kind: "location", Timestamp: now.Add(2 * time.Millisecond), Location: &domain.Location{Name: "Cubbon Park", Address: "Bengaluru"}},
	}
	if err = s.ApplyMessages(ctx, messages, false); err != nil {
		t.Fatal(err)
	}
	for query, wantID := range map[string]string{"meting": "meeting", "roadmp": "document", "cubbon": "location"} {
		hits, searchErr := s.SearchMessages(ctx, query, 20)
		if searchErr != nil {
			t.Fatal(searchErr)
		}
		if len(hits) == 0 || hits[0].MessageID != wantID {
			t.Fatalf("query=%q hits=%+v", query, hits)
		}
	}
	updated := messages[0]
	updated.Text = "Renamed planning session"
	updated.EditedAt = now.Add(time.Second)
	if err = s.ApplyMessage(ctx, updated, false); err != nil {
		t.Fatal(err)
	}
	if hits, searchErr := s.SearchMessages(ctx, "quarterly", 20); searchErr != nil || len(hits) != 0 {
		t.Fatalf("stale search hit survived update: hits=%+v err=%v", hits, searchErr)
	}
	if hits, searchErr := s.SearchMessages(ctx, "planning", 20); searchErr != nil || len(hits) != 1 || hits[0].MessageID != "meeting" {
		t.Fatalf("updated search missing: hits=%+v err=%v", hits, searchErr)
	}
	if err = s.ClearAccountData(ctx); err != nil {
		t.Fatal(err)
	}
	if hits, searchErr := s.SearchMessages(ctx, "planning", 20); searchErr != nil || len(hits) != 0 {
		t.Fatalf("search hit survived deletion: hits=%+v err=%v", hits, searchErr)
	}
}

func TestMessagesAroundReturnsCenteredOrderedWindow(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "around.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	messages := make([]domain.Message, 100)
	for i := range messages {
		messages[i] = domain.Message{ID: fmt.Sprintf("%03d", i), ChatJID: "team@g.us", Text: fmt.Sprintf("message %d", i), Kind: "text", Timestamp: time.UnixMilli(int64(i + 1))}
	}
	if err = s.ApplyMessages(ctx, messages, false); err != nil {
		t.Fatal(err)
	}
	window, err := s.MessagesAround(ctx, "team@g.us", "050", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(window.Items) != 51 || window.Items[0].ID != "025" || window.Items[25].ID != "050" || window.Items[50].ID != "075" {
		t.Fatalf("window=%+v", window.Items)
	}
	if !window.HasOlder || !window.HasNewer || window.AnchorID != "050" {
		t.Fatalf("metadata=%+v", window)
	}
}

func TestV8CacheMigratesInPlaceToRichContentSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "client.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyMessage(ctx, domain.Message{ID: "existing", ChatJID: "123@g.us", Kind: "text", Text: "keep me", Timestamp: time.UnixMilli(1234)}, false); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `DROP TRIGGER message_search_ai; DROP TRIGGER message_search_ad; DROP TRIGGER message_search_au; DROP TABLE message_search`); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"image_animated", "media_file_name", "media_duration", "media_voice", "contacts_json", "location_lat", "location_lng", "location_name", "location_address", "location_url", "location_live", "link_preview_url", "link_preview_title", "link_preview_description", "link_preview_thumbnail", "link_preview_width", "link_preview_height"} {
		if _, err = db.ExecContext(ctx, `ALTER TABLE messages DROP COLUMN `+column); err != nil {
			t.Fatalf("drop %s: %v", column, err)
		}
	}
	if _, err = db.ExecContext(ctx, `UPDATE schema_version SET version=8`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	message, err := s.Message(ctx, "123@g.us", "existing")
	if err != nil || message.Text != "keep me" {
		t.Fatalf("message=%+v err=%v", message, err)
	}
	hits, err := s.SearchMessages(ctx, "keep", 20)
	if err != nil || len(hits) != 1 || hits[0].MessageID != "existing" {
		t.Fatalf("migrated search index was not backfilled: hits=%+v err=%v", hits, err)
	}
	var version int
	if err = s.db.QueryRowContext(ctx, `SELECT version FROM schema_version`).Scan(&version); err != nil || version != supportedSchemaVersion {
		t.Fatalf("version=%d err=%v", version, err)
	}
}

func TestCurrentSchemaDoesNotRepeatReactionReplayMigration(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "client.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	chatID, _, err := s.EnsureConversation(ctx, "123@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(ctx, `INSERT INTO messages(id,chat_jid,transport_jid,timestamp,kind,unread) VALUES('migration-sentinel',?,?,100,'reaction',1)`, chatID, "123@g.us"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(ctx, `UPDATE chats SET last_message_id='summary-sentinel',last_message_text='unchanged',last_message_at=999,unread_count=42 WHERE jid=?`, chatID); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var version, messageCount, replayCount int
	if err = s.db.QueryRowContext(ctx, `SELECT version FROM schema_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM messages WHERE id='migration-sentinel' AND kind='reaction'`).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM legacy_reaction_replays WHERE event_message_id='migration-sentinel'`).Scan(&replayCount); err != nil {
		t.Fatal(err)
	}
	var lastMessageID, lastMessageText string
	var lastMessageAt int64
	var unreadCount int
	if err = s.db.QueryRowContext(ctx, `SELECT last_message_id,last_message_text,last_message_at,unread_count FROM chats WHERE jid=?`, chatID).Scan(&lastMessageID, &lastMessageText, &lastMessageAt, &unreadCount); err != nil {
		t.Fatal(err)
	}
	if version != supportedSchemaVersion || messageCount != 1 || replayCount != 0 || lastMessageID != "summary-sentinel" || lastMessageText != "unchanged" || lastMessageAt != 999 || unreadCount != 42 {
		t.Fatalf("version=%d messages=%d replays=%d summary=(%q,%q,%d,%d)", version, messageCount, replayCount, lastMessageID, lastMessageText, lastMessageAt, unreadCount)
	}
}

func TestNonEmptyLegacyCacheRequiresExplicitReset(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "client.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(7);
CREATE TABLE chats(jid TEXT PRIMARY KEY); INSERT INTO chats VALUES('old@s.whatsapp.net')`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = Open(ctx, path); err == nil || !strings.Contains(err.Error(), "client cache reset required") {
		t.Fatalf("err=%v", err)
	}
}

func TestReactionPseudoMessageCannotBeReinsertedOrRendered(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.ApplyMessage(ctx, domain.Message{ID: "reaction", ChatJID: "g@g.us", Kind: "reaction", Timestamp: time.Now()}, true); err != nil {
		t.Fatal(err)
	}
	page, err := s.Messages(ctx, "g@g.us", "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("rendered=%+v", page.Items)
	}
}

func TestRejectsNewerSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "client.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE schema_version(version INTEGER NOT NULL);INSERT INTO schema_version VALUES(99)`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if _, err = Open(ctx, path); err == nil || !strings.Contains(err.Error(), "newer than supported") {
		t.Fatalf("err=%v", err)
	}
}

func TestApplyMessagesBatchesLargeConversation(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	const count = 2500
	messages := make([]domain.Message, count)
	for i := range messages {
		messages[i] = domain.Message{ID: fmt.Sprintf("%08d", i), ChatJID: "large@g.us", SenderJID: "u@s.whatsapp.net", Text: fmt.Sprintf("message %d", i), Timestamp: time.Unix(int64(i+1), 0), Status: domain.StatusDelivered, Kind: "text"}
	}
	started := time.Now()
	if err = s.ApplyMessages(ctx, messages, false); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("batch persistence took %s", elapsed)
	}
	if err = s.ApplyMessages(ctx, messages, false); err != nil {
		t.Fatal(err)
	}
	var stored int
	chatID, err := s.ResolveChat(ctx, "large@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM messages WHERE chat_jid=?`, chatID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != count {
		t.Fatalf("stored=%d", stored)
	}
	chat, err := s.Chat(ctx, "large@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if chat.LastMessageID != "00002499" || chat.UnreadCount != 0 {
		t.Fatalf("chat=%+v", chat)
	}
}

func TestClearAccountDataRemovesAllPriorAccountRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "client.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pending := domain.Message{ID: "wa-id", ChatJID: "old@g.us", SenderJID: "me@s.whatsapp.net", Text: "private", Timestamp: time.Now(), FromMe: true, Status: domain.StatusPending, Kind: "text"}
	if _, _, err = s.ReserveOutgoingMessage(ctx, "request-id", pending); err != nil {
		t.Fatal(err)
	}
	ftsMarker := []byte("qzxp")
	sentinel := "logout-client-sentinel-" + strings.Repeat("private-message-", 64) + string(ftsMarker)
	incoming := domain.Message{ID: "incoming", ChatJID: "old@g.us", SenderJID: "other@s.whatsapp.net", Text: sentinel, Timestamp: time.Now().Add(time.Second), Kind: "text"}
	if err = s.ApplyMessage(ctx, incoming, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.ReserveOutgoingReaction(ctx, "reaction-id", domain.Reaction{ChatJID: incoming.ChatJID, MessageID: incoming.ID, SenderJID: pending.SenderJID, Emoji: "👍", FromMe: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(ctx, `INSERT INTO sync_state(key,value) VALUES('checkpoint','old-account')`); err != nil {
		t.Fatal(err)
	}
	if !sqliteFilesContain(t, path, []byte(sentinel)) {
		t.Fatal("sentinel was not persisted before account clear")
	}
	shadowBlock := ftsShadowBlockContaining(t, s.db, ftsMarker[:3])
	if len(shadowBlock) == 0 {
		t.Fatal("unique trigram was not persisted in an FTS shadow block before account clear")
	}
	if err = s.ClearAccountData(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"legacy_reaction_replays", "reaction_repair_jobs", "outgoing_reactions", "outgoing_requests", "reactions", "messages", "chats", "sync_state"} {
		var count int
		if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM `+table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s retained %d rows", table, count)
		}
	}
	if sqliteFilesContain(t, path, []byte(sentinel)) {
		t.Fatal("account clear left recoverable sentinel bytes in SQLite files")
	}
	if sqliteFilesContain(t, path, shadowBlock) {
		t.Fatal("account clear left the pre-clear FTS shadow block in SQLite files")
	}
	for _, marker := range [][]byte{ftsMarker[:3], ftsMarker[1:]} {
		if sqliteFilesContain(t, path, marker) {
			t.Fatalf("account clear left recoverable FTS trigram %q", marker)
		}
	}
	for table, where := range map[string]string{
		"message_search_idx":     "",
		"message_search_docsize": "",
		"message_search_data":    " WHERE id NOT IN (1,10)",
	} {
		var count int
		if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM `+table+where).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s retained %d account index rows", table, count)
		}
	}
	var secureDelete, ftsSecureDelete, freePages int
	if err = s.db.QueryRowContext(ctx, `PRAGMA secure_delete`).Scan(&secureDelete); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(ctx, `SELECT v FROM message_search_config WHERE k='secure-delete'`).Scan(&ftsSecureDelete); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&freePages); err != nil {
		t.Fatal(err)
	}
	if secureDelete != 1 || ftsSecureDelete != 1 || freePages != 0 {
		t.Fatalf("secure_delete=%d fts_secure_delete=%d freelist_count=%d", secureDelete, ftsSecureDelete, freePages)
	}
	if info, statErr := os.Stat(path + "-wal"); statErr == nil && info.Size() != 0 {
		t.Fatalf("WAL retained %d bytes after truncation", info.Size())
	} else if statErr != nil && !os.IsNotExist(statErr) {
		t.Fatal(statErr)
	}

	// The same open Store remains usable for the next account.
	if err = s.ApplyMessage(ctx, domain.Message{ID: "new", ChatJID: "new@g.us", SenderJID: "new@s.whatsapp.net", Text: "fresh", Timestamp: time.Now(), Kind: "text"}, false); err != nil {
		t.Fatal(err)
	}
	if count, countErr := s.ChatCount(ctx); countErr != nil || count != 1 {
		t.Fatalf("post-clear chat count=%d err=%v", count, countErr)
	}
	if hits, searchErr := s.SearchMessages(ctx, "fresh", 10); searchErr != nil || len(hits) != 1 || hits[0].MessageID != "new" {
		t.Fatalf("post-clear search hits=%+v err=%v", hits, searchErr)
	}
}

func sqliteFilesContain(t *testing.T, path string, sentinel []byte) bool {
	t.Helper()
	for _, candidate := range []string{path, path + "-wal", path + "-shm", path + "-journal"} {
		data, err := os.ReadFile(candidate)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, sentinel) {
			return true
		}
	}
	return false
}

func ftsShadowBlockContaining(t *testing.T, db *sql.DB, marker []byte) []byte {
	t.Helper()
	rows, err := db.Query(`SELECT block FROM message_search_data WHERE id NOT IN (1,10)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var block []byte
		if err = rows.Scan(&block); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(block, marker) {
			return append([]byte(nil), block...)
		}
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return nil
}

func TestReactionUpsertRemovalAndMessageHydration(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	message := domain.Message{ID: "m", ChatJID: "group@g.us", SenderJID: "author@s.whatsapp.net", Text: "hello", Timestamp: time.Unix(1, 0), Kind: "text"}
	if err = s.ApplyMessage(ctx, message, false); err != nil {
		t.Fatal(err)
	}
	reaction := domain.Reaction{ChatJID: message.ChatJID, MessageID: message.ID, SenderJID: "a@s.whatsapp.net", Emoji: "👍", Timestamp: time.Unix(2, 0)}
	if err = s.ApplyReaction(ctx, reaction); err != nil {
		t.Fatal(err)
	}
	stale := reaction
	stale.Emoji = "👎"
	stale.Timestamp = time.Unix(1, 0)
	if applied, applyErr := s.ApplyReactionIfNewer(ctx, stale); applyErr != nil {
		t.Fatal(applyErr)
	} else if applied {
		t.Fatal("stale reaction reported as applied")
	}
	if err = s.ApplyReaction(ctx, stale); err != nil {
		t.Fatal(err)
	}
	page, err := s.Messages(ctx, message.ChatJID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || len(page.Items[0].Reactions) != 1 || page.Items[0].Reactions[0].Emoji != "👍" {
		t.Fatalf("page=%+v", page)
	}
	reaction.Emoji = ""
	reaction.Timestamp = time.Unix(3, 0)
	if err = s.ApplyReaction(ctx, reaction); err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyReaction(ctx, stale); err != nil {
		t.Fatal(err)
	}
	page, err = s.Messages(ctx, message.ChatJID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items[0].Reactions) != 0 {
		t.Fatalf("reaction not removed: %+v", page.Items[0].Reactions)
	}
}

func TestOutgoingReactionReservationIsPayloadBoundAndReplayable(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	reaction := domain.Reaction{ChatJID: "group@g.us", MessageID: "m", SenderJID: "me@s.whatsapp.net", Emoji: "👍", FromMe: true}
	reserved, completed, err := s.ReserveOutgoingReaction(ctx, "action", reaction)
	if err != nil || completed || !reserved.Timestamp.IsZero() {
		t.Fatalf("reserved=%+v completed=%v err=%v", reserved, completed, err)
	}
	different := reaction
	different.Emoji = "👎"
	if _, _, err = s.ReserveOutgoingReaction(ctx, "action", different); err == nil {
		t.Fatal("reservation accepted a different payload")
	}
	reaction.Timestamp = time.UnixMilli(1234)
	if err = s.CompleteOutgoingReaction(ctx, "action", reaction); err != nil {
		t.Fatal(err)
	}
	replayed, completed, err := s.ReserveOutgoingReaction(ctx, "action", reaction)
	if err != nil || !completed || !replayed.Timestamp.Equal(reaction.Timestamp) {
		t.Fatalf("replayed=%+v completed=%v err=%v", replayed, completed, err)
	}
}

func TestApplyReactionsBatchKeepsOneReactionPerSender(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	message := domain.Message{ID: "m", ChatJID: "group@g.us", Timestamp: time.Now()}
	if err = s.ApplyMessage(ctx, message, false); err != nil {
		t.Fatal(err)
	}
	reactions := []domain.Reaction{{ChatJID: message.ChatJID, MessageID: message.ID, SenderJID: "a@s.whatsapp.net", Emoji: "👍", Timestamp: time.Unix(1, 0)}, {ChatJID: message.ChatJID, MessageID: message.ID, SenderJID: "a@s.whatsapp.net", Emoji: "❤️", Timestamp: time.Unix(2, 0)}, {ChatJID: message.ChatJID, MessageID: message.ID, SenderJID: "b@s.whatsapp.net", Emoji: "😂", Timestamp: time.Unix(2, 0)}}
	if err = s.ApplyReactions(ctx, reactions); err != nil {
		t.Fatal(err)
	}
	page, err := s.Messages(ctx, message.ChatJID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(page.Items[0].Reactions); got != 2 {
		t.Fatalf("reactions=%d", got)
	}
}

func TestSelfReactionAliasesCollapseWithoutStaleOverwrite(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pn := domain.Reaction{ChatJID: "g@g.us", MessageID: "m", SenderJID: "15551234@s.whatsapp.net", Emoji: "👍", Timestamp: time.UnixMilli(2000), FromMe: true}
	if applied, applyErr := s.ApplyReactionIfNewer(ctx, pn); applyErr != nil || !applied {
		t.Fatalf("PN applied=%v err=%v", applied, applyErr)
	}
	lid := pn
	lid.SenderJID = "12345@lid"
	lid.Emoji = "❤️"
	lid.Timestamp = time.UnixMilli(3000)
	if applied, applyErr := s.ApplyReactionIfNewer(ctx, lid); applyErr != nil || !applied {
		t.Fatalf("LID applied=%v err=%v", applied, applyErr)
	}
	stale := pn
	stale.Emoji = "😂"
	stale.Timestamp = time.UnixMilli(1000)
	if applied, applyErr := s.ApplyReactionIfNewer(ctx, stale); applyErr != nil || applied {
		t.Fatalf("stale applied=%v err=%v", applied, applyErr)
	}
	var count int
	var sender, emoji string
	var timestamp int64
	chatID, err := s.ResolveChat(ctx, lid.ChatJID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(ctx, `SELECT count(*),sender_jid,emoji,timestamp FROM reactions WHERE chat_jid=? AND message_id=? AND from_me=1`, chatID, lid.MessageID).Scan(&count, &sender, &emoji, &timestamp); err != nil {
		t.Fatal(err)
	}
	if count != 1 || sender != lid.SenderJID || emoji != lid.Emoji || timestamp != lid.Timestamp.UnixMilli() {
		t.Fatalf("count=%d sender=%q emoji=%q timestamp=%d", count, sender, emoji, timestamp)
	}
}

func TestApplyMessageIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	m := domain.Message{ID: "m1", ChatJID: "123@s.whatsapp.net", Text: "hello", Timestamp: time.Unix(10, 0), Status: domain.StatusDelivered}
	if err := s.ApplyMessage(ctx, m, true); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyMessage(ctx, m, true); err != nil {
		t.Fatal(err)
	}
	page, err := s.Chats(ctx, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if got := page.Items[0].UnreadCount; got != 1 {
		t.Fatalf("unread=%d want 1", got)
	}
}

func TestEnsureConversationMergesPNAndLIDWithoutLosingTransport(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pn := "919999890760@s.whatsapp.net"
	lid := "207236550930675@lid"
	pnChat, _, err := s.EnsureConversation(ctx, pn)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyMessage(ctx, domain.Message{ID: "old", ChatJID: pnChat, TransportJID: pn, Text: "old", Kind: "text", Timestamp: time.Unix(1, 0)}, false); err != nil {
		t.Fatal(err)
	}
	lidChat, _, err := s.EnsureConversation(ctx, lid)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyMessage(ctx, domain.Message{ID: "new", ChatJID: lidChat, TransportJID: lid, Text: "new", Kind: "text", Timestamp: time.Unix(2, 0)}, true); err != nil {
		t.Fatal(err)
	}
	winner, merges, err := s.EnsureConversation(ctx, lid, pn)
	if err != nil {
		t.Fatal(err)
	}
	if winner != lidChat || len(merges) != 1 || merges[0].OldChatID != pnChat {
		t.Fatalf("winner=%q merges=%+v", winner, merges)
	}
	if resolved, resolveErr := s.ResolveChat(ctx, pnChat); resolveErr != nil || resolved != winner {
		t.Fatalf("redirect=%q err=%v", resolved, resolveErr)
	}
	page, err := s.Messages(ctx, pn, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Items[0].TransportJID != lid || page.Items[1].TransportJID != pn {
		t.Fatalf("messages=%+v", page.Items)
	}
	count, err := s.ChatCount(ctx)
	if err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

func TestEnsureConversationKeepsNewestSelfReactionPerMessage(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pn := "919999890760@s.whatsapp.net"
	lid := "207236550930675@lid"
	pnChat, _, err := s.EnsureConversation(ctx, pn)
	if err != nil {
		t.Fatal(err)
	}
	lidChat, _, err := s.EnsureConversation(ctx, lid)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range []domain.Message{
		{ID: "first", ChatJID: pnChat, TransportJID: pn, Timestamp: time.UnixMilli(1)},
		{ID: "second", ChatJID: pnChat, TransportJID: pn, Timestamp: time.UnixMilli(2)},
		{ID: "first", ChatJID: lidChat, TransportJID: lid, Timestamp: time.UnixMilli(1)},
		{ID: "second", ChatJID: lidChat, TransportJID: lid, Timestamp: time.UnixMilli(2)},
	} {
		if err = s.ApplyMessage(ctx, message, false); err != nil {
			t.Fatal(err)
		}
	}
	for _, reaction := range []domain.Reaction{
		{ChatJID: pnChat, MessageID: "first", SenderJID: pn, Emoji: "old-first", Timestamp: time.UnixMilli(1000), FromMe: true},
		{ChatJID: lidChat, MessageID: "first", SenderJID: lid, Emoji: "new-first", Timestamp: time.UnixMilli(3000), FromMe: true},
		{ChatJID: pnChat, MessageID: "second", SenderJID: pn, Emoji: "new-second", Timestamp: time.UnixMilli(4000), FromMe: true},
		{ChatJID: lidChat, MessageID: "second", SenderJID: lid, Emoji: "old-second", Timestamp: time.UnixMilli(2000), FromMe: true},
	} {
		if err = s.ApplyReaction(ctx, reaction); err != nil {
			t.Fatal(err)
		}
	}
	winner, _, err := s.EnsureConversation(ctx, lid, pn)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT message_id,sender_jid,emoji,timestamp FROM reactions WHERE chat_jid=? AND from_me=1 ORDER BY message_id`, winner)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type persistedReaction struct {
		messageID string
		senderJID string
		emoji     string
		timestamp int64
	}
	var got []persistedReaction
	for rows.Next() {
		var reaction persistedReaction
		if err = rows.Scan(&reaction.messageID, &reaction.senderJID, &reaction.emoji, &reaction.timestamp); err != nil {
			t.Fatal(err)
		}
		got = append(got, reaction)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []persistedReaction{
		{messageID: "first", senderJID: lid, emoji: "new-first", timestamp: 3000},
		{messageID: "second", senderJID: pn, emoji: "new-second", timestamp: 4000},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("reactions=%+v want=%+v", got, want)
	}
}

func TestConversationAddressesPrefersLIDAndRetainsPNFallback(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "addresses.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	chatID, _, err := s.EnsureConversation(ctx, "919999890760@s.whatsapp.net", "200201394507780@lid")
	if err != nil {
		t.Fatal(err)
	}
	addresses, err := s.ConversationAddresses(ctx, chatID)
	if err != nil {
		t.Fatal(err)
	}
	if len(addresses) != 2 || addresses[0] != "200201394507780@lid" || addresses[1] != "919999890760@s.whatsapp.net" {
		t.Fatalf("addresses=%v", addresses)
	}
}

func TestConversationAddressesForChatsBatchesPage(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "addresses.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	chatIDs := make([]string, 100)
	for i := range chatIDs {
		pn := fmt.Sprintf("1555000%04d@s.whatsapp.net", i)
		lid := fmt.Sprintf("2002000%04d@lid", i)
		chatIDs[i], _, err = s.EnsureConversation(ctx, pn, lid)
		if err != nil {
			t.Fatal(err)
		}
	}
	addresses, err := s.ConversationAddressesForChats(ctx, chatIDs)
	if err != nil {
		t.Fatal(err)
	}
	if len(addresses) != len(chatIDs) {
		t.Fatalf("chats=%d want=%d", len(addresses), len(chatIDs))
	}
	for i, chatID := range chatIDs {
		want := []string{fmt.Sprintf("2002000%04d@lid", i), fmt.Sprintf("1555000%04d@s.whatsapp.net", i)}
		if !slices.Equal(addresses[chatID], want) {
			t.Fatalf("chat %d addresses=%v want=%v", i, addresses[chatID], want)
		}
	}
}

func TestPhoneReassignmentDoesNotMergeDifferentLIDs(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pn := "15550001111@s.whatsapp.net"
	oldLID := "111@lid"
	newLID := "222@lid"
	oldChat, _, err := s.EnsureConversation(ctx, oldLID, pn)
	if err != nil {
		t.Fatal(err)
	}
	newChat, _, err := s.EnsureConversation(ctx, newLID)
	if err != nil {
		t.Fatal(err)
	}
	winner, merges, err := s.EnsureConversation(ctx, newLID, pn)
	if err != nil {
		t.Fatal(err)
	}
	if winner != newChat || len(merges) != 0 {
		t.Fatalf("winner=%q merges=%+v", winner, merges)
	}
	if resolved, _ := s.ResolveChat(ctx, pn); resolved != newChat {
		t.Fatalf("PN resolved to %q", resolved)
	}
	if resolved, _ := s.ResolveChat(ctx, oldLID); resolved != oldChat {
		t.Fatalf("old LID resolved to %q", resolved)
	}
	if count, countErr := s.ChatCount(ctx); countErr != nil || count != 2 {
		t.Fatalf("count=%d err=%v", count, countErr)
	}
}

func TestImageMetadataAndCachePathRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	message := domain.Message{
		ID: "image-1", ChatJID: "c@g.us", SenderJID: "u@s.whatsapp.net",
		Text: "caption", Timestamp: time.Unix(10, 0), Kind: "image",
		Image: &domain.Image{
			Caption: "caption", MIMEType: "image/jpeg", DirectPath: "/remote",
			MediaKey: []byte{1, 2}, FileSHA256: []byte{3}, FileEncSHA256: []byte{4},
			Width: 640, Height: 480, FileSize: 1234,
		},
	}
	if err = s.ApplyMessage(ctx, message, false); err != nil {
		t.Fatal(err)
	}
	if err = s.SetImageLocalPath(ctx, message.ChatJID, message.ID, "/cache/photo.jpg"); err != nil {
		t.Fatal(err)
	}
	// Replaying remote metadata must not discard a locally downloaded cache path.
	if err = s.ApplyMessage(ctx, message, false); err != nil {
		t.Fatal(err)
	}
	got, err := s.Message(ctx, message.ChatJID, message.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Image == nil || got.Image.LocalPath != "/cache/photo.jpg" || got.Image.Caption != "caption" || got.Image.MIMEType != "image/jpeg" {
		t.Fatalf("image=%+v", got.Image)
	}
	if got.Image.Width != 640 || got.Image.Height != 480 || got.Image.FileSize != 1234 || string(got.Image.MediaKey) != string([]byte{1, 2}) {
		t.Fatalf("metadata=%+v", got.Image)
	}
}

func TestStickerLocalPathCanBeCached(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	message := domain.Message{
		ID: "sticker", ChatJID: "c@g.us", SenderJID: "u@s.whatsapp.net",
		Timestamp: time.Now(), Kind: "sticker", Image: &domain.Image{MIMEType: "image/webp"},
	}
	if err = s.ApplyMessage(ctx, message, false); err != nil {
		t.Fatal(err)
	}
	if err = s.SetImageLocalPath(ctx, message.ChatJID, message.ID, "/cache/sticker.webp"); err != nil {
		t.Fatal(err)
	}
	stored, err := s.Message(ctx, message.ChatJID, message.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Image == nil || stored.Image.LocalPath != "/cache/sticker.webp" {
		t.Fatalf("stored sticker = %+v", stored.Image)
	}
}

func TestAttachmentLocalPathCanBeCached(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	messages := []domain.Message{
		{ID: "document", ChatJID: "c@g.us", Timestamp: time.Now(), Kind: "document", Attachment: &domain.Attachment{MIMEType: "application/pdf", FileName: "notes.pdf"}},
		{ID: "video", ChatJID: "c@g.us", Timestamp: time.Now(), Kind: "video", Attachment: &domain.Attachment{MIMEType: "video/mp4"}},
		{ID: "audio", ChatJID: "c@g.us", Timestamp: time.Now(), Kind: "audio", Attachment: &domain.Attachment{MIMEType: "audio/mpeg"}},
		{ID: "image", ChatJID: "c@g.us", Timestamp: time.Now(), Kind: "image", Image: &domain.Image{MIMEType: "image/jpeg"}},
	}
	if err = s.ApplyMessages(ctx, messages, false); err != nil {
		t.Fatal(err)
	}
	for _, message := range messages[:3] {
		path := "/cache/" + message.ID
		if err = s.SetAttachmentLocalPath(ctx, message.ChatJID, message.ID, path); err != nil {
			t.Fatalf("cache %s: %v", message.Kind, err)
		}
		stored, loadErr := s.Message(ctx, message.ChatJID, message.ID)
		if loadErr != nil {
			t.Fatal(loadErr)
		}
		if stored.Attachment == nil || stored.Attachment.LocalPath != path {
			t.Fatalf("stored %s = %+v", message.Kind, stored.Attachment)
		}
	}
	if err = s.SetAttachmentLocalPath(ctx, "c@g.us", "image", "/cache/not-an-attachment"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("image cache error=%v, want sql.ErrNoRows", err)
	}
}

func TestLegacyImageWithoutDescriptorRemainsRepairable(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	legacy := domain.Message{ID: "old-image", ChatJID: "c@g.us", SenderJID: "u@s.whatsapp.net", Text: "Unsupported message", Timestamp: time.Now(), Kind: "image"}
	if err = s.ApplyMessage(ctx, legacy, false); err != nil {
		t.Fatal(err)
	}
	got, err := s.Message(ctx, legacy.ChatJID, legacy.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Image == nil {
		t.Fatal("legacy image marker was discarded")
	}
}

func TestHistoricalImageWithNilDescriptorBytesStoresEmptyBlobs(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	message := domain.Message{
		ID: "history-image", ChatJID: "c@g.us", TransportJID: "c@g.us",
		Text: "photo", Timestamp: time.Now(), Kind: "image",
		Image: &domain.Image{MIMEType: "image/jpeg"},
	}
	if err = s.ApplyMessage(ctx, message, false); err != nil {
		t.Fatal(err)
	}
	chatID, err := s.ResolveChat(ctx, message.ChatJID)
	if err != nil {
		t.Fatal(err)
	}
	var mediaKeyType, fileHashType, encryptedHashType string
	var mediaKeyLength, fileHashLength, encryptedHashLength int
	if err = s.db.QueryRowContext(ctx, `SELECT typeof(image_media_key),length(image_media_key),typeof(image_file_sha256),length(image_file_sha256),typeof(image_file_enc_sha256),length(image_file_enc_sha256) FROM messages WHERE chat_jid=? AND id=?`, chatID, message.ID).
		Scan(&mediaKeyType, &mediaKeyLength, &fileHashType, &fileHashLength, &encryptedHashType, &encryptedHashLength); err != nil {
		t.Fatal(err)
	}
	if mediaKeyType != "blob" || fileHashType != "blob" || encryptedHashType != "blob" || mediaKeyLength != 0 || fileHashLength != 0 || encryptedHashLength != 0 {
		t.Fatalf("types=(%s,%s,%s) lengths=(%d,%d,%d)", mediaKeyType, fileHashType, encryptedHashType, mediaKeyLength, fileHashLength, encryptedHashLength)
	}
}

func TestMessagesCursor(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 3; i++ {
		m := domain.Message{ID: string(rune('a' + i)), ChatJID: "c@g.us", Timestamp: time.Unix(int64(i+1), 0)}
		if err := s.ApplyMessage(ctx, m, false); err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.Messages(ctx, "c@g.us", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first=%+v", first)
	}
	second, err := s.Messages(ctx, "c@g.us", first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID != "a" {
		t.Fatalf("second=%+v", second)
	}
}

func TestReserveOutgoingIsPersistentAndPayloadBound(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, existed, err := s.ReserveOutgoing(ctx, "request-1", "c@g.us", "hello", "wa-1")
	if err != nil || existed || id != "wa-1" {
		t.Fatalf("first: id=%q existed=%v err=%v", id, existed, err)
	}
	id, existed, err = s.ReserveOutgoing(ctx, "request-1", "c@g.us", "hello", "wa-2")
	if err != nil || !existed || id != "wa-1" {
		t.Fatalf("retry: id=%q existed=%v err=%v", id, existed, err)
	}
	if _, _, err = s.ReserveOutgoing(ctx, "request-1", "c@g.us", "changed", "wa-3"); err == nil {
		t.Fatal("expected payload conflict")
	}
}

func TestReceiptRecoversFailedAndDoesNotRegressRead(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	m := domain.Message{ID: "m", ChatJID: "c@g.us", Timestamp: time.Now(), FromMe: true, Status: domain.StatusFailed}
	if err = s.ApplyMessage(ctx, m, false); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateReceipt(ctx, m.ChatJID, m.ID, domain.StatusSent); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateReceipt(ctx, m.ChatJID, m.ID, domain.StatusRead); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateReceipt(ctx, m.ChatJID, m.ID, domain.StatusFailed); err != nil {
		t.Fatal(err)
	}
	got, err := s.Message(ctx, m.ChatJID, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.StatusRead {
		t.Fatalf("status=%v", got.Status)
	}
}

func TestReserveOutgoingMessageIsAtomic(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	m := domain.Message{ID: "wa-1", ChatJID: "c@g.us", Text: "hello", Timestamp: time.Now(), FromMe: true, Status: domain.StatusPending}
	id, existed, err := s.ReserveOutgoingMessage(ctx, "request", m)
	if err != nil || existed || id != m.ID {
		t.Fatalf("id=%q existed=%v err=%v", id, existed, err)
	}
	if _, err = s.Message(ctx, m.ChatJID, m.ID); err != nil {
		t.Fatalf("reservation committed without pending message: %v", err)
	}
	id, existed, err = s.ReserveOutgoingMessage(ctx, "request", m)
	if err != nil || !existed || id != m.ID {
		t.Fatalf("retry id=%q existed=%v err=%v", id, existed, err)
	}
}

func TestReserveOutgoingMessageUsesBinaryPayloadFingerprint(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	message := domain.Message{ID: "wa-document", ChatJID: "c@g.us", Text: "notes.pdf", Timestamp: time.Now(), FromMe: true, Status: domain.StatusPending, Kind: "document"}
	id, existed, err := s.ReserveOutgoingMessageWithPayload(ctx, "request", "fingerprint-a", message)
	if err != nil || existed || id != message.ID {
		t.Fatalf("id=%q existed=%v err=%v", id, existed, err)
	}
	id, existed, err = s.ReserveOutgoingMessageWithPayload(ctx, "request", "fingerprint-a", message)
	if err != nil || !existed || id != message.ID {
		t.Fatalf("retry id=%q existed=%v err=%v", id, existed, err)
	}
	if _, existed, err = s.ReserveOutgoingMessageWithPayload(ctx, "request", "fingerprint-b", message); err == nil || !existed {
		t.Fatalf("different payload existed=%v err=%v", existed, err)
	}
	stored, err := s.Message(ctx, message.ChatJID, message.ID)
	if err != nil || stored.Text != "notes.pdf" {
		t.Fatalf("stored text=%q err=%v", stored.Text, err)
	}
}

func TestMarkReadThroughPreservesNewerUnread(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	old := domain.Message{ID: "old", ChatJID: "c@g.us", SenderJID: "u@s.whatsapp.net", Timestamp: time.Unix(1, 0)}
	newer := domain.Message{ID: "new", ChatJID: old.ChatJID, SenderJID: old.SenderJID, Timestamp: time.Unix(2, 0)}
	if err = s.ApplyMessage(ctx, old, true); err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyMessage(ctx, newer, true); err != nil {
		t.Fatal(err)
	}
	if err = s.MarkReadThrough(ctx, old.ChatJID, old.ID); err != nil {
		t.Fatal(err)
	}
	chat, err := s.Chat(ctx, old.ChatJID)
	if err != nil {
		t.Fatal(err)
	}
	if chat.UnreadCount != 1 {
		t.Fatalf("unread=%d want 1", chat.UnreadCount)
	}
}

func TestInitialMessageWindowAnchorsEarliestUnreadAndPagesForward(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 6; i++ {
		message := domain.Message{ID: fmt.Sprintf("m%d", i), ChatJID: "chat@g.us", SenderJID: "sender@s.whatsapp.net", Text: fmt.Sprintf("message %d", i), Timestamp: time.Unix(int64(i+1), 0)}
		if err = s.ApplyMessage(ctx, message, i >= 3); err != nil {
			t.Fatal(err)
		}
	}
	window, err := s.InitialMessageWindow(ctx, "chat@g.us", 1)
	if err != nil {
		t.Fatal(err)
	}
	if window.AnchorID != "m3" {
		t.Fatalf("anchor=%q want m3", window.AnchorID)
	}
	if got := []string{window.Items[0].ID, window.Items[1].ID, window.Items[2].ID}; !slices.Equal(got, []string{"m2", "m3", "m4"}) {
		t.Fatalf("window=%v", got)
	}
	if !window.HasOlder || !window.HasNewer {
		t.Fatalf("pagination older=%t newer=%t", window.HasOlder, window.HasNewer)
	}
	newer, hasMore, err := s.MessagesAfter(ctx, "chat@g.us", window.Items[2].Timestamp.UnixMilli(), window.Items[2].ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(newer) != 1 || newer[0].ID != "m5" || hasMore {
		t.Fatalf("newer=%+v has_more=%t", newer, hasMore)
	}
}

func TestInitialMessageWindowWithoutUnreadUsesNewestPage(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 60; i++ {
		if err = s.ApplyMessage(ctx, domain.Message{ID: fmt.Sprintf("m%02d", i), ChatJID: "chat@g.us", Timestamp: time.Unix(int64(i+1), 0)}, false); err != nil {
			t.Fatal(err)
		}
	}
	window, err := s.InitialMessageWindow(ctx, "chat@g.us", 25)
	if err != nil {
		t.Fatal(err)
	}
	if window.AnchorID != "" || len(window.Items) != 50 || !window.HasOlder || window.HasNewer {
		t.Fatalf("window=%+v", window)
	}
	if window.Items[0].ID != "m10" || window.Items[49].ID != "m59" {
		t.Fatalf("range=%s..%s", window.Items[0].ID, window.Items[49].ID)
	}
}

func TestCrossDeviceReadPositionPreservesMessagesAfterMarker(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 3; i++ {
		message := domain.Message{ID: fmt.Sprintf("m%d", i), ChatJID: "chat@g.us", SenderJID: "sender@s.whatsapp.net", Timestamp: time.Unix(int64(i+1), 0)}
		if err = s.ApplyMessage(ctx, message, true); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.MarkReadThroughPosition(ctx, "chat@g.us", "m1", time.Time{}); err != nil {
		t.Fatal(err)
	}
	chat, err := s.Chat(ctx, "chat@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if chat.UnreadCount != 1 {
		t.Fatalf("unread=%d want 1", chat.UnreadCount)
	}
	if err = s.MarkReadThroughPosition(ctx, "chat@g.us", "missing", time.Unix(3, 0)); err != nil {
		t.Fatal(err)
	}
	chat, err = s.Chat(ctx, "chat@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if chat.UnreadCount != 0 {
		t.Fatalf("fallback unread=%d", chat.UnreadCount)
	}
}

func TestUnreadThroughCanAcknowledgeSenderGroupsIndependently(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i, sender := range []string{"a@s.whatsapp.net", "b@s.whatsapp.net", "a@s.whatsapp.net"} {
		m := domain.Message{ID: fmt.Sprintf("m%d", i), ChatJID: "group@g.us", SenderJID: sender, Timestamp: time.Unix(int64(i+1), 0)}
		if err = s.ApplyMessage(ctx, m, true); err != nil {
			t.Fatal(err)
		}
	}
	items, err := s.UnreadThrough(ctx, "group@g.us", "m2")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("items=%d", len(items))
	}
	if err = s.MarkReadIDs(ctx, "group@g.us", []string{"m0", "m2"}); err != nil {
		t.Fatal(err)
	}
	chat, err := s.Chat(ctx, "group@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if chat.UnreadCount != 1 {
		t.Fatalf("unread=%d", chat.UnreadCount)
	}
}

func TestEditAndRevokeUpdateCurrentPreviewAndSurviveReplay(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	original := domain.Message{ID: "m", ChatJID: "c@g.us", Text: "original", Kind: "text", Timestamp: time.Unix(1, 0)}
	if err = s.ApplyMessage(ctx, original, false); err != nil {
		t.Fatal(err)
	}
	edited := original
	edited.Text = "edited"
	edited.EditedAt = time.Unix(2, 0)
	if err = s.ApplyMessage(ctx, edited, false); err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyMessage(ctx, original, false); err != nil {
		t.Fatal(err)
	}
	got, err := s.Message(ctx, original.ChatJID, original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "edited" {
		t.Fatalf("replay overwrote edit: %+v", got)
	}
	revoked := edited
	revoked.Text = "Message deleted"
	revoked.Revoked = true
	revoked.EditedAt = time.Unix(3, 0)
	if err = s.ApplyMessage(ctx, revoked, false); err != nil {
		t.Fatal(err)
	}
	chat, err := s.Chat(ctx, original.ChatJID)
	if err != nil {
		t.Fatal(err)
	}
	if chat.LastMessageText != "Message deleted" {
		t.Fatalf("preview=%q", chat.LastMessageText)
	}
}
