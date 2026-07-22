package wa

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rust-meow/rust-meow/backend/internal/domain"
	"github.com/rust-meow/rust-meow/backend/internal/store"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	waAdv "go.mau.fi/whatsmeow/proto/waAdv"
	waCommon "go.mau.fi/whatsmeow/proto/waCommon"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	waSyncAction "go.mau.fi/whatsmeow/proto/waSyncAction"
	waWeb "go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func startTestReducer(c *Client) func() {
	c.reducerWG.Add(1)
	go func() {
		defer c.reducerWG.Done()
		for {
			select {
			case task := <-c.reducer:
				task()
			case <-c.reducerDone:
				return
			}
		}
	}()
	return func() { close(c.reducerDone); c.reducerWG.Wait() }
}

func TestNormalReactionEventTargetsOriginalMessage(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	timestamp := time.UnixMilli(1234)
	evt := &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, Timestamp: timestamp}, Message: &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Key: &waCommon.MessageKey{ID: proto.String("target")}, Text: proto.String("👍"), SenderTimestampMS: proto.Int64(timestamp.UnixMilli())}}}
	reaction, ok, err := new(Client).reactionFromEvent(context.Background(), evt)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if reaction.MessageID != "target" || reaction.ChatJID != chat.String() || reaction.SenderJID != sender.String() || reaction.Emoji != "👍" {
		t.Fatalf("reaction=%+v", reaction)
	}
}

func TestDomainMessagePreservesImageDownloadDescriptor(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: sender},
			ID:            "image-1",
			Timestamp:     time.UnixMilli(1234),
		},
		Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption: proto.String("cat"), Mimetype: proto.String("image/jpeg"),
			DirectPath: proto.String("/remote"), MediaKey: []byte{1},
			FileSHA256: []byte{2}, FileEncSHA256: []byte{3},
			Width: proto.Uint32(640), Height: proto.Uint32(480), FileLength: proto.Uint64(99),
		}},
	}
	got := domainMessage(evt, chat.String(), chat.String())
	if got.Kind != "image" || got.Text != "cat" || got.Image == nil {
		t.Fatalf("message=%+v", got)
	}
	if got.Image.MIMEType != "image/jpeg" || got.Image.DirectPath != "/remote" || got.Image.Width != 640 || got.Image.Height != 480 || got.Image.FileSize != 99 {
		t.Fatalf("image=%+v", got.Image)
	}
}

func TestContactSearchIsFuzzyAndCreatesConversationOnlyWhenOpened(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	productStore, err := store.Open(ctx, filepath.Join(directory, "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	client, err := New(ctx, directory, productStore, func(Event) {}, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	own, _ := types.ParseJID("15550000000:1@s.whatsapp.net")
	client.wa.Store.ID = &own
	client.wa.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details: []byte{1}, AccountSignatureKey: make([]byte, 32), AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64),
	}
	if err = client.wa.Store.Save(ctx); err != nil {
		t.Fatal(err)
	}
	alice, _ := types.ParseJID("15551234567@s.whatsapp.net")
	if err = client.wa.Store.Contacts.PutContactName(ctx, alice, "Alice Smith", "Alice"); err != nil {
		t.Fatal(err)
	}
	before, err := productStore.ChatCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	results, err := client.SearchContacts(ctx, "alcie", 8)
	if err != nil || len(results) != 1 || results[0].DisplayName != "Alice" || results[0].ChatID != "" {
		t.Fatalf("results=%+v err=%v", results, err)
	}
	afterSearch, err := productStore.ChatCount(ctx)
	if err != nil || afterSearch != before {
		t.Fatalf("search mutated chats: before=%d after=%d err=%v", before, afterSearch, err)
	}
	chat, err := client.OpenContact(ctx, results[0].JID)
	if err != nil || chat.JID == "" || chat.AddressJID != alice.String() {
		t.Fatalf("chat=%+v err=%v", chat, err)
	}
	afterOpen, err := productStore.ChatCount(ctx)
	if err != nil || afterOpen != before+1 {
		t.Fatalf("open did not create one chat: before=%d after=%d err=%v", before, afterOpen, err)
	}
}

func setupChatPresentationPage(tb testing.TB, count int) (context.Context, *Client, []string, func()) {
	tb.Helper()
	ctx := context.Background()
	directory := tb.TempDir()
	productStore, err := store.Open(ctx, filepath.Join(directory, "client.db"))
	if err != nil {
		tb.Fatal(err)
	}
	client, err := New(ctx, directory, productStore, func(Event) {}, slog.Default())
	if err != nil {
		productStore.Close()
		tb.Fatal(err)
	}
	cleanup := func() {
		client.Close()
		productStore.Close()
	}
	own, _ := types.ParseJID("15550000000:1@s.whatsapp.net")
	client.wa.Store.ID = &own
	client.wa.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details: []byte{1}, AccountSignatureKey: make([]byte, 32), AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64),
	}
	if err = client.wa.Store.Save(ctx); err != nil {
		cleanup()
		tb.Fatal(err)
	}
	chatIDs := make([]string, count)
	for i := range chatIDs {
		jid, _ := types.ParseJID(fmt.Sprintf("1555001%04d@s.whatsapp.net", i))
		chatIDs[i], _, err = productStore.EnsureConversation(ctx, jid.String())
		if err == nil {
			err = client.wa.Store.Contacts.PutContactName(ctx, jid, fmt.Sprintf("Person %03d", i), fmt.Sprintf("Person %03d", i))
		}
		if err != nil {
			cleanup()
			tb.Fatal(err)
		}
	}
	return ctx, client, chatIDs, cleanup
}

func TestChatPresentationsBatchesHundredChatPage(t *testing.T) {
	ctx, client, chatIDs, cleanup := setupChatPresentationPage(t, 100)
	defer cleanup()
	firstJID, _ := types.ParseJID("15550010000@s.whatsapp.net")
	if err := os.MkdirAll(client.avatarDir, 0o700); err != nil {
		t.Fatal(err)
	}
	avatarPath := client.avatarPath(firstJID)
	if err := os.WriteFile(avatarPath, []byte("cached avatar"), 0o600); err != nil {
		t.Fatal(err)
	}
	client.loadCachedAvatars()

	presentations, err := client.ChatPresentations(ctx, chatIDs)
	if err != nil {
		t.Fatal(err)
	}
	if len(presentations) != len(chatIDs) {
		t.Fatalf("presentations=%d want=%d", len(presentations), len(chatIDs))
	}
	for i, chatID := range chatIDs {
		presentation := presentations[chatID]
		if want := fmt.Sprintf("Person %03d", i); presentation.Details.ContactName != want {
			t.Fatalf("chat %d contact=%q want=%q", i, presentation.Details.ContactName, want)
		}
		if i == 0 && presentation.AvatarPath != avatarPath {
			t.Fatalf("cached avatar=%q want=%q", presentation.AvatarPath, avatarPath)
		}
	}
}

func BenchmarkChatPresentationsHundredChatPage(b *testing.B) {
	ctx, client, chatIDs, cleanup := setupChatPresentationPage(b, 100)
	b.Cleanup(cleanup)
	b.ReportAllocs()
	for b.Loop() {
		client.clearContactCache()
		if _, err := client.ChatPresentations(ctx, chatIDs); err != nil {
			b.Fatal(err)
		}
	}
}

func TestDomainMessageNormalizesSenderDeviceJID(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456:7@s.whatsapp.net")
	evt := &events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, ID: "text-1", Timestamp: time.UnixMilli(1234)},
		Message: &waE2E.Message{Conversation: proto.String("hello")},
	}
	got := domainMessage(evt, chat.String(), chat.String())
	if got.SenderJID != "456@s.whatsapp.net" {
		t.Fatalf("sender=%q", got.SenderJID)
	}
}

func TestDomainMessagePreservesNativeReplyTarget(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	evt := &events.Message{
		Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, ID: "reply-1", Timestamp: time.UnixMilli(1234)},
		Message: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text:        proto.String("answer"),
			ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("original-1")},
		}},
	}
	got := domainMessage(evt, chat.String(), chat.String())
	if got.ReplyToID != "original-1" || got.Text != "answer" {
		t.Fatalf("message=%+v", got)
	}
}

func TestDomainMessagePreservesExtendedTextLinkPreview(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	evt := &events.Message{
		Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, ID: "link-1", Timestamp: time.UnixMilli(1234)},
		Message: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text:            proto.String("read https://example.com/meow"),
			MatchedText:     proto.String("https://example.com/meow"),
			Title:           proto.String("Meow article"),
			Description:     proto.String("All about native cats"),
			JPEGThumbnail:   []byte{1, 2, 3},
			ThumbnailWidth:  proto.Uint32(320),
			ThumbnailHeight: proto.Uint32(180),
		}},
	}
	got := domainMessage(evt, chat.String(), chat.String())
	if got.LinkPreview == nil || got.LinkPreview.URL != "https://example.com/meow" || got.LinkPreview.Title != "Meow article" || string(got.LinkPreview.JPEGThumbnail) != "\x01\x02\x03" {
		t.Fatalf("preview=%+v", got.LinkPreview)
	}
}

func TestMessageContextInfoSupportsMediaReplies(t *testing.T) {
	message := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("photo-target")},
	}}
	if got := messageContextInfo(message).GetStanzaID(); got != "photo-target" {
		t.Fatalf("reply target=%q", got)
	}
}

func TestQuotedMessageKeepsImageKindAndCaption(t *testing.T) {
	quoted := quotedMessage(domain.Message{Kind: "image", Text: "fallback", Image: &domain.Image{Caption: "cat", MIMEType: "image/jpeg"}})
	if quoted.GetImageMessage().GetCaption() != "cat" || quoted.GetImageMessage().GetMimetype() != "image/jpeg" {
		t.Fatalf("quoted=%+v", quoted)
	}
}

func TestQuotedMessageKeepsAttachmentKinds(t *testing.T) {
	document := quotedMessage(domain.Message{Kind: "document", Attachment: &domain.Attachment{Caption: "plan", MIMEType: "application/pdf", FileName: "plan.pdf"}}).GetDocumentMessage()
	if document.GetCaption() != "plan" || document.GetMimetype() != "application/pdf" || document.GetFileName() != "plan.pdf" {
		t.Fatalf("document=%+v", document)
	}
	video := quotedMessage(domain.Message{Kind: "video", Attachment: &domain.Attachment{Caption: "clip", MIMEType: "video/mp4"}}).GetVideoMessage()
	if video.GetCaption() != "clip" || video.GetMimetype() != "video/mp4" {
		t.Fatalf("video=%+v", video)
	}
	audio := quotedMessage(domain.Message{Kind: "audio", Attachment: &domain.Attachment{MIMEType: "audio/ogg", VoiceNote: true}}).GetAudioMessage()
	if audio.GetMimetype() != "audio/ogg" || !audio.GetPTT() {
		t.Fatalf("audio=%+v", audio)
	}
}

func TestIdentityJIDsDeduplicatesExplicitAliases(t *testing.T) {
	c := &Client{}
	got := c.identityJIDs(context.Background(), "200201394507780@lid", "919999890760@s.whatsapp.net", "200201394507780@lid")
	if len(got) != 2 || got[0].String() != "200201394507780@lid" || got[1].String() != "919999890760@s.whatsapp.net" {
		t.Fatalf("identities=%v", got)
	}
}

func TestDomainMessageDecodesStickerAsLazyImage(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	evt := &events.Message{
		Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, ID: "sticker-1", Timestamp: time.UnixMilli(1234)},
		Message: &waE2E.Message{StickerMessage: &waE2E.StickerMessage{
			Mimetype: proto.String("image/webp"), DirectPath: proto.String("/sticker"), MediaKey: []byte{1}, FileSHA256: []byte{2}, FileEncSHA256: []byte{3},
			Width: proto.Uint32(512), Height: proto.Uint32(512), FileLength: proto.Uint64(99), IsAnimated: proto.Bool(true),
		}},
	}
	got := domainMessage(evt, chat.String(), chat.String())
	if got.Kind != "sticker" || got.Text != "Sticker" || got.Image == nil || !got.Image.Animated || got.Image.DirectPath != "/sticker" {
		t.Fatalf("message=%+v", got)
	}
}

func TestStickerMetadataRejectsNonWebPAndWrongDimensions(t *testing.T) {
	if _, _, _, err := stickerMetadata([]byte("not an image")); err == nil {
		t.Fatal("non-WebP sticker was accepted")
	}

	// A valid 1x1 lossless WebP. It must decode successfully but still be
	// rejected because outbound stickers are normalized to exactly 512x512.
	onePixelWebP := []byte{
		0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
		0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
		0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
		0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe,
		0x07, 0x00,
	}
	if _, _, _, err := stickerMetadata(onePixelWebP); err == nil || err.Error() != "sticker must be 512×512" {
		t.Fatalf("wrong-size WebP error=%v", err)
	}
}

func TestWebPIsAnimatedHandlesFeatureFlagAndMalformedChunks(t *testing.T) {
	animated := []byte("RIFF\x0a\x00\x00\x00WEBPVP8X\x01\x00\x00\x00\x02\x00")
	if !webpIsAnimated(animated) {
		t.Fatal("VP8X animation feature flag was ignored")
	}
	animated[20] = 0
	if webpIsAnimated(animated) {
		t.Fatal("static VP8X image reported as animated")
	}
	malformed := []byte("RIFF\xff\xff\xff\xffWEBPANIM\xff\xff\xff\xff")
	if webpIsAnimated(malformed) {
		t.Fatal("truncated animation chunk reported as valid")
	}
}

func TestImageDescriptorChangedRequiresFreshDownloadCoordinates(t *testing.T) {
	old := &domain.Image{DirectPath: "/old", MediaKey: []byte{1}, FileEncSHA256: []byte{2}}
	if imageDescriptorChanged(old, &domain.Image{DirectPath: "/old", MediaKey: []byte{1}, FileEncSHA256: []byte{2}}) {
		t.Fatal("identical descriptor reported as fresh")
	}
	if !imageDescriptorChanged(old, &domain.Image{DirectPath: "/new", MediaKey: []byte{1}, FileEncSHA256: []byte{2}}) {
		t.Fatal("new direct path was not detected")
	}
	if !imageDescriptorChanged(&domain.Image{}, old) {
		t.Fatal("complete descriptor must replace missing metadata")
	}
}

func writeAttachmentFixture(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOpenAttachmentSourceValidatesKindsAndVoiceNotes(t *testing.T) {
	documentPath := writeAttachmentFixture(t, "notes.pdf", []byte("%PDF-1.7\ncontent"))
	document, err := openAttachmentSource(documentPath, "document", false)
	if err != nil {
		t.Fatal(err)
	}
	if document.mimeType != "application/pdf" || document.fileName != "notes.pdf" || document.size == 0 {
		t.Fatalf("document=%+v", document)
	}
	_ = document.file.Close()
	if _, err = openAttachmentSource(documentPath, "video", false); err == nil {
		t.Fatal("PDF was accepted as a video")
	}
	if _, err = openAttachmentSource(documentPath, "document", true); err == nil {
		t.Fatal("document was accepted as a voice note")
	}

	videoPath := writeAttachmentFixture(t, "clip.mp4", []byte{0, 0, 0, 20, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0})
	video, err := openAttachmentSource(videoPath, "video", false)
	if err != nil {
		t.Fatal(err)
	}
	if video.mimeType != "video/mp4" {
		t.Fatalf("video MIME=%q", video.mimeType)
	}
	_ = video.file.Close()

	voicePath := writeAttachmentFixture(t, "voice.ogg", []byte("OggS\x00\x02fixture-OpusHead-audio"))
	voice, err := openAttachmentSource(voicePath, "audio", true)
	if err != nil {
		t.Fatal(err)
	}
	if voice.mimeType != "audio/ogg; codecs=opus" {
		t.Fatalf("voice MIME=%q", voice.mimeType)
	}
	_ = voice.file.Close()
	ordinaryOgg := writeAttachmentFixture(t, "ordinary.ogg", []byte("OggS\x00\x02vorbis-audio"))
	if _, err = openAttachmentSource(ordinaryOgg, "audio", true); err == nil {
		t.Fatal("non-Opus Ogg was accepted as a voice note")
	}
	if _, err = openAttachmentSource("relative.pdf", "document", false); err == nil {
		t.Fatal("relative attachment path was accepted")
	}
	if _, err = openAttachmentSource(t.TempDir(), "document", false); err == nil {
		t.Fatal("directory was accepted as an attachment")
	}
	largePath := filepath.Join(t.TempDir(), "large.bin")
	large, err := os.Create(largePath)
	if err != nil {
		t.Fatal(err)
	}
	if err = large.Truncate(maxAttachmentBytes + 1); err != nil {
		_ = large.Close()
		t.Fatal(err)
	}
	if err = large.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = openAttachmentSource(largePath, "document", false); err == nil {
		t.Fatal("attachment larger than 2 GiB was accepted")
	}
}

func TestOutgoingAttachmentMessagesCarryUploadMetadata(t *testing.T) {
	upload := whatsmeow.UploadResponse{
		URL: "https://media.example/file", DirectPath: "/mms/file", FileLength: 123,
		MediaKey: bytes.Repeat([]byte{1}, 32), FileSHA256: bytes.Repeat([]byte{2}, 32), FileEncSHA256: bytes.Repeat([]byte{3}, 32),
	}
	contextInfo := &waE2E.ContextInfo{StanzaID: proto.String("reply-target")}
	documentAttachment := &domain.Attachment{Caption: "plan", MIMEType: "application/pdf", FileName: "plan.pdf"}
	documentMessage, err := outgoingAttachmentMessage("document", documentAttachment, upload, contextInfo)
	if err != nil {
		t.Fatal(err)
	}
	document := documentMessage.GetDocumentMessage()
	if document.GetURL() != upload.URL || document.GetDirectPath() != upload.DirectPath || document.GetFileLength() != 123 || document.GetFileName() != "plan.pdf" || document.GetCaption() != "plan" || document.GetContextInfo().GetStanzaID() != "reply-target" {
		t.Fatalf("document=%+v", document)
	}
	videoMessage, err := outgoingAttachmentMessage("video", &domain.Attachment{Caption: "clip", MIMEType: "video/mp4"}, upload, contextInfo)
	if err != nil {
		t.Fatal(err)
	}
	video := videoMessage.GetVideoMessage()
	if video.GetMimetype() != "video/mp4" || video.GetCaption() != "clip" || video.GetContextInfo().GetStanzaID() != "reply-target" {
		t.Fatalf("video=%+v", video)
	}
	audioMessage, err := outgoingAttachmentMessage("audio", &domain.Attachment{MIMEType: "audio/ogg; codecs=opus", VoiceNote: true}, upload, contextInfo)
	if err != nil {
		t.Fatal(err)
	}
	audio := audioMessage.GetAudioMessage()
	if audio.GetMimetype() != "audio/ogg; codecs=opus" || !audio.GetPTT() || audio.GetContextInfo().GetStanzaID() != "reply-target" {
		t.Fatalf("audio=%+v", audio)
	}
	if _, err = outgoingAttachmentMessage("image", &domain.Attachment{}, upload, nil); err == nil {
		t.Fatal("unsupported attachment kind was accepted")
	}
	if !validUploadResponse(upload, 123) {
		t.Fatal("complete upload metadata was rejected")
	}
	upload.MediaKey = upload.MediaKey[:31]
	if validUploadResponse(upload, 123) {
		t.Fatal("short upload media key was accepted")
	}
}

func TestAttachmentPayloadFingerprintCoversBinaryRequest(t *testing.T) {
	source := attachmentSource{path: "/tmp/notes.pdf", mimeType: "application/pdf", size: 42}
	base := attachmentPayloadFingerprint(source, "document", "caption", "reply", false)
	if len(base) != 64 || base != attachmentPayloadFingerprint(source, "document", "caption", "reply", false) {
		t.Fatalf("fingerprint=%q is not a stable SHA-256 value", base)
	}
	variants := []string{
		attachmentPayloadFingerprint(attachmentSource{path: "/tmp/other.pdf", mimeType: source.mimeType, size: source.size}, "document", "caption", "reply", false),
		attachmentPayloadFingerprint(attachmentSource{path: source.path, mimeType: source.mimeType, size: source.size + 1}, "document", "caption", "reply", false),
		attachmentPayloadFingerprint(source, "video", "caption", "reply", false),
		attachmentPayloadFingerprint(source, "document", "different", "reply", false),
		attachmentPayloadFingerprint(source, "document", "caption", "other-reply", false),
		attachmentPayloadFingerprint(source, "document", "caption", "reply", true),
	}
	for _, variant := range variants {
		if variant == base {
			t.Fatal("different attachment payload produced the same fingerprint")
		}
	}
}

func TestDownloadableAttachmentPreservesDescriptors(t *testing.T) {
	attachment := &domain.Attachment{
		Caption: "caption", MIMEType: "application/octet-stream", FileName: "archive.bin", DirectPath: "/mms/file",
		MediaKey: []byte{1}, FileSHA256: []byte{2}, FileEncSHA256: []byte{3}, FileSize: 44,
		Width: 640, Height: 360, DurationSeconds: 9, Animated: true, VoiceNote: true,
	}
	document, err := downloadableAttachment("document", attachment)
	if err != nil {
		t.Fatal(err)
	}
	if got := document.(*waE2E.DocumentMessage); got.GetFileName() != "archive.bin" || got.GetDirectPath() != "/mms/file" || got.GetFileLength() != 44 {
		t.Fatalf("document=%+v", got)
	}
	video, err := downloadableAttachment("video", attachment)
	if err != nil {
		t.Fatal(err)
	}
	if got := video.(*waE2E.VideoMessage); got.GetWidth() != 640 || got.GetHeight() != 360 || !got.GetGifPlayback() || got.GetSeconds() != 9 {
		t.Fatalf("video=%+v", got)
	}
	audio, err := downloadableAttachment("audio", attachment)
	if err != nil {
		t.Fatal(err)
	}
	if got := audio.(*waE2E.AudioMessage); !got.GetPTT() || got.GetSeconds() != 9 || got.GetDirectPath() != "/mms/file" {
		t.Fatalf("audio=%+v", got)
	}
	if _, err = downloadableAttachment("image", attachment); err == nil {
		t.Fatal("unsupported attachment kind was downloadable")
	}
}

func TestBoundedFileRejectsOversizedMutations(t *testing.T) {
	underlying, err := os.CreateTemp(t.TempDir(), "bounded-*")
	if err != nil {
		t.Fatal(err)
	}
	defer underlying.Close()
	file := &boundedFile{File: underlying, maxSize: 4}
	if n, writeErr := file.Write([]byte("1234")); writeErr != nil || n != 4 {
		t.Fatalf("initial write n=%d err=%v", n, writeErr)
	}
	if _, err = file.Write([]byte("5")); !errors.Is(err, errAttachmentDownloadLimit) {
		t.Fatalf("oversized sequential write error=%v", err)
	}
	if _, err = file.WriteAt([]byte("45"), 3); !errors.Is(err, errAttachmentDownloadLimit) {
		t.Fatalf("oversized positional write error=%v", err)
	}
	if err = file.Truncate(5); !errors.Is(err, errAttachmentDownloadLimit) {
		t.Fatalf("oversized truncate error=%v", err)
	}
	if err = file.Truncate(4); err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 4 {
		t.Fatalf("size=%d, want 4", info.Size())
	}
}

func TestDownloadAttachmentUsesValidLocalFilesWithoutNetwork(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	productStore, err := store.Open(ctx, filepath.Join(directory, "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	sourcePath := filepath.Join(directory, "source.pdf")
	contents := []byte("%PDF-1.7 local")
	if err = os.WriteFile(sourcePath, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	message := domain.Message{
		ID: "document-1", ChatJID: "123@g.us", Timestamp: time.Now(), Kind: "document", Text: "source.pdf",
		Attachment: &domain.Attachment{MIMEType: "application/pdf", FileName: "source.pdf", LocalPath: sourcePath, FileSize: uint64(len(contents))},
	}
	if err = productStore.ApplyMessage(ctx, message, false); err != nil {
		t.Fatal(err)
	}
	client := &Client{store: productStore, mediaDir: filepath.Join(directory, "media")}
	path, err := client.DownloadAttachment(ctx, message.ChatJID, message.ID)
	if err != nil || path != sourcePath {
		t.Fatalf("path=%q err=%v", path, err)
	}
	if err = os.Remove(sourcePath); err != nil {
		t.Fatal(err)
	}
	stored, err := productStore.Message(ctx, message.ChatJID, message.ID)
	if err != nil {
		t.Fatal(err)
	}
	cachePath := client.attachmentPath(stored.ChatJID, stored.ID, stored.Attachment)
	if err = os.MkdirAll(client.mediaDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(cachePath, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	path, err = client.DownloadAttachment(ctx, message.ChatJID, message.ID)
	if err != nil || path != cachePath {
		t.Fatalf("cached path=%q want=%q err=%v", path, cachePath, err)
	}
	stored, err = productStore.Message(ctx, message.ChatJID, message.ID)
	if err != nil || stored.Attachment == nil || stored.Attachment.LocalPath != cachePath {
		t.Fatalf("stored=%+v err=%v", stored.Attachment, err)
	}
}

func TestAttachmentDescriptorChangedRequiresFreshCoordinates(t *testing.T) {
	old := &domain.Attachment{DirectPath: "/old", MediaKey: []byte{1}, FileEncSHA256: []byte{2}}
	if attachmentDescriptorChanged(old, &domain.Attachment{DirectPath: "/old", MediaKey: []byte{1}, FileEncSHA256: []byte{2}}) {
		t.Fatal("identical descriptor reported as fresh")
	}
	if !attachmentDescriptorChanged(old, &domain.Attachment{DirectPath: "/new", MediaKey: []byte{1}, FileEncSHA256: []byte{2}}) {
		t.Fatal("new direct path was not detected")
	}
	if !attachmentDescriptorChanged(&domain.Attachment{}, old) {
		t.Fatal("complete descriptor must replace missing metadata")
	}
}

func TestSafeImageConfigRejectsSmallPayloadWithOversizedDimensions(t *testing.T) {
	// A GIF logical-screen descriptor is enough for DecodeConfig to report the
	// dimensions, making this a compact decompression-bomb regression fixture.
	oversized := []byte("GIF89a\xff\xff\xff\xff\x00\x00\x00")
	if len(oversized) >= 32 {
		t.Fatalf("fixture unexpectedly large: %d bytes", len(oversized))
	}
	if _, err := safeImageConfig(bytes.NewReader(oversized)); err == nil {
		t.Fatal("oversized decoded dimensions were accepted")
	}
}

func TestSafeImageConfigAcceptsBoundedDimensions(t *testing.T) {
	bounded := []byte("GIF89a\x00\x02\x00\x02\x00\x00\x00")
	config, err := safeImageConfig(bytes.NewReader(bounded))
	if err != nil {
		t.Fatal(err)
	}
	if config.Width != 512 || config.Height != 512 {
		t.Fatalf("dimensions=%dx%d", config.Width, config.Height)
	}
}

func TestImageCacheCreatesBoundedThumbnailPair(t *testing.T) {
	// A 12 MP source mirrors the issue's high-RSS case: the original requires
	// roughly 48 MiB decoded while the row asset is bounded below 1 MiB.
	source := image.NewRGBA(image.Rect(0, 0, 4000, 3000))
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	c := &Client{mediaDir: t.TempDir()}
	originalPath, thumbnailPath, err := c.cacheImageBytes("chat", "message", "image/png", encoded.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if originalPath == thumbnailPath {
		t.Fatal("thumbnail reused the full-resolution cache path")
	}
	original, err := safeImageFile(originalPath)
	if err != nil {
		t.Fatal(err)
	}
	thumbnail, err := safeImageFile(thumbnailPath)
	if err != nil {
		t.Fatal(err)
	}
	if original.Width != 4000 || original.Height != 3000 {
		t.Fatalf("original=%dx%d", original.Width, original.Height)
	}
	if thumbnail.Width != 512 || thumbnail.Height != 384 {
		t.Fatalf("thumbnail=%dx%d, want 512x384", thumbnail.Width, thumbnail.Height)
	}

	if err = os.Remove(thumbnailPath); err != nil {
		t.Fatal(err)
	}
	if gotOriginal, gotThumbnail := c.CachedImagePaths("chat", "message", "image/png"); gotOriginal != "" || gotThumbnail != "" {
		t.Fatalf("legacy original was exposed without a thumbnail=(%q, %q)", gotOriginal, gotThumbnail)
	}
	gotOriginal, gotThumbnail := c.cachedImagePaths("chat", "message", "image/png", true)
	if gotOriginal != originalPath || gotThumbnail != thumbnailPath {
		t.Fatalf("regenerated pair=(%q, %q)", gotOriginal, gotThumbnail)
	}
	if err = os.WriteFile(thumbnailPath, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if gotOriginal, gotThumbnail = c.CachedImagePaths("chat", "message", "image/png"); gotOriginal != "" || gotThumbnail != "" {
		t.Fatalf("corrupt pair remained visible=(%q, %q)", gotOriginal, gotThumbnail)
	}
	for _, path := range []string{originalPath, thumbnailPath} {
		if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("invalidated cache file %q still exists: %v", path, statErr)
		}
	}
}

func TestPruneMediaCacheRemovesOriginalAndThumbnailTogether(t *testing.T) {
	dir := t.TempDir()
	c := &Client{mediaDir: dir}
	old := time.Now().Add(-time.Hour)
	for _, name := range []string{"old.jpg", "old.thumb.png", "new.jpg", "new.thumb.png"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("1234"), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now()
		if strings.HasPrefix(name, "old.") {
			stamp = old
		}
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	c.pruneMediaCache(8)
	for _, name := range []string{"old.jpg", "old.thumb.png"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("pruned pair member %q remains: %v", name, err)
		}
	}
	for _, name := range []string{"new.jpg", "new.thumb.png"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("new pair member %q was pruned: %v", name, err)
		}
	}
}

func TestPruneMediaCachePreservesPublishedAttachment(t *testing.T) {
	dir := t.TempDir()
	c := &Client{mediaDir: dir}
	preserveKey := strings.Repeat("a", 64)
	preserved := filepath.Join(dir, preserveKey+".pdf")
	other := filepath.Join(dir, strings.Repeat("b", 64)+".mp4")
	for _, path := range []string{preserved, other} {
		if err := os.WriteFile(path, []byte("12345678"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(preserved, old, old); err != nil {
		t.Fatal(err)
	}
	c.pruneMediaCacheExcept(8, preserveKey)
	if _, err := os.Stat(preserved); err != nil {
		t.Fatalf("published attachment was pruned: %v", err)
	}
	if _, err := os.Stat(other); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unprotected cache entry remains: %v", err)
	}
}

func TestDomainMessageDecodesRichContent(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	event := func(id string, message *waE2E.Message) *events.Message {
		return &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, ID: types.MessageID(id), Timestamp: time.UnixMilli(1234)}, Message: message}
	}
	tests := []struct {
		name    string
		message *events.Message
		check   func(domain.Message) bool
	}{
		{"video", event("video", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Caption: proto.String("clip"), Mimetype: proto.String("video/mp4"), DirectPath: proto.String("/video"), FileLength: proto.Uint64(11), Seconds: proto.Uint32(3)}}), func(m domain.Message) bool {
			return m.Kind == "video" && m.Attachment != nil && m.Attachment.Caption == "clip" && m.Attachment.DurationSeconds == 3
		}},
		{"voice", event("voice", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{Mimetype: proto.String("audio/ogg"), DirectPath: proto.String("/audio"), PTT: proto.Bool(true), Seconds: proto.Uint32(9)}}), func(m domain.Message) bool {
			return m.Kind == "audio" && m.Text == "🎤 Voice message" && m.Attachment != nil && m.Attachment.VoiceNote
		}},
		{"document", event("document", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{Mimetype: proto.String("application/pdf"), FileName: proto.String("notes.pdf"), FileLength: proto.Uint64(12)}}), func(m domain.Message) bool {
			return m.Kind == "document" && m.Text == "notes.pdf" && m.Attachment != nil && m.Attachment.FileName == "notes.pdf"
		}},
		{"contacts", event("contacts", &waE2E.Message{ContactsArrayMessage: &waE2E.ContactsArrayMessage{DisplayName: proto.String("Team"), Contacts: []*waE2E.ContactMessage{{DisplayName: proto.String("Alice"), Vcard: proto.String("VCARD")}}}}), func(m domain.Message) bool {
			return m.Kind == "contacts" && len(m.Contacts) == 1 && m.Contacts[0].DisplayName == "Alice"
		}},
		{"location", event("location", &waE2E.Message{LocationMessage: &waE2E.LocationMessage{DegreesLatitude: proto.Float64(12.9), DegreesLongitude: proto.Float64(77.5), Name: proto.String("Office"), Address: proto.String("Bengaluru")}}), func(m domain.Message) bool {
			return m.Kind == "location" && m.Location != nil && m.Location.Latitude == 12.9 && m.Location.Name == "Office"
		}},
		{"poll", event("poll", &waE2E.Message{PollCreationMessageV3: &waE2E.PollCreationMessage{Name: proto.String("Lunch"), Options: []*waE2E.PollCreationMessage_Option{{OptionName: proto.String("Pizza")}, {OptionName: proto.String("Sushi")}}}}), func(m domain.Message) bool {
			return m.Kind == "poll" && m.Text == "📊 Poll: Lunch\n• Pizza\n• Sushi"
		}},
		{"group invite", event("invite", &waE2E.Message{GroupInviteMessage: &waE2E.GroupInviteMessage{GroupName: proto.String("Friends")}}), func(m domain.Message) bool {
			return m.Kind == "group_invite" && m.Text == "👥 Group invite: Friends"
		}},
		{"event", event("event", &waE2E.Message{EventMessage: &waE2E.EventMessage{Name: proto.String("Standup")}}), func(m domain.Message) bool {
			return m.Kind == "event" && m.Text == "📅 Event: Standup"
		}},
		{"buttons response", event("buttons", &waE2E.Message{ButtonsResponseMessage: &waE2E.ButtonsResponseMessage{Response: &waE2E.ButtonsResponseMessage_SelectedDisplayText{SelectedDisplayText: "Yes"}}}), func(m domain.Message) bool {
			return m.Kind == "interactive" && m.Text == "Yes"
		}},
		{"list", event("list", &waE2E.Message{ListMessage: &waE2E.ListMessage{Title: proto.String("Menu"), Description: proto.String("Pick one")}}), func(m domain.Message) bool {
			return m.Kind == "interactive" && m.Text == "Menu\nPick one"
		}},
		{"order", event("order", &waE2E.Message{OrderMessage: &waE2E.OrderMessage{OrderTitle: proto.String("Groceries"), ItemCount: proto.Int32(3)}}), func(m domain.Message) bool {
			return m.Kind == "order" && m.Text == "🛒 Order: Groceries (3 items)"
		}},
		{"missed video call", event("call", &waE2E.Message{CallLogMesssage: &waE2E.CallLogMessage{IsVideo: proto.Bool(true), CallOutcome: waE2E.CallLogMessage_MISSED.Enum()}}), func(m domain.Message) bool {
			return m.Kind == "call" && m.Text == "Missed video call"
		}},
		{"album", event("album", &waE2E.Message{AlbumMessage: &waE2E.AlbumMessage{ExpectedImageCount: proto.Uint32(4)}}), func(m domain.Message) bool {
			return m.Kind == "album" && m.Text == "🖼️ Album (4 items)"
		}},
		{"disappearing timer", event("timer", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_EPHEMERAL_SETTING.Enum(), EphemeralExpiration: proto.Uint32(604800)}}), func(m domain.Message) bool {
			return m.Kind == "ephemeral_setting" && m.Text == "⏳ Disappearing messages set to 7 days"
		}},
		{"unknown type keeps descriptive label", event("placeholder", &waE2E.Message{PlaceholderMessage: &waE2E.PlaceholderMessage{}}), func(m domain.Message) bool {
			return m.Kind == "placeholder" && m.Text == "Placeholder"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := domainMessage(test.message, chat.String(), chat.String()); !test.check(got) {
				t.Fatalf("message=%+v", got)
			}
		})
	}
}

func TestDomainMessageExtractsEditedContent(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	edit := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type:          waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
		Key:           &waCommon.MessageKey{ID: proto.String("original")},
		TimestampMS:   proto.Int64(9999),
		EditedMessage: &waE2E.Message{Conversation: proto.String("corrected text")},
	}}
	evt := &events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, ID: "edit-event", Timestamp: time.UnixMilli(1234)},
		Message: edit,
		IsEdit:  true,
	}
	got := domainMessage(evt, chat.String(), chat.String())
	if got.ID != "original" || got.Text != "corrected text" || got.Kind != "text" {
		t.Fatalf("edited message=%+v", got)
	}
	if got.EditedAt.UnixMilli() != 9999 {
		t.Fatalf("edited_at=%v", got.EditedAt)
	}
}

func TestCanonicalMentionJIDsKeepsOnlyUserAddresses(t *testing.T) {
	got := canonicalMentionJIDs([]string{
		"15551234567@s.whatsapp.net",
		"15551234567:2@s.whatsapp.net", // device variant collapses into the first
		"203635027103105@lid",
		"123-456@g.us", // groups cannot be mentioned
		"not a jid",
		"",
	})
	want := []string{"15551234567@s.whatsapp.net", "203635027103105@lid"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("mentions=%v want=%v", got, want)
	}
}

func TestPassiveMessageFiltersSignalOnlyPayloads(t *testing.T) {
	passive := []*waE2E.Message{
		{PollUpdateMessage: &waE2E.PollUpdateMessage{}},
		{EncReactionMessage: &waE2E.EncReactionMessage{}},
		{StickerSyncRmrMessage: &waE2E.StickerSyncRMRMessage{}},
		{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_APP_STATE_SYNC_KEY_SHARE.Enum()}},
		{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE.Enum()}},
		{SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{}},
		nil,
	}
	for i, message := range passive {
		if !passiveMessage(message) {
			t.Fatalf("payload %d should be passive: %+v", i, message)
		}
	}
	displayable := []*waE2E.Message{
		{Conversation: proto.String("hi")},
		{ImageMessage: &waE2E.ImageMessage{}},
		{PollCreationMessage: &waE2E.PollCreationMessage{Name: proto.String("Lunch")}},
		{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: proto.String("x")}}},
		{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_EPHEMERAL_SETTING.Enum()}},
	}
	for i, message := range displayable {
		if passiveMessage(message) {
			t.Fatalf("payload %d should be displayable: %+v", i, message)
		}
	}
}

func TestHistoryAggregateReactionsTargetContainingMessage(t *testing.T) {
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	timestamp := time.UnixMilli(1234)
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat},
			ID:            types.MessageID("target"),
			Timestamp:     timestamp,
		},
		SourceWebMsg: &waWeb.WebMessageInfo{Reactions: []*waWeb.Reaction{{
			Key:               &waCommon.MessageKey{Participant: proto.String(sender.String())},
			Text:              proto.String("❤️"),
			SenderTimestampMS: proto.Int64(timestamp.UnixMilli()),
		}}},
	}
	c := &Client{log: slog.Default()}
	reactions := c.historyAggregateReactions(evt)
	if len(reactions) != 1 || reactions[0].MessageID != "target" || reactions[0].SenderJID != sender.String() || reactions[0].Emoji != "❤️" {
		t.Fatalf("reactions=%+v", reactions)
	}
}

func TestStaleLiveReactionIsNotEmitted(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	chat, _ := types.ParseJID("123@g.us")
	sender, _ := types.ParseJID("456@s.whatsapp.net")
	var emitted []Event
	c := &Client{ctx: ctx, store: productStore, sink: func(event Event) { emitted = append(emitted, event) }, log: slog.Default()}
	event := func(emoji string, timestamp time.Time) *events.Message {
		return &events.Message{
			Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender}, Timestamp: timestamp},
			Message: &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
				Key:               &waCommon.MessageKey{ID: proto.String("target")},
				Text:              proto.String(emoji),
				SenderTimestampMS: proto.Int64(timestamp.UnixMilli()),
			}},
		}
	}
	c.reduceMessage(event("👍", time.UnixMilli(2000)), true)
	c.reduceMessage(event("👎", time.UnixMilli(1000)), true)
	if len(emitted) != 1 || emitted[0].Reaction.Emoji != "👍" {
		t.Fatalf("emitted=%+v", emitted)
	}
}

func TestPeerReplayResponseEnvelopeIsNotPersistedAsChatMessage(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	chat, _ := types.ParseJID("123@s.whatsapp.net")
	protocolType := waE2E.ProtocolMessage_PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: chat, IsFromMe: true},
			ID:            types.MessageID("peer-envelope"),
			Timestamp:     time.Now(),
			Category:      "peer",
		},
		Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: &protocolType}},
	}
	c := &Client{ctx: ctx, store: productStore, sink: func(Event) {}, log: slog.Default()}
	c.reduceMessage(evt, true)
	page, err := productStore.Messages(ctx, chat.String(), "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("peer response persisted: %+v", page.Items)
	}
}

func seedPrivateMessage(t *testing.T, ctx context.Context, s *store.Store) {
	t.Helper()
	if err := s.ApplyMessage(ctx, domain.Message{ID: "private", ChatJID: "old@g.us", SenderJID: "old@s.whatsapp.net", Text: "secret", Timestamp: time.Now()}, true); err != nil {
		t.Fatal(err)
	}
}

func TestEnqueueUnblocksWhenReducerStops(t *testing.T) {
	c := &Client{ctx: context.Background(), reducer: make(chan func(), 1), reducerDone: make(chan struct{})}
	c.accepting.Store(true)
	c.reducer <- func() {}
	returned := make(chan struct{})
	go func() { c.enqueue(func() {}); close(returned) }()
	close(c.reducerDone)
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("enqueue remained blocked during shutdown")
	}
}

func TestReducerGenerationDropsOldAccountTasks(t *testing.T) {
	c := &Client{ctx: context.Background(), reducer: make(chan func(), 1), reducerDone: make(chan struct{})}
	c.accepting.Store(true)
	ran := false
	c.enqueue(func() { ran = true })
	c.accepting.Store(false)
	c.generation.Add(1)
	task := <-c.reducer
	task()
	if ran {
		t.Fatal("old account reducer task ran after generation invalidation")
	}
}

func TestHistorySyncDoesNotFloodChatEvents(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	var emitted []Event
	c := &Client{ctx: ctx, store: productStore, sink: func(event Event) { emitted = append(emitted, event) }, log: slog.Default()}
	conversations := make([]*waHistorySync.Conversation, 1000)
	for i := range conversations {
		conversations[i] = &waHistorySync.Conversation{ID: proto.String("123@g.us"), Archived: proto.Bool(true)}
	}
	c.reduceHistory(&events.HistorySync{Data: &waHistorySync.HistorySync{Conversations: conversations, Progress: proto.Uint32(100)}})
	if len(emitted) != 1 || emitted[0].Kind != "sync" || !emitted[0].Complete {
		t.Fatalf("history emitted %d events: %+v", len(emitted), emitted)
	}
	chat, err := productStore.Chat(ctx, "123@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if !chat.Archived {
		t.Fatal("history archive metadata was not persisted")
	}
}

func TestArchiveEventUpdatesChatAndEmitsIt(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	var emitted []Event
	c := &Client{ctx: ctx, store: productStore, sink: func(event Event) { emitted = append(emitted, event) }, log: slog.Default()}
	c.reduceArchive(&events.Archive{
		JID:    types.NewJID("123", types.GroupServer),
		Action: &waSyncAction.ArchiveChatAction{Archived: proto.Bool(true)},
	})
	chat, err := productStore.Chat(ctx, "123@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if !chat.Archived {
		t.Fatal("archive event was not persisted")
	}
	if len(emitted) != 1 || emitted[0].Kind != "chat" || !emitted[0].Chat.Archived {
		t.Fatalf("archive emitted %+v", emitted)
	}
	// On-demand history pages omit conversation-level metadata. Absence must not
	// be interpreted as an authoritative unarchive.
	c.reduceHistory(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType:      waHistorySync.HistorySync_ON_DEMAND.Enum(),
		Conversations: []*waHistorySync.Conversation{{ID: proto.String("123@g.us")}},
	}})
	chat, err = productStore.Chat(ctx, "123@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if !chat.Archived {
		t.Fatal("sparse history cleared the archive state")
	}
}

func TestCrossDeviceReadReceiptClearsOnlyReferencedUnreadMessages(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	for i := 0; i < 2; i++ {
		message := domain.Message{ID: fmt.Sprintf("m%d", i), ChatJID: "123@g.us", TransportJID: "123@g.us", SenderJID: "456@s.whatsapp.net", Timestamp: time.Unix(int64(i+1), 0)}
		if err = productStore.ApplyMessage(ctx, message, true); err != nil {
			t.Fatal(err)
		}
	}
	var emitted []Event
	c := &Client{ctx: ctx, store: productStore, sink: func(event Event) { emitted = append(emitted, event) }, log: slog.Default()}
	c.reduceReceipt(&events.Receipt{
		MessageSource: types.MessageSource{Chat: types.NewJID("123", types.GroupServer), IsFromMe: true},
		MessageIDs:    []types.MessageID{"m0"},
		Type:          types.ReceiptTypeRead,
	})
	chat, err := productStore.Chat(ctx, "123@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if chat.UnreadCount != 1 {
		t.Fatalf("unread=%d want 1", chat.UnreadCount)
	}
	if len(emitted) != 1 || emitted[0].Kind != "chat" || emitted[0].Chat.UnreadCount != 1 {
		t.Fatalf("emitted=%+v", emitted)
	}
}

func TestMarkChatAsReadEventPreservesNewerUnreadMessages(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	for i := 0; i < 3; i++ {
		message := domain.Message{ID: fmt.Sprintf("m%d", i), ChatJID: "123@g.us", TransportJID: "123@g.us", SenderJID: "456@s.whatsapp.net", Timestamp: time.Unix(int64(i+1), 0)}
		if err = productStore.ApplyMessage(ctx, message, true); err != nil {
			t.Fatal(err)
		}
	}
	c := &Client{ctx: ctx, store: productStore, sink: func(Event) {}, log: slog.Default()}
	c.reduceMarkChatAsRead(&events.MarkChatAsRead{
		JID: types.NewJID("123", types.GroupServer),
		Action: &waSyncAction.MarkChatAsReadAction{
			Read: proto.Bool(true),
			MessageRange: &waSyncAction.SyncActionMessageRange{
				LastMessageTimestamp: proto.Int64(2),
				Messages: []*waSyncAction.SyncActionMessage{{
					Key:       &waCommon.MessageKey{ID: proto.String("m1")},
					Timestamp: proto.Int64(2),
				}},
			},
		},
	})
	chat, err := productStore.Chat(ctx, "123@g.us")
	if err != nil {
		t.Fatal(err)
	}
	if chat.UnreadCount != 1 {
		t.Fatalf("unread=%d want 1", chat.UnreadCount)
	}
}

func TestChatStateProjectionRetriesThenRunsOnlyOncePerProcess(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	c := &Client{
		ctx:         ctx,
		store:       productStore,
		log:         slog.Default(),
		reducer:     make(chan func(), 4),
		reducerDone: make(chan struct{}),
	}
	stop := startTestReducer(c)
	defer stop()
	attempts := 0
	c.fetchAppStateFn = func(context.Context, appstate.WAPatchName, bool, bool) error {
		attempts++
		if attempts == 1 {
			return errors.New("temporary projection failure")
		}
		return nil
	}
	c.reconcileChatState()
	if c.projectionComplete {
		t.Fatal("failed projection was marked complete")
	}
	c.reconcileChatState()
	if !c.projectionComplete {
		t.Fatal("successful projection was not marked complete")
	}
	c.reconcileChatState()
	if attempts != 2 {
		t.Fatalf("attempts=%d want 2", attempts)
	}
}

func TestLogoutAlreadyRemoteLoggedOutStillClearsLocalData(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	seedPrivateMessage(t, ctx, productStore)
	c := &Client{ctx: ctx, store: productStore, reducer: make(chan func(), 4), reducerDone: make(chan struct{}), logoutFn: func(context.Context) error { return whatsmeow.ErrNotLoggedIn }, clearAccountDataFn: productStore.ClearAccountData}
	c.accepting.Store(true)
	cleanup := startTestReducer(c)
	defer cleanup()
	if err = c.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	count, err := productStore.ChatCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("retained %d chats", count)
	}
	if !c.accepting.Load() {
		t.Fatal("future pairing remained disabled")
	}
}

func TestLogoutRetryClearsAfterRemoteSuccessLocalFailure(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()
	seedPrivateMessage(t, ctx, productStore)
	remoteCalls, clearCalls := 0, 0
	c := &Client{ctx: ctx, store: productStore, reducer: make(chan func(), 4), reducerDone: make(chan struct{})}
	c.accepting.Store(true)
	cleanup := startTestReducer(c)
	defer cleanup()
	c.logoutFn = func(context.Context) error {
		remoteCalls++
		if remoteCalls == 1 {
			return nil
		}
		return whatsmeow.ErrNotLoggedIn
	}
	c.clearAccountDataFn = func(clearCtx context.Context) error {
		clearCalls++
		if clearCalls == 1 {
			return errors.New("disk full")
		}
		return productStore.ClearAccountData(clearCtx)
	}
	err = c.Logout(ctx)
	var logoutErr *LogoutError
	if !errors.As(err, &logoutErr) || logoutErr.Stage != "local_clear" {
		t.Fatalf("first error=%v", err)
	}
	if c.accepting.Load() {
		t.Fatal("admission enabled after failed privacy clear")
	}
	if err = c.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	count, err := productStore.ChatCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("retry retained %d chats", count)
	}
	if !c.accepting.Load() {
		t.Fatal("admission not restored after successful retry")
	}
}

func TestMergeContactInfoPreservesSavedNamesAndFillsRemoteFields(t *testing.T) {
	got := mergeContactInfo(
		types.ContactInfo{Found: true, FullName: "Saved Name"},
		types.ContactInfo{FirstName: "Remote", FullName: "Remote Name", PushName: "Push", BusinessName: "Business", RedactedPhone: "+91••••42"},
	)
	if got.FullName != "Saved Name" || got.FirstName != "Remote" || got.PushName != "Push" || got.BusinessName != "Business" || got.RedactedPhone != "+91••••42" {
		t.Fatalf("unexpected merge: %+v", got)
	}
}

func TestValidateAvatarURLRequiresHTTPS(t *testing.T) {
	for _, invalid := range []string{"http://example.com/a.jpg", "file:///tmp/a.jpg", "not a URL"} {
		if validateAvatarURL(invalid) == nil {
			t.Fatalf("accepted unsafe URL %q", invalid)
		}
	}
	if err := validateAvatarURL("https://example.com/a.jpg"); err != nil {
		t.Fatal(err)
	}
}
