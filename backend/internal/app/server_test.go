package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
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
			Body: &bridgev1.Envelope_Request{Request: &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_GetMessageAttachment{
				GetMessageAttachment: &bridgev1.GetMessageAttachmentRequest{ChatId: "blocked-media", MessageId: "attachment"},
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

func TestMediaJobAdmissionIsBounded(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := New(ctx, cancel, nil, nil)

	for i := 0; i < maxMediaJobsInFlight; i++ {
		if !s.tryAcquireMediaJob() {
			t.Fatalf("media job %d rejected before the documented limit", i)
		}
	}
	if s.tryAcquireMediaJob() {
		t.Fatalf("media job admitted above limit %d", maxMediaJobsInFlight)
	}
	if got := len(s.mediaJobs); got != maxMediaJobsInFlight {
		t.Fatalf("in-flight media jobs=%d, want %d", got, maxMediaJobsInFlight)
	}

	s.releaseMediaJob()
	if !s.tryAcquireMediaJob() {
		t.Fatal("released media capacity was not reusable")
	}
}

func TestLogoutWaitsForActiveMediaJob(t *testing.T) {
	ctx := context.Background()
	s := &Server{ctx: ctx, mediaSlots: make(chan struct{}, 2)}
	jobDone := make(chan struct{})
	s.mediaWG.Add(1)
	go func() {
		defer s.mediaWG.Done()
		<-jobDone
	}()
	invoked := make(chan struct{}, 1)
	s.logoutFn = func(context.Context) error {
		invoked <- struct{}{}
		return nil
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.dispatch(&bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_Logout{Logout: &bridgev1.LogoutRequest{}}})
		done <- err
	}()

	select {
	case <-invoked:
		t.Fatal("logout ran while a media slot was still occupied")
	case <-time.After(50 * time.Millisecond):
	}
	close(jobDone)
	select {
	case <-invoked:
	case <-time.After(2 * time.Second):
		t.Fatal("logout did not run after the media operation finished")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestLogoutWaitsForMediaJobQueuedOutsideSlots(t *testing.T) {
	ctx := context.Background()
	s := &Server{ctx: ctx, mediaSlots: make(chan struct{}, 1)}
	// Fill capacity, then register a media job before launching it, exactly as
	// Run does. The job is tracked even while it is queued outside mediaSlots.
	s.mediaSlots <- struct{}{}
	finish := make(chan struct{})
	started := make(chan struct{})
	s.mediaWG.Add(1)
	go func() {
		defer s.mediaWG.Done()
		s.mediaSlots <- struct{}{}
		close(started)
		<-finish
		<-s.mediaSlots
	}()
	invoked := make(chan struct{}, 1)
	s.logoutFn = func(context.Context) error {
		invoked <- struct{}{}
		return nil
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.dispatch(&bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_Logout{Logout: &bridgev1.LogoutRequest{}}})
		done <- err
	}()

	select {
	case <-invoked:
		t.Fatal("logout ran while a media job was queued")
	case <-time.After(50 * time.Millisecond):
	}
	<-s.mediaSlots
	<-started
	select {
	case <-invoked:
		t.Fatal("logout ran while the queued media job was active")
	case <-time.After(50 * time.Millisecond):
	}
	close(finish)
	select {
	case <-invoked:
	case <-time.After(2 * time.Second):
		t.Fatal("logout did not run after queued media completed")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestLogoutMediaWaitCancellationReturnsIsolationError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{ctx: ctx, mediaSlots: make(chan struct{}, 2), logoutFn: func(context.Context) error {
		t.Fatal("logout ran after isolation cancellation")
		return nil
	}}
	s.mediaWG.Add(1)
	done := make(chan error, 1)
	go func() {
		_, err := s.dispatch(&bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_Logout{Logout: &bridgev1.LogoutRequest{}}})
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	err := <-done
	var logoutErr *wa.LogoutError
	if !errors.As(err, &logoutErr) || logoutErr.Stage != "isolation" {
		t.Fatalf("error=%v, want logout isolation error", err)
	}
	s.mediaWG.Done()
}

func TestAttachmentRequestValidation(t *testing.T) {
	s := &Server{ctx: context.Background()}
	validID := "b0bca7f5-a85f-4a8c-8956-1722cf35ffbc"
	tests := []struct {
		name    string
		request *bridgev1.RpcRequest
	}{
		{"missing required fields", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendAttachment{SendAttachment: &bridgev1.SendAttachmentRequest{}}}},
		{"invalid client ID", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendAttachment{SendAttachment: &bridgev1.SendAttachmentRequest{ClientMessageId: "not-a-uuid", ChatId: "chat", FilePath: "/file", Kind: bridgev1.AttachmentKind_ATTACHMENT_KIND_DOCUMENT}}}},
		{"unspecified kind", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendAttachment{SendAttachment: &bridgev1.SendAttachmentRequest{ClientMessageId: validID, ChatId: "chat", FilePath: "/file"}}}},
		{"audio caption", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendAttachment{SendAttachment: &bridgev1.SendAttachmentRequest{ClientMessageId: validID, ChatId: "chat", FilePath: "/file", Kind: bridgev1.AttachmentKind_ATTACHMENT_KIND_AUDIO, Caption: "unsupported"}}}},
		{"document voice note", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendAttachment{SendAttachment: &bridgev1.SendAttachmentRequest{ClientMessageId: validID, ChatId: "chat", FilePath: "/file", Kind: bridgev1.AttachmentKind_ATTACHMENT_KIND_DOCUMENT, VoiceNote: true}}}},
		{"invalid caption UTF-8", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendAttachment{SendAttachment: &bridgev1.SendAttachmentRequest{ClientMessageId: validID, ChatId: "chat", FilePath: "/file", Kind: bridgev1.AttachmentKind_ATTACHMENT_KIND_DOCUMENT, Caption: string([]byte{0xff})}}}},
		{"missing attachment message", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_GetMessageAttachment{GetMessageAttachment: &bridgev1.GetMessageAttachmentRequest{ChatId: "chat"}}}},
		{"missing sticker library fields", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendStickerFromLibrary{SendStickerFromLibrary: &bridgev1.SendStickerFromLibraryRequest{}}}},
		{"sticker library invalid client ID", &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_SendStickerFromLibrary{SendStickerFromLibrary: &bridgev1.SendStickerFromLibraryRequest{ClientMessageId: "not-a-uuid", ChatId: "chat", StickerId: "abc"}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := s.dispatch(test.request)
			var failure *rpcFailure
			if !errors.As(err, &failure) || failure.code != "invalid_argument" {
				t.Fatalf("error=%v, want invalid_argument", err)
			}
		})
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

func TestWireTextMessageIncludesLinkPreview(t *testing.T) {
	message := wireMessage(domain.Message{Kind: "text", Text: "https://example.com", LinkPreview: &domain.LinkPreview{
		URL: "https://example.com", Title: "Example", Description: "Preview", JPEGThumbnail: []byte{1, 2}, ThumbnailWidth: 320, ThumbnailHeight: 180,
	}})
	preview := message.GetText().GetLinkPreview()
	if preview == nil || preview.GetUrl() != "https://example.com" || preview.GetTitle() != "Example" || preview.GetThumbnailWidth() != 320 || string(preview.GetJpegThumbnail()) != "\x01\x02" {
		t.Fatalf("preview=%+v", preview)
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
	poll := wireMessage(domain.Message{Kind: "poll", Poll: &domain.Poll{Question: "Lunch?", SelectableOptionsCount: 1, TotalVoters: 2, Options: []domain.PollOption{{Name: "Pizza", VoteCount: 2, SelectedByMe: true}, {Name: "Sushi"}}}}).GetPoll()
	if poll == nil || poll.GetQuestion() != "Lunch?" || poll.GetTotalVoters() != 2 || len(poll.GetOptions()) != 2 || !poll.GetOptions()[0].GetSelectedByMe() {
		t.Fatalf("poll=%+v", poll)
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
