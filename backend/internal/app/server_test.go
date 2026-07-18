package app

import (
	"context"
	"testing"

	bridgev1 "github.com/rust-meow/rust-meow/backend/gen/bridgev1"
	"github.com/rust-meow/rust-meow/backend/internal/domain"
)

func TestHandshakeRequired(t *testing.T) {
	s := &Server{ctx: context.Background()}
	request := &bridgev1.Envelope{ProtocolVersion: 1, Body: &bridgev1.Envelope_Request{Request: &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_ListChats{ListChats: &bridgev1.ListChatsRequest{}}}}}
	response, terminate := s.handle(request)
	if terminate {
		t.Fatal("must allow retrying handshake")
	}
	if got := response.GetError().GetCode(); got != "handshake_required" {
		t.Fatalf("code=%q", got)
	}
}

func TestWireMessageIncludesImageMetadata(t *testing.T) {
	message := wireMessage(domain.Message{
		ID: "image-1", ChatJID: "c@g.us", Kind: "image",
		Image: &domain.Image{Caption: "cat", MIMEType: "image/jpeg", LocalPath: "/cache/cat.jpg", Width: 640, Height: 480, FileSize: 99},
	})
	image := message.GetImage()
	if image == nil || image.GetCaption() != "cat" || image.GetLocalPath() != "/cache/cat.jpg" || !image.GetDownloadable() {
		t.Fatalf("image=%+v", image)
	}
}

func TestWireMessageIncludesReplyTarget(t *testing.T) {
	message := wireMessage(domain.Message{ID: "reply", ChatJID: "chat", Kind: "text", Text: "yes", ReplyToID: "original"})
	if message.GetReplyToMessageId() != "original" {
		t.Fatalf("reply target=%q", message.GetReplyToMessageId())
	}
}

func TestWireLegacyImageCanRequestDescriptorRepair(t *testing.T) {
	message := wireMessage(domain.Message{ID: "old-image", ChatJID: "c@g.us", Kind: "image", Image: &domain.Image{}})
	if message.GetImage() == nil || !message.GetImage().GetDownloadable() {
		t.Fatalf("message=%+v", message)
	}
}

func TestWireRichMessageContent(t *testing.T) {
	sticker := wireMessage(domain.Message{Kind: "sticker", Image: &domain.Image{MIMEType: "image/webp", Animated: true}}).GetImage()
	if sticker == nil || !sticker.GetSticker() || !sticker.GetAnimated() {
		t.Fatalf("sticker=%+v", sticker)
	}
	attachment := wireMessage(domain.Message{Kind: "audio", Attachment: &domain.Attachment{MIMEType: "audio/ogg", DurationSeconds: 9, VoiceNote: true}}).GetAttachment()
	if attachment == nil || attachment.GetKind() != "audio" || attachment.GetDurationSeconds() != 9 || !attachment.GetVoiceNote() {
		t.Fatalf("attachment=%+v", attachment)
	}
	contacts := wireMessage(domain.Message{Kind: "contact", Contacts: []domain.Contact{{DisplayName: "Alice", VCard: "VCARD"}}}).GetContacts()
	if contacts == nil || len(contacts.GetContacts()) != 1 || contacts.GetContacts()[0].GetDisplayName() != "Alice" {
		t.Fatalf("contacts=%+v", contacts)
	}
	location := wireMessage(domain.Message{Kind: "location", Location: &domain.Location{Latitude: 12.9, Longitude: 77.5, Name: "Office"}}).GetLocation()
	if location == nil || location.GetLatitude() != 12.9 || location.GetName() != "Office" {
		t.Fatalf("location=%+v", location)
	}
}

func TestReplaceMentionIDsPreservesRawIDsUnlessResolved(t *testing.T) {
	text := "hello @200201394507780 and @919999890760, not x@12345 or @1234"
	got := replaceMentionIDs(text, func(user string) string {
		if user == "200201394507780" {
			return "Divyam Agrawal"
		}
		return ""
	})
	want := "hello @Divyam Agrawal and @919999890760, not x@12345 or @1234"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestReplaceMentionIDsHandlesAdjacentResolvedMentions(t *testing.T) {
	got := replaceMentionIDs("@11111/@22222", func(user string) string { return "user-" + user })
	if got != "@user-11111/@user-22222" {
		t.Fatalf("got %q", got)
	}
}

func TestWireMessageDetectsGroupFromTransportJIDWithOpaqueChatID(t *testing.T) {
	s := &Server{ctx: context.Background()}
	message := s.wireMessageWithIdentities(domain.Message{
		ID: "message-1", ChatJID: "c:3206f303-c2a4-4ffd-a5da-891efdfc1c85", TransportJID: "123@g.us",
		SenderJID: "456@s.whatsapp.net", FromMe: true, Kind: "text", Text: "hello",
	}, nil)
	if message.GetSenderName() != "You" {
		t.Fatalf("sender name=%q; opaque group chat was not recognized", message.GetSenderName())
	}
}

func TestUnsupportedHandshakeTerminates(t *testing.T) {
	s := &Server{ctx: context.Background()}
	request := &bridgev1.Envelope{Body: &bridgev1.Envelope_Request{Request: &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_Hello{Hello: &bridgev1.HelloRequest{MinimumProtocolVersion: ProtocolVersion + 1, MaximumProtocolVersion: ProtocolVersion + 1}}}}}
	response, terminate := s.handle(request)
	if !terminate {
		t.Fatal("must terminate")
	}
	if got := response.GetError().GetCode(); got != "unsupported_protocol" {
		t.Fatalf("code=%q", got)
	}
}

func TestSuccessfulHelloDoesNotEnableEventsBeforeResponseWrite(t *testing.T) {
	s := &Server{ctx: context.Background()}
	request := &bridgev1.Envelope{Body: &bridgev1.Envelope_Request{Request: &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_Hello{Hello: &bridgev1.HelloRequest{MinimumProtocolVersion: ProtocolVersion, MaximumProtocolVersion: ProtocolVersion}}}}}
	response, terminate := s.handle(request)
	if terminate || response.GetHello() == nil {
		t.Fatalf("response=%v terminate=%v", response, terminate)
	}
	if s.handshaken.Load() {
		t.Fatal("events enabled before Run writes Hello response")
	}
}

func TestValidReactionEmoji(t *testing.T) {
	for _, emoji := range []string{"", "👍", "👍🏽", "❤️", "👨‍👩‍👧‍👦", "🇮🇳", "1️⃣"} {
		if !validReactionEmoji(emoji) {
			t.Errorf("validReactionEmoji(%q)=false", emoji)
		}
	}
	for _, value := range []string{"hello", "👍 👎", "👍👎", " ", string([]byte{0xff})} {
		if validReactionEmoji(value) {
			t.Errorf("validReactionEmoji(%q)=true", value)
		}
	}
}
