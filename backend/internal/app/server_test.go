package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"testing"
	"time"

	bridgev1 "github.com/rust-meow/rust-meow/backend/gen/bridgev1"
	"github.com/rust-meow/rust-meow/backend/internal/bridge"
	"github.com/rust-meow/rust-meow/backend/internal/domain"
	"github.com/rust-meow/rust-meow/backend/internal/wa"
	"google.golang.org/protobuf/proto"
)

func decodeEnvelopes(t *testing.T, data []byte) []*bridgev1.Envelope {
	t.Helper()
	var envelopes []*bridgev1.Envelope
	for len(data) > 0 {
		if len(data) < 4 {
			t.Fatalf("truncated frame header: %d bytes", len(data))
		}
		size := int(binary.BigEndian.Uint32(data[:4]))
		data = data[4:]
		if size == 0 || size > len(data) {
			t.Fatalf("invalid frame size %d with %d bytes remaining", size, len(data))
		}
		envelope := new(bridgev1.Envelope)
		if err := proto.Unmarshal(data[:size], envelope); err != nil {
			t.Fatalf("decode envelope: %v", err)
		}
		envelopes = append(envelopes, envelope)
		data = data[size:]
	}
	return envelopes
}

func TestMediaCapacityDoesNotBlockNonMediaRequest(t *testing.T) {
	var requests bytes.Buffer
	requestCodec := bridge.NewCodec(nil, &requests)
	for _, envelope := range []*bridgev1.Envelope{
		{
			ProtocolVersion: ProtocolVersion,
			RequestId:       1,
			Body: &bridgev1.Envelope_Request{Request: &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_GetChatAvatar{
				GetChatAvatar: &bridgev1.GetChatAvatarRequest{ChatId: "blocked-media"},
			}}},
		},
		{
			ProtocolVersion: ProtocolVersion,
			RequestId:       2,
			Body: &bridgev1.Envelope_Request{Request: &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendText{
				SendText: &bridgev1.SendTextRequest{},
			}}},
		},
	} {
		if err := requestCodec.Write(envelope); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var responses bytes.Buffer
	s := New(ctx, cancel, bridge.NewCodec(&requests, &responses), nil)
	s.handshaken.Store(true)
	for range cap(s.mediaSlots) {
		s.mediaSlots <- struct{}{}
	}

	done := make(chan error, 1)
	go func() { done <- s.Run() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-done
		t.Fatal("request loop remained blocked behind exhausted media capacity")
	}

	envelopes := decodeEnvelopes(t, responses.Bytes())
	if len(envelopes) != 1 {
		t.Fatalf("responses=%d, want 1 non-media response", len(envelopes))
	}
	if got := envelopes[0].GetRequestId(); got != 2 {
		t.Fatalf("request_id=%d, want 2", got)
	}
	if got := envelopes[0].GetResponse().GetError().GetCode(); got != "invalid_argument" {
		t.Fatalf("error code=%q, want invalid_argument", got)
	}
}

func TestUnsupportedEventDoesNotConsumeSequence(t *testing.T) {
	var output bytes.Buffer
	s := &Server{ctx: context.Background(), codec: bridge.NewCodec(nil, &output)}
	s.handshaken.Store(true)

	s.Emit(wa.Event{Kind: "future_event"})
	if got := s.sequence.Load(); got != 0 {
		t.Fatalf("sequence after unsupported event=%d, want 0", got)
	}
	s.Emit(wa.Event{Kind: "connection", Detail: "connected"})

	envelopes := decodeEnvelopes(t, output.Bytes())
	if len(envelopes) != 1 {
		t.Fatalf("events=%d, want 1", len(envelopes))
	}
	event := envelopes[0].GetEvent()
	if got := event.GetSequence(); got != 1 {
		t.Fatalf("sequence=%d, want 1", got)
	}
	if event.GetConnectionChanged() == nil {
		t.Fatalf("event=%v, want connection_changed", event)
	}
}

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
