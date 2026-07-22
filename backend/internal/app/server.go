package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/rivo/uniseg"
	bridgev1 "github.com/rust-meow/rust-meow/backend/gen/bridgev1"
	"github.com/rust-meow/rust-meow/backend/internal/bridge"
	"github.com/rust-meow/rust-meow/backend/internal/domain"
	searchutil "github.com/rust-meow/rust-meow/backend/internal/search"
	"github.com/rust-meow/rust-meow/backend/internal/store"
	"github.com/rust-meow/rust-meow/backend/internal/wa"
	"go.mau.fi/whatsmeow/types"
)

const ProtocolVersion uint32 = 14
const maxTextBytes = 65_536

type Server struct {
	ctx        context.Context
	cancel     context.CancelFunc
	codec      *bridge.Codec
	store      *store.Store
	wa         *wa.Client
	sequence   atomic.Uint64
	shutdown   atomic.Bool
	handshaken atomic.Bool
	eventMu    sync.Mutex
	mediaSlots chan struct{}
	mediaWG    sync.WaitGroup
	logoutFn   func(context.Context) error
}
type rpcFailure struct {
	code, message string
	retryable     bool
}

func (e *rpcFailure) Error() string { return e.message }
func fail(code, message string, retryable bool) error {
	return &rpcFailure{code: code, message: message, retryable: retryable}
}

func (s *Server) validateReplyTarget(chatID, messageID string) error {
	if messageID == "" {
		return nil
	}
	if _, err := s.store.Message(s.ctx, chatID, messageID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fail("invalid_argument", "reply target was not found in this chat", false)
		}
		return err
	}
	return nil
}

func New(ctx context.Context, cancel context.CancelFunc, codec *bridge.Codec, store *store.Store) *Server {
	return &Server{ctx: ctx, cancel: cancel, codec: codec, store: store, mediaSlots: make(chan struct{}, 4)}
}
func (s *Server) SetWhatsApp(client *wa.Client) {
	s.wa = client
	s.logoutFn = client.Logout
}

func usesMediaSlot(request *bridgev1.RpcRequest) bool {
	return request.GetGetChatAvatar() != nil || request.GetGetParticipantAvatar() != nil ||
		request.GetGetMessageImage() != nil || request.GetSendImage() != nil || request.GetSendSticker() != nil ||
		request.GetGetChatInfo() != nil || request.GetGetMessageAttachment() != nil || request.GetSendAttachment() != nil
}

func (s *Server) waitForMediaJobs(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		s.mediaWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) Run() error {
	for {
		envelope, err := s.codec.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		request := envelope.GetRequest()
		// GetChatInfo joins the media pool because group and about lookups are
		// network round-trips that must not stall the serialized RPC loop.
		if s.handshaken.Load() && envelope.GetProtocolVersion() == ProtocolVersion && usesMediaSlot(request) {
			s.mediaWG.Add(1)
			go func(envelope *bridgev1.Envelope) {
				defer s.mediaWG.Done()
				select {
				case s.mediaSlots <- struct{}{}:
				case <-s.ctx.Done():
					return
				}
				defer func() { <-s.mediaSlots }()
				response, _ := s.handle(envelope)
				_ = s.codec.Write(&bridgev1.Envelope{ProtocolVersion: ProtocolVersion, RequestId: envelope.GetRequestId(), Body: &bridgev1.Envelope_Response{Response: response}})
			}(envelope)
			continue
		}
		response, terminate := s.handle(envelope)
		if err = s.codec.Write(&bridgev1.Envelope{ProtocolVersion: ProtocolVersion, RequestId: envelope.GetRequestId(), Body: &bridgev1.Envelope_Response{Response: response}}); err != nil {
			return err
		}
		// Events become eligible only after the correlated Hello response is fully written.
		if response.GetHello() != nil {
			s.handshaken.Store(true)
		}
		if terminate || s.shutdown.Load() {
			s.cancel()
			return nil
		}
	}
}

func (s *Server) Emit(event wa.Event) {
	if !s.handshaken.Load() {
		return
	}
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	body := &bridgev1.BackendEvent{}
	switch event.Kind {
	case "connection":
		body.Event = &bridgev1.BackendEvent_ConnectionChanged{ConnectionChanged: &bridgev1.ConnectionChanged{State: connectionState(event.Detail), Detail: event.Detail}}
	case "qr":
		body.Event = &bridgev1.BackendEvent_PairingQr{PairingQr: &bridgev1.PairingQr{Code: event.QR, ExpiresAtMs: event.QRExpires.UnixMilli()}}
	case "sync":
		body.Event = &bridgev1.BackendEvent_SyncProgress{SyncProgress: &bridgev1.SyncProgress{ChatsProcessed: event.ChatsProcessed, MessagesProcessed: event.MessagesProcessed, Complete: event.Complete}}
	case "message":
		body.Event = &bridgev1.BackendEvent_MessageUpserted{MessageUpserted: &bridgev1.MessageUpserted{Message: s.wireMessage(event.Message)}}
	case "reaction":
		body.Event = &bridgev1.BackendEvent_ReactionUpdated{ReactionUpdated: &bridgev1.ReactionUpdated{Reaction: s.wireReaction(event.Reaction), Removed: event.Reaction.Emoji == ""}}
	case "reaction_repair":
		body.Event = &bridgev1.BackendEvent_RecentReactionsRepaired{RecentReactionsRepaired: &bridgev1.RecentReactionsRepaired{ChatId: event.ChatJID, RecoveredReactions: event.RecoveredReactions, Complete: event.RepairComplete}}
	case "chat":
		body.Event = &bridgev1.BackendEvent_ChatUpserted{ChatUpserted: &bridgev1.ChatUpserted{Chat: s.wireChat(event.Chat)}}
	case "chat_merge":
		body.Event = &bridgev1.BackendEvent_ChatMerged{ChatMerged: &bridgev1.ChatMerged{OldChatId: event.OldChatJID, NewChatId: event.ChatJID}}
	case "typing":
		var senderName string
		if s.wa != nil && event.SenderJID != "" {
			details := s.wa.ContactDetails(s.ctx, event.SenderJID)
			for _, candidate := range []string{details.ContactName, details.PushName, details.BusinessName, details.PhoneNumber} {
				if candidate != "" {
					senderName = candidate
					break
				}
			}
		}
		body.Event = &bridgev1.BackendEvent_TypingChanged{TypingChanged: &bridgev1.TypingChanged{ChatId: event.ChatJID, SenderId: event.SenderJID, SenderName: senderName, Typing: event.Typing, Recording: event.Recording}}
	case "receipt":
		body.Event = &bridgev1.BackendEvent_ReceiptUpdated{ReceiptUpdated: &bridgev1.ReceiptUpdated{ChatId: event.ChatJID, MessageId: event.MessageID, Status: wireStatus(event.Status)}}
	case "problem":
		body.Event = &bridgev1.BackendEvent_Problem{Problem: &bridgev1.BackendProblem{Code: "WHATSAPP", Message: event.Detail}}
	default:
		return
	}
	body.Sequence = s.sequence.Add(1)
	_ = s.codec.Write(&bridgev1.Envelope{ProtocolVersion: ProtocolVersion, Body: &bridgev1.Envelope_Event{Event: body}})
}

func (s *Server) handle(envelope *bridgev1.Envelope) (*bridgev1.RpcResponse, bool) {
	request := envelope.GetRequest()
	_, isHello := request.GetRequest().(*bridgev1.RpcRequest_Hello)
	if !s.handshaken.Load() && !isHello {
		return rpcError("handshake_required", "Hello must be the first request", false), false
	}
	if s.handshaken.Load() && envelope.GetProtocolVersion() != ProtocolVersion {
		return rpcError("unsupported_protocol", "envelope protocol version mismatch", false), true
	}
	result, err := s.dispatch(request)
	if err != nil {
		if isHello {
			return rpcError("unsupported_protocol", err.Error(), false), true
		}
		var failure *rpcFailure
		if errors.As(err, &failure) {
			return rpcError(failure.code, failure.message, failure.retryable), false
		}
		if errors.Is(err, sql.ErrNoRows) {
			return rpcError("not_found", err.Error(), false), false
		}
		var logoutFailure *wa.LogoutError
		if errors.As(err, &logoutFailure) {
			return rpcError("logout_"+logoutFailure.Stage+"_failed", logoutFailure.Error(), true), false
		}
		return rpcError("internal", err.Error(), false), false
	}
	return success(result), false
}

func rpcError(code, message string, retryable bool) *bridgev1.RpcResponse {
	return &bridgev1.RpcResponse{Result: &bridgev1.RpcResponse_Error{Error: &bridgev1.RpcError{Code: code, Message: message, Retryable: retryable}}}
}

func (s *Server) dispatch(request *bridgev1.RpcRequest) (any, error) {
	switch req := request.GetRequest().(type) {
	case *bridgev1.RpcRequest_Hello:
		if req.Hello.GetMinimumProtocolVersion() > ProtocolVersion || req.Hello.GetMaximumProtocolVersion() < ProtocolVersion {
			return nil, fmt.Errorf("protocol v%d is not supported by desktop", ProtocolVersion)
		}
		return &bridgev1.RpcResponse_Hello{Hello: &bridgev1.HelloResponse{BackendVersion: "0.1.0", ProtocolVersion: ProtocolVersion}}, nil
	case *bridgev1.RpcRequest_GetAuthState:
		return &bridgev1.RpcResponse_AuthState{AuthState: &bridgev1.AuthStateResponse{Paired: s.wa.IsPaired(), LoggedIn: s.wa.IsConnected(), OwnUserId: s.wa.OwnID(), ConnectionState: authConnectionState(s.wa)}}, nil
	case *bridgev1.RpcRequest_StartPairing:
		if s.wa.IsPaired() {
			return &bridgev1.RpcResponse_StartPairing{StartPairing: &bridgev1.StartPairingResponse{Started: false}}, nil
		}
		started, err := s.wa.StartPairing(s.ctx)
		if err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_StartPairing{StartPairing: &bridgev1.StartPairingResponse{Started: started}}, nil
	case *bridgev1.RpcRequest_ListChats:
		page, err := s.store.Chats(s.ctx, req.ListChats.GetCursor(), int(req.ListChats.GetLimit()))
		if err != nil {
			return nil, err
		}
		total, err := s.store.ChatCount(s.ctx)
		if err != nil {
			return nil, err
		}
		chats := make([]*bridgev1.Chat, len(page.Items))
		presentations := make(map[string]wa.ChatPresentation, len(page.Items))
		if s.wa != nil {
			chatIDs := make([]string, len(page.Items))
			for i := range page.Items {
				chatIDs[i] = page.Items[i].JID
			}
			presentations, err = s.wa.ChatPresentations(s.ctx, chatIDs)
			if err != nil {
				return nil, err
			}
		}
		for i := range page.Items {
			item := page.Items[i]
			chats[i] = s.resolveChatMentions(wireChatWithPresentation(item, presentations[item.JID]))
			if s.wa != nil && item.Name == "" {
				if jid, jidErr := types.ParseJID(item.AddressJID); jidErr == nil && jid.Server == types.GroupServer {
					s.wa.BackfillGroupName(item.JID, item.AddressJID)
				}
			}
		}
		return &bridgev1.RpcResponse_ListChats{ListChats: &bridgev1.ListChatsResponse{Chats: chats, TotalCount: uint64(total), NextCursor: page.NextCursor}}, nil
	case *bridgev1.RpcRequest_GetChatAvatar:
		if req.GetChatAvatar.GetChatId() == "" {
			return nil, fail("invalid_argument", "chat_id is required", false)
		}
		path, err := s.wa.ChatAvatar(s.ctx, req.GetChatAvatar.GetChatId())
		if err != nil {
			return nil, fail("avatar_unavailable", err.Error(), true)
		}
		return &bridgev1.RpcResponse_GetChatAvatar{GetChatAvatar: &bridgev1.GetChatAvatarResponse{ChatId: req.GetChatAvatar.GetChatId(), AvatarPath: path}}, nil
	case *bridgev1.RpcRequest_GetParticipantAvatar:
		if req.GetParticipantAvatar.GetParticipantId() == "" {
			return nil, fail("invalid_argument", "participant_id is required", false)
		}
		path, err := s.wa.Avatar(s.ctx, req.GetParticipantAvatar.GetParticipantId())
		if err != nil {
			return nil, fail("avatar_unavailable", err.Error(), true)
		}
		return &bridgev1.RpcResponse_GetParticipantAvatar{GetParticipantAvatar: &bridgev1.GetParticipantAvatarResponse{ParticipantId: req.GetParticipantAvatar.GetParticipantId(), AvatarPath: path}}, nil
	case *bridgev1.RpcRequest_ListMessages:
		if (req.ListMessages.GetBeforeTimestampMs() == 0) != (req.ListMessages.GetBeforeMessageId() == "") {
			return nil, fail("invalid_argument", "before_timestamp_ms and before_message_id must both be set or both be empty", false)
		}
		page, err := s.store.MessagesBefore(s.ctx, req.ListMessages.GetChatId(), req.ListMessages.GetBeforeTimestampMs(), req.ListMessages.GetBeforeMessageId(), int(req.ListMessages.GetLimit()))
		if err != nil {
			return nil, err
		}
		slices.Reverse(page.Items)
		messages := make([]*bridgev1.Message, len(page.Items))
		identities := make(map[string]wireIdentity)
		for i := range page.Items {
			messages[i] = s.wireMessageWithIdentities(page.Items[i], identities)
		}
		return &bridgev1.RpcResponse_ListMessages{ListMessages: &bridgev1.ListMessagesResponse{Messages: messages, HasMore: page.NextCursor != ""}}, nil
	case *bridgev1.RpcRequest_OpenMessageWindow:
		if req.OpenMessageWindow.GetChatId() == "" {
			return nil, fail("invalid_argument", "chat_id is required", false)
		}
		window, err := s.store.InitialMessageWindow(s.ctx, req.OpenMessageWindow.GetChatId(), 25)
		if err != nil {
			return nil, err
		}
		messages := make([]*bridgev1.Message, len(window.Items))
		identities := make(map[string]wireIdentity)
		for i := range window.Items {
			messages[i] = s.wireMessageWithIdentities(window.Items[i], identities)
		}
		return &bridgev1.RpcResponse_OpenMessageWindow{OpenMessageWindow: &bridgev1.OpenMessageWindowResponse{Messages: messages, HasOlder: window.HasOlder, HasNewer: window.HasNewer, FirstUnreadMessageId: window.AnchorID}}, nil
	case *bridgev1.RpcRequest_ListMessagesAfter:
		if req.ListMessagesAfter.GetChatId() == "" || req.ListMessagesAfter.GetAfterTimestampMs() <= 0 || req.ListMessagesAfter.GetAfterMessageId() == "" {
			return nil, fail("invalid_argument", "chat_id, after_timestamp_ms and after_message_id are required", false)
		}
		items, hasMore, err := s.store.MessagesAfter(s.ctx, req.ListMessagesAfter.GetChatId(), req.ListMessagesAfter.GetAfterTimestampMs(), req.ListMessagesAfter.GetAfterMessageId(), int(req.ListMessagesAfter.GetLimit()))
		if err != nil {
			return nil, err
		}
		messages := make([]*bridgev1.Message, len(items))
		identities := make(map[string]wireIdentity)
		for i := range items {
			messages[i] = s.wireMessageWithIdentities(items[i], identities)
		}
		return &bridgev1.RpcResponse_ListMessagesAfter{ListMessagesAfter: &bridgev1.ListMessagesAfterResponse{Messages: messages, HasMore: hasMore}}, nil
	case *bridgev1.RpcRequest_SearchLocal:
		query := strings.TrimSpace(req.SearchLocal.GetQuery())
		if !utf8.ValidString(query) || utf8.RuneCountInString(query) < 2 || len(query) > 256 {
			return nil, fail("invalid_argument", "query must be valid UTF-8 containing 2 to 256 bytes", false)
		}
		return s.searchLocal(query)
	case *bridgev1.RpcRequest_OpenContact:
		if req.OpenContact.GetContactJid() == "" {
			return nil, fail("invalid_argument", "contact_jid is required", false)
		}
		chat, err := s.wa.OpenContact(s.ctx, req.OpenContact.GetContactJid())
		if err != nil {
			return nil, fail("invalid_argument", err.Error(), false)
		}
		return &bridgev1.RpcResponse_OpenContact{OpenContact: &bridgev1.OpenContactResponse{Chat: s.wireChat(chat)}}, nil
	case *bridgev1.RpcRequest_SetTyping:
		if req.SetTyping.GetChatId() == "" {
			return nil, fail("invalid_argument", "chat_id is required", false)
		}
		if err := s.wa.SetTyping(s.ctx, req.SetTyping.GetChatId(), req.SetTyping.GetTyping()); err != nil {
			return nil, fail("typing_unavailable", err.Error(), true)
		}
		return &bridgev1.RpcResponse_SetTyping{SetTyping: &bridgev1.SetTypingResponse{}}, nil
	case *bridgev1.RpcRequest_GetChatInfo:
		if req.GetChatInfo.GetChatId() == "" {
			return nil, fail("invalid_argument", "chat_id is required", false)
		}
		chat, err := s.store.Chat(s.ctx, req.GetChatInfo.GetChatId())
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, fail("invalid_argument", "unknown chat", false)
			}
			return nil, err
		}
		info, err := s.wa.ChatInfo(s.ctx, req.GetChatInfo.GetChatId())
		if err != nil {
			return nil, fail("chat_info_unavailable", err.Error(), true)
		}
		participants := make([]*bridgev1.ChatParticipant, len(info.Participants))
		for i, participant := range info.Participants {
			participants[i] = &bridgev1.ChatParticipant{
				ParticipantId: participant.ID,
				DisplayName:   participant.DisplayName,
				PhoneNumber:   participant.PhoneNumber,
				IsAdmin:       participant.IsAdmin,
				IsSuperAdmin:  participant.IsSuperAdmin,
				IsMe:          participant.IsMe,
			}
		}
		response := &bridgev1.GetChatInfoResponse{
			Chat:                     s.wireChat(chat),
			Address:                  info.Address,
			About:                    info.About,
			VerifiedName:             info.VerifiedName,
			Description:              info.Description,
			CreatedBy:                info.CreatedBy,
			ParticipantCount:         uint32(info.ParticipantCount),
			Participants:             participants,
			AnnounceOnly:             info.AnnounceOnly,
			Locked:                   info.Locked,
			DisappearingTimerSeconds: info.DisappearingTimer,
			IsCommunity:              info.IsCommunity,
			JoinApprovalRequired:     info.JoinApprovalRequired,
		}
		if !info.CreatedAt.IsZero() {
			response.CreatedAtMs = info.CreatedAt.UnixMilli()
		}
		return &bridgev1.RpcResponse_GetChatInfo{GetChatInfo: response}, nil
	case *bridgev1.RpcRequest_ListMessagesAround:
		if req.ListMessagesAround.GetChatId() == "" || req.ListMessagesAround.GetMessageId() == "" {
			return nil, fail("invalid_argument", "chat_id and message_id are required", false)
		}
		window, err := s.store.MessagesAround(s.ctx, req.ListMessagesAround.GetChatId(), req.ListMessagesAround.GetMessageId(), 25)
		if err != nil {
			return nil, err
		}
		messages := make([]*bridgev1.Message, len(window.Items))
		identities := make(map[string]wireIdentity)
		for i := range window.Items {
			messages[i] = s.wireMessageWithIdentities(window.Items[i], identities)
		}
		return &bridgev1.RpcResponse_ListMessagesAround{ListMessagesAround: &bridgev1.ListMessagesAroundResponse{Messages: messages, HasOlder: window.HasOlder, HasNewer: window.HasNewer, AnchorMessageId: window.AnchorID}}, nil
	case *bridgev1.RpcRequest_SendText:
		if req.SendText.GetClientMessageId() == "" || req.SendText.GetChatId() == "" || req.SendText.GetText() == "" {
			return nil, fail("invalid_argument", "client_message_id, chat_id and text are required", false)
		}
		if !utf8.ValidString(req.SendText.GetText()) || len(req.SendText.GetText()) > maxTextBytes {
			return nil, fail("invalid_argument", "text must be valid UTF-8 up to 65536 bytes", false)
		}
		if _, err := uuid.Parse(req.SendText.GetClientMessageId()); err != nil {
			return nil, fail("invalid_argument", "client_message_id must be a UUID", false)
		}
		if err := s.validateReplyTarget(req.SendText.GetChatId(), req.SendText.GetReplyToMessageId()); err != nil {
			return nil, err
		}
		if !s.wa.IsConnected() {
			return nil, fail("not_connected", "WhatsApp is not connected", true)
		}
		message, err := s.wa.SendText(s.ctx, req.SendText.GetClientMessageId(), req.SendText.GetChatId(), req.SendText.GetText(), req.SendText.GetReplyToMessageId(), req.SendText.GetMentionedJids())
		if err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_SendText{SendText: &bridgev1.SendTextResponse{Message: s.wireMessage(message)}}, nil
	case *bridgev1.RpcRequest_SendImage:
		if req.SendImage.GetClientMessageId() == "" || req.SendImage.GetChatId() == "" || req.SendImage.GetImagePath() == "" {
			return nil, fail("invalid_argument", "client_message_id, chat_id and image_path are required", false)
		}
		if _, err := uuid.Parse(req.SendImage.GetClientMessageId()); err != nil {
			return nil, fail("invalid_argument", "client_message_id must be a UUID", false)
		}
		if !utf8.ValidString(req.SendImage.GetCaption()) || len(req.SendImage.GetCaption()) > 4096 {
			return nil, fail("invalid_argument", "caption must be valid UTF-8 up to 4096 bytes", false)
		}
		if err := s.validateReplyTarget(req.SendImage.GetChatId(), req.SendImage.GetReplyToMessageId()); err != nil {
			return nil, err
		}
		if !s.wa.IsConnected() {
			return nil, fail("not_connected", "WhatsApp is not connected", true)
		}
		message, err := s.wa.SendImage(s.ctx, req.SendImage.GetClientMessageId(), req.SendImage.GetChatId(), req.SendImage.GetImagePath(), req.SendImage.GetCaption(), req.SendImage.GetReplyToMessageId())
		if err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_SendImage{SendImage: &bridgev1.SendImageResponse{Message: s.wireMessage(message)}}, nil
	case *bridgev1.RpcRequest_SendSticker:
		if req.SendSticker.GetClientMessageId() == "" || req.SendSticker.GetChatId() == "" || len(req.SendSticker.GetWebpData()) == 0 {
			return nil, fail("invalid_argument", "client_message_id, chat_id and webp_data are required", false)
		}
		if _, err := uuid.Parse(req.SendSticker.GetClientMessageId()); err != nil {
			return nil, fail("invalid_argument", "client_message_id must be a UUID", false)
		}
		if err := s.validateReplyTarget(req.SendSticker.GetChatId(), req.SendSticker.GetReplyToMessageId()); err != nil {
			return nil, err
		}
		if !s.wa.IsConnected() {
			return nil, fail("not_connected", "WhatsApp is not connected", true)
		}
		message, err := s.wa.SendSticker(s.ctx, req.SendSticker.GetClientMessageId(), req.SendSticker.GetChatId(), req.SendSticker.GetWebpData(), req.SendSticker.GetReplyToMessageId())
		if err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_SendSticker{SendSticker: &bridgev1.SendStickerResponse{Message: s.wireMessage(message)}}, nil
	case *bridgev1.RpcRequest_SendAttachment:
		if req.SendAttachment.GetClientMessageId() == "" || req.SendAttachment.GetChatId() == "" || req.SendAttachment.GetFilePath() == "" {
			return nil, fail("invalid_argument", "client_message_id, chat_id and file_path are required", false)
		}
		if _, err := uuid.Parse(req.SendAttachment.GetClientMessageId()); err != nil {
			return nil, fail("invalid_argument", "client_message_id must be a UUID", false)
		}
		if !utf8.ValidString(req.SendAttachment.GetCaption()) || len(req.SendAttachment.GetCaption()) > 4096 {
			return nil, fail("invalid_argument", "caption must be valid UTF-8 up to 4096 bytes", false)
		}
		kind := ""
		switch req.SendAttachment.GetKind() {
		case bridgev1.AttachmentKind_ATTACHMENT_KIND_DOCUMENT:
			kind = "document"
		case bridgev1.AttachmentKind_ATTACHMENT_KIND_VIDEO:
			kind = "video"
		case bridgev1.AttachmentKind_ATTACHMENT_KIND_AUDIO:
			kind = "audio"
		default:
			return nil, fail("invalid_argument", "kind must be document, video or audio", false)
		}
		if kind == "audio" && req.SendAttachment.GetCaption() != "" {
			return nil, fail("invalid_argument", "audio messages do not support captions", false)
		}
		if kind != "audio" && req.SendAttachment.GetVoiceNote() {
			return nil, fail("invalid_argument", "voice_note is only valid for audio attachments", false)
		}
		if err := s.validateReplyTarget(req.SendAttachment.GetChatId(), req.SendAttachment.GetReplyToMessageId()); err != nil {
			return nil, err
		}
		if !s.wa.IsConnected() {
			return nil, fail("not_connected", "WhatsApp is not connected", true)
		}
		message, err := s.wa.SendAttachment(s.ctx, req.SendAttachment.GetClientMessageId(), req.SendAttachment.GetChatId(), req.SendAttachment.GetFilePath(), kind, req.SendAttachment.GetCaption(), req.SendAttachment.GetReplyToMessageId(), req.SendAttachment.GetVoiceNote())
		if errors.Is(err, wa.ErrInvalidAttachment) {
			return nil, fail("invalid_argument", err.Error(), false)
		}
		if err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_SendAttachment{SendAttachment: &bridgev1.SendAttachmentResponse{Message: s.wireMessage(message)}}, nil
	case *bridgev1.RpcRequest_GetMessageImage:
		if req.GetMessageImage.GetChatId() == "" || req.GetMessageImage.GetMessageId() == "" {
			return nil, fail("invalid_argument", "chat_id and message_id are required", false)
		}
		path, thumbnailPath, err := s.wa.DownloadImage(s.ctx, req.GetMessageImage.GetChatId(), req.GetMessageImage.GetMessageId())
		if err != nil {
			return nil, fail("image_unavailable", err.Error(), s.wa.IsConnected())
		}
		return &bridgev1.RpcResponse_GetMessageImage{GetMessageImage: &bridgev1.GetMessageImageResponse{ChatId: req.GetMessageImage.GetChatId(), MessageId: req.GetMessageImage.GetMessageId(), ImagePath: path, ThumbnailPath: thumbnailPath}}, nil
	case *bridgev1.RpcRequest_GetMessageAttachment:
		if req.GetMessageAttachment.GetChatId() == "" || req.GetMessageAttachment.GetMessageId() == "" {
			return nil, fail("invalid_argument", "chat_id and message_id are required", false)
		}
		path, err := s.wa.DownloadAttachment(s.ctx, req.GetMessageAttachment.GetChatId(), req.GetMessageAttachment.GetMessageId())
		if err != nil {
			return nil, fail("attachment_unavailable", err.Error(), s.wa.IsConnected())
		}
		return &bridgev1.RpcResponse_GetMessageAttachment{GetMessageAttachment: &bridgev1.GetMessageAttachmentResponse{ChatId: req.GetMessageAttachment.GetChatId(), MessageId: req.GetMessageAttachment.GetMessageId(), LocalPath: path}}, nil
	case *bridgev1.RpcRequest_SendReaction:
		if req.SendReaction.GetClientReactionId() == "" || req.SendReaction.GetChatId() == "" || req.SendReaction.GetMessageId() == "" {
			return nil, fail("invalid_argument", "client_reaction_id, chat_id and message_id are required", false)
		}
		if _, err := uuid.Parse(req.SendReaction.GetClientReactionId()); err != nil {
			return nil, fail("invalid_argument", "client_reaction_id must be a UUID", false)
		}
		if !validReactionEmoji(req.SendReaction.GetEmoji()) {
			return nil, fail("invalid_argument", "emoji must be empty or one emoji grapheme up to 64 bytes", false)
		}
		if !s.wa.IsConnected() {
			return nil, fail("not_connected", "WhatsApp is not connected", true)
		}
		reaction, err := s.wa.SendReaction(s.ctx, req.SendReaction.GetClientReactionId(), req.SendReaction.GetChatId(), req.SendReaction.GetMessageId(), req.SendReaction.GetEmoji())
		if err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_SendReaction{SendReaction: &bridgev1.SendReactionResponse{Reaction: s.wireReaction(reaction), Removed: reaction.Emoji == ""}}, nil
	case *bridgev1.RpcRequest_RepairRecentReactions:
		if req.RepairRecentReactions.GetChatId() == "" {
			return nil, fail("invalid_argument", "chat_id is required", false)
		}
		if !s.wa.IsConnected() {
			return nil, fail("not_connected", "WhatsApp is not connected", true)
		}
		attempts, requested, err := s.wa.RepairRecentReactions(s.ctx, req.RepairRecentReactions.GetChatId())
		if errors.Is(err, store.ErrReactionRepairNotNeeded) {
			return nil, fail("not_found", "chat is not marked for reaction repair", false)
		}
		if errors.Is(err, store.ErrReactionRepairRateLimit) || errors.Is(err, store.ErrReactionRepairCursorNotReady) {
			return &bridgev1.RpcResponse_RepairRecentReactions{RepairRecentReactions: &bridgev1.RepairRecentReactionsResponse{ChatId: req.RepairRecentReactions.GetChatId(), Requested: false, Attempts: attempts}}, nil
		}
		if errors.Is(err, store.ErrReactionRepairExhausted) {
			return nil, fail("repair_exhausted", err.Error(), false)
		}
		if err != nil {
			return nil, fail("repair_request_failed", err.Error(), true)
		}
		return &bridgev1.RpcResponse_RepairRecentReactions{RepairRecentReactions: &bridgev1.RepairRecentReactionsResponse{ChatId: req.RepairRecentReactions.GetChatId(), Requested: requested, Attempts: attempts}}, nil
	case *bridgev1.RpcRequest_MarkRead:
		if err := s.wa.MarkRead(s.ctx, req.MarkRead.GetChatId(), req.MarkRead.GetThroughMessageId()); err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_MarkRead{MarkRead: &bridgev1.MarkReadResponse{}}, nil
	case *bridgev1.RpcRequest_Logout:
		if err := s.waitForMediaJobs(s.ctx); err != nil {
			return nil, &wa.LogoutError{Stage: "isolation", Local: fmt.Errorf("wait for media operations: %w", err)}
		}
		if err := s.logoutFn(s.ctx); err != nil {
			return nil, err
		}
		return &bridgev1.RpcResponse_Logout{Logout: &bridgev1.LogoutResponse{}}, nil
	case *bridgev1.RpcRequest_Shutdown:
		s.shutdown.Store(true)
		return &bridgev1.RpcResponse_Shutdown{Shutdown: &bridgev1.ShutdownResponse{}}, nil
	default:
		return nil, fmt.Errorf("unsupported request")
	}
}

func (s *Server) searchLocal(query string) (any, error) {
	contacts, err := s.wa.SearchContacts(s.ctx, query, 8)
	if err != nil {
		return nil, err
	}
	contactResults := make([]*bridgev1.ContactSearchResult, len(contacts))
	for i := range contacts {
		contactResults[i] = &bridgev1.ContactSearchResult{ContactJid: contacts[i].JID, ChatId: contacts[i].ChatID, DisplayName: contacts[i].DisplayName, SecondaryName: contacts[i].SecondaryName, PhoneNumber: contacts[i].PhoneNumber}
	}
	groups, err := s.store.Groups(s.ctx)
	if err != nil {
		return nil, err
	}
	type rankedGroup struct {
		chat  domain.Chat
		score int
	}
	matcher := searchutil.New(query)
	rankedGroups := make([]rankedGroup, 0, len(groups))
	for _, group := range groups {
		if score := matcher.Score(group.Name); score != searchutil.NoMatch {
			rankedGroups = append(rankedGroups, rankedGroup{chat: group, score: score + 250})
		}
	}
	sort.Slice(rankedGroups, func(i, j int) bool {
		if rankedGroups[i].score != rankedGroups[j].score {
			return rankedGroups[i].score > rankedGroups[j].score
		}
		if !rankedGroups[i].chat.LastMessageAt.Equal(rankedGroups[j].chat.LastMessageAt) {
			return rankedGroups[i].chat.LastMessageAt.After(rankedGroups[j].chat.LastMessageAt)
		}
		return rankedGroups[i].chat.JID < rankedGroups[j].chat.JID
	})
	if len(rankedGroups) > 6 {
		rankedGroups = rankedGroups[:6]
	}
	groupResults := make([]*bridgev1.Chat, len(rankedGroups))
	for i := range rankedGroups {
		groupResults[i] = s.wireChat(rankedGroups[i].chat)
	}
	messageResults := make([]*bridgev1.MessageSearchResult, 0)
	if utf8.RuneCountInString(searchutil.Normalize(query)) >= 3 {
		hits, searchErr := s.store.SearchMessages(s.ctx, query, 20)
		if searchErr != nil {
			return nil, searchErr
		}
		chatCache := make(map[string]*bridgev1.Chat)
		for _, hit := range hits {
			chat, ok := chatCache[hit.Chat.JID]
			if !ok {
				chat = s.wireChat(hit.Chat)
				chatCache[hit.Chat.JID] = chat
			}
			senderName := "You"
			if !hit.FromMe {
				senderName = preferredContactName(s.wa.ContactDetails(s.ctx, hit.SenderJID), hit.SenderJID)
			}
			messageResults = append(messageResults, &bridgev1.MessageSearchResult{ChatId: hit.Chat.JID, MessageId: hit.MessageID, ChatTitle: chat.GetTitle(), SenderName: senderName, TimestampMs: hit.Timestamp.UnixMilli(), Snippet: truncateRunes(hit.Text, 180), Kind: hit.Kind, Archived: hit.Chat.Archived, Chat: chat})
		}
	}
	return &bridgev1.RpcResponse_SearchLocal{SearchLocal: &bridgev1.SearchLocalResponse{Contacts: contactResults, Groups: groupResults, Messages: messageResults}}, nil
}

func truncateRunes(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}

func success(result any) *bridgev1.RpcResponse {
	response := &bridgev1.RpcResponse{}
	switch value := result.(type) {
	case *bridgev1.RpcResponse_Hello:
		response.Result = value
	case *bridgev1.RpcResponse_AuthState:
		response.Result = value
	case *bridgev1.RpcResponse_StartPairing:
		response.Result = value
	case *bridgev1.RpcResponse_ListChats:
		response.Result = value
	case *bridgev1.RpcResponse_ListMessages:
		response.Result = value
	case *bridgev1.RpcResponse_GetChatAvatar:
		response.Result = value
	case *bridgev1.RpcResponse_GetParticipantAvatar:
		response.Result = value
	case *bridgev1.RpcResponse_SendReaction:
		response.Result = value
	case *bridgev1.RpcResponse_RepairRecentReactions:
		response.Result = value
	case *bridgev1.RpcResponse_SendText:
		response.Result = value
	case *bridgev1.RpcResponse_SendImage:
		response.Result = value
	case *bridgev1.RpcResponse_SendSticker:
		response.Result = value
	case *bridgev1.RpcResponse_SendAttachment:
		response.Result = value
	case *bridgev1.RpcResponse_GetMessageImage:
		response.Result = value
	case *bridgev1.RpcResponse_GetMessageAttachment:
		response.Result = value
	case *bridgev1.RpcResponse_SearchLocal:
		response.Result = value
	case *bridgev1.RpcResponse_OpenContact:
		response.Result = value
	case *bridgev1.RpcResponse_ListMessagesAround:
		response.Result = value
	case *bridgev1.RpcResponse_OpenMessageWindow:
		response.Result = value
	case *bridgev1.RpcResponse_ListMessagesAfter:
		response.Result = value
	case *bridgev1.RpcResponse_GetChatInfo:
		response.Result = value
	case *bridgev1.RpcResponse_SetTyping:
		response.Result = value
	case *bridgev1.RpcResponse_MarkRead:
		response.Result = value
	case *bridgev1.RpcResponse_Logout:
		response.Result = value
	case *bridgev1.RpcResponse_Shutdown:
		response.Result = value
	default:
		response.Result = &bridgev1.RpcResponse_Error{Error: &bridgev1.RpcError{Code: "internal", Message: "invalid backend response"}}
	}
	return response
}

func wireChat(c domain.Chat) *bridgev1.Chat {
	kind := bridgev1.ChatKind_CHAT_KIND_OTHER
	if jid, err := types.ParseJID(c.AddressJID); err == nil {
		switch jid.Server {
		case types.GroupServer:
			kind = bridgev1.ChatKind_CHAT_KIND_GROUP
		case types.DefaultUserServer, types.HiddenUserServer, types.HostedLIDServer:
			kind = bridgev1.ChatKind_CHAT_KIND_DIRECT
		}
	}
	title := c.Name
	if title == "" {
		title = c.AddressJID
	}
	return &bridgev1.Chat{Id: c.JID, Kind: kind, Title: title, LastMessagePreview: c.LastMessageText, LastMessageTimestampMs: c.LastMessageAt.UnixMilli(), UnreadCount: uint32(c.UnreadCount), Muted: c.MutedUntil.After(time.Now()), Archived: c.Archived}
}

func (s *Server) wireChat(c domain.Chat) *bridgev1.Chat {
	if s.wa == nil {
		return wireChat(c)
	}
	if c.Name == "" {
		if jid, jidErr := types.ParseJID(c.AddressJID); jidErr == nil && jid.Server == types.GroupServer {
			s.wa.BackfillGroupName(c.JID, c.AddressJID)
		}
	}
	details, cachedAvatar := s.wa.ChatPresentation(s.ctx, c.JID)
	return s.resolveChatMentions(wireChatWithPresentation(c, wa.ChatPresentation{Details: details, AvatarPath: cachedAvatar}))
}

// resolveChatMentions rewrites raw @user tokens in the last-message preview to
// contact names, mirroring what wireMessageWithIdentities does for bodies.
func (s *Server) resolveChatMentions(chat *bridgev1.Chat) *bridgev1.Chat {
	chat.LastMessagePreview = replaceMentionIDs(chat.LastMessagePreview, func(user string) string { return s.mentionDisplayName(user) })
	return chat
}

func wireChatWithPresentation(c domain.Chat, presentation wa.ChatPresentation) *bridgev1.Chat {
	chat := wireChat(c)
	details := presentation.Details
	chat.PhoneNumber = details.PhoneNumber
	chat.ContactName = details.ContactName
	chat.PushName = details.PushName
	chat.BusinessName = details.BusinessName
	chat.AvatarPath = presentation.AvatarPath
	if chat.Kind == bridgev1.ChatKind_CHAT_KIND_DIRECT {
		switch {
		case details.ContactName != "":
			chat.Title = details.ContactName
		case details.BusinessName != "":
			chat.Title = details.BusinessName
		case details.PushName != "":
			chat.Title = details.PushName
		case c.Name != "":
			chat.Title = c.Name
		case details.PhoneNumber != "":
			chat.Title = details.PhoneNumber
		}
	}
	return chat
}
func wireMessage(m domain.Message) *bridgev1.Message {
	message := &bridgev1.Message{Id: m.ID, ChatId: m.ChatJID, SenderId: m.SenderJID, FromMe: m.FromMe, TimestampMs: m.Timestamp.UnixMilli(), Status: wireStatus(m.Status), Edited: !m.EditedAt.IsZero(), Revoked: m.Revoked, ReplyToMessageId: m.ReplyToID}
	if m.Image != nil {
		message.Content = &bridgev1.Message_Image{Image: &bridgev1.ImageContent{Caption: m.Image.Caption, MimeType: m.Image.MIMEType, LocalPath: m.Image.LocalPath,
			Width: m.Image.Width, Height: m.Image.Height, FileSize: m.Image.FileSize, Downloadable: !m.Revoked, Sticker: m.Kind == "sticker", Animated: m.Image.Animated}}
	} else if m.Attachment != nil {
		attachment := m.Attachment
		message.Content = &bridgev1.Message_Attachment{Attachment: &bridgev1.AttachmentContent{Kind: m.Kind, Caption: attachment.Caption, MimeType: attachment.MIMEType,
			FileName: attachment.FileName, LocalPath: attachment.LocalPath, FileSize: attachment.FileSize, Width: attachment.Width, Height: attachment.Height,
			DurationSeconds: attachment.DurationSeconds, Animated: attachment.Animated, VoiceNote: attachment.VoiceNote, Downloadable: !m.Revoked}}
	} else if len(m.Contacts) > 0 {
		contacts := make([]*bridgev1.ContactContent, len(m.Contacts))
		for i, contact := range m.Contacts {
			contacts[i] = &bridgev1.ContactContent{DisplayName: contact.DisplayName, Vcard: contact.VCard}
		}
		message.Content = &bridgev1.Message_Contacts{Contacts: &bridgev1.ContactsContent{Contacts: contacts}}
	} else if m.Location != nil {
		message.Content = &bridgev1.Message_Location{Location: &bridgev1.LocationContent{Latitude: m.Location.Latitude, Longitude: m.Location.Longitude,
			Name: m.Location.Name, Address: m.Location.Address, Url: m.Location.URL, Live: m.Location.Live}}
	} else if m.Kind == "text" {
		text := &bridgev1.TextContent{Text: m.Text}
		if preview := m.LinkPreview; preview != nil {
			text.LinkPreview = &bridgev1.LinkPreview{Url: preview.URL, Title: preview.Title, Description: preview.Description,
				JpegThumbnail: preview.JPEGThumbnail, ThumbnailWidth: preview.ThumbnailWidth, ThumbnailHeight: preview.ThumbnailHeight}
		}
		message.Content = &bridgev1.Message_Text{Text: text}
	} else {
		message.Content = &bridgev1.Message_Unsupported{Unsupported: &bridgev1.UnsupportedContent{TypeName: m.Kind, FallbackText: m.Text}}
	}
	return message
}

func (s *Server) wireMessage(m domain.Message) *bridgev1.Message {
	return s.wireMessageWithIdentities(m, nil)
}

type wireIdentity struct {
	name, phone, avatar string
}

func (s *Server) identity(jid string, memo map[string]wireIdentity) wireIdentity {
	if memo != nil {
		if identity, ok := memo[jid]; ok {
			return identity
		}
	}
	if s.wa == nil {
		return wireIdentity{}
	}
	details := s.wa.ContactDetails(s.ctx, jid)
	identity := wireIdentity{name: preferredContactName(details, jid), phone: details.PhoneNumber, avatar: s.wa.CachedAvatar(jid)}
	if memo != nil {
		memo[jid] = identity
	}
	return identity
}

func (s *Server) wireMessageWithIdentities(m domain.Message, identities map[string]wireIdentity) *bridgev1.Message {
	message := wireMessage(m)
	if text := message.GetText(); text != nil {
		text.Text = replaceMentionIDs(text.Text, func(user string) string { return s.mentionDisplayName(user) })
	}
	if image := message.GetImage(); image != nil {
		image.Caption = replaceMentionIDs(image.Caption, func(user string) string { return s.mentionDisplayName(user) })
	}
	if attachment := message.GetAttachment(); attachment != nil {
		attachment.Caption = replaceMentionIDs(attachment.Caption, func(user string) string { return s.mentionDisplayName(user) })
	}
	if image := message.GetImage(); image != nil && s.wa != nil {
		// The cache is bounded and may have evicted the path persisted in SQLite.
		// Only advertise files that still exist so the desktop asks us to fetch
		// an evicted image again when its virtualized row becomes visible.
		image.LocalPath, image.ThumbnailPath = s.wa.CachedImagePaths(m.ChatJID, m.ID, image.MimeType)
	}
	if attachment := message.GetAttachment(); attachment != nil && s.wa != nil {
		attachment.LocalPath = s.wa.CachedAttachmentPath(m.ChatJID, m.ID, m.Attachment)
	}
	chat, err := types.ParseJID(m.TransportJID)
	if err == nil && chat.Server == types.GroupServer {
		identity := s.identity(m.SenderJID, identities)
		message.SenderName = identity.name
		if m.FromMe {
			message.SenderName = "You"
		}
		message.SenderPhoneNumber = identity.phone
		message.SenderAvatarPath = identity.avatar
	}
	message.Reactions = make([]*bridgev1.Reaction, len(m.Reactions))
	for i := range m.Reactions {
		message.Reactions[i] = s.wireReactionWithIdentities(m.Reactions[i], identities)
	}
	return message
}

func (s *Server) mentionDisplayName(user string) string {
	if s.wa == nil {
		return ""
	}
	phone := ""
	for _, suffix := range []string{"@s.whatsapp.net", "@lid"} {
		details := s.wa.ContactDetails(s.ctx, user+suffix)
		switch {
		case details.ContactName != "":
			return details.ContactName
		case details.BusinessName != "":
			return details.BusinessName
		case details.PushName != "":
			return details.PushName
		case phone == "" && details.PhoneNumber != "":
			phone = details.PhoneNumber
		}
	}
	return phone
}

// replaceMentionIDs changes only the rendered copy of a message. SQLite keeps
// the original @user token, which preserves the WhatsApp identity for future
// re-resolution when a PN/LID mapping or contact name arrives later.
func replaceMentionIDs(text string, resolve func(user string) string) string {
	var out strings.Builder
	changed := false
	for cursor := 0; cursor < len(text); {
		at := strings.IndexByte(text[cursor:], '@')
		if at < 0 {
			out.WriteString(text[cursor:])
			break
		}
		at += cursor
		out.WriteString(text[cursor:at])
		end := at + 1
		for end < len(text) && text[end] >= '0' && text[end] <= '9' {
			end++
		}
		length := end - at - 1
		validBefore := at == 0 || !((text[at-1] >= '0' && text[at-1] <= '9') || (text[at-1] >= 'A' && text[at-1] <= 'Z') || (text[at-1] >= 'a' && text[at-1] <= 'z'))
		validAfter := end == len(text) || !((text[end] >= '0' && text[end] <= '9') || (text[end] >= 'A' && text[end] <= 'Z') || (text[end] >= 'a' && text[end] <= 'z'))
		if length >= 5 && length <= 20 && validBefore && validAfter {
			if name := resolve(text[at+1 : end]); name != "" {
				out.WriteByte('@')
				out.WriteString(name)
				cursor = end
				changed = true
				continue
			}
		}
		out.WriteByte('@')
		cursor = at + 1
	}
	if !changed {
		return text
	}
	return out.String()
}

func preferredContactName(details wa.ContactDetails, fallback string) string {
	switch {
	case details.ContactName != "":
		return details.ContactName
	case details.BusinessName != "":
		return details.BusinessName
	case details.PushName != "":
		return details.PushName
	case details.PhoneNumber != "":
		return details.PhoneNumber
	default:
		return fallback
	}
}

func (s *Server) wireReaction(reaction domain.Reaction) *bridgev1.Reaction {
	return s.wireReactionWithIdentities(reaction, nil)
}

func (s *Server) wireReactionWithIdentities(reaction domain.Reaction, identities map[string]wireIdentity) *bridgev1.Reaction {
	identity := s.identity(reaction.SenderJID, identities)
	if reaction.FromMe {
		identity.name = "You"
	}
	return &bridgev1.Reaction{ChatId: reaction.ChatJID, MessageId: reaction.MessageID, SenderId: reaction.SenderJID, Emoji: reaction.Emoji, TimestampMs: reaction.Timestamp.UnixMilli(), FromMe: reaction.FromMe, SenderName: identity.name, SenderPhoneNumber: identity.phone, SenderAvatarPath: identity.avatar}
}

func validReactionEmoji(emoji string) bool {
	if emoji == "" {
		return true
	}
	if len(emoji) > 64 || !utf8.ValidString(emoji) {
		return false
	}
	graphemes := uniseg.NewGraphemes(emoji)
	if !graphemes.Next() || graphemes.Str() == "" || graphemes.Next() {
		return false
	}
	for _, r := range emoji {
		if r == '\u20e3' || (r >= '\U0001f000' && r <= '\U0001faff') || (r >= '\u2600' && r <= '\u27bf') || r == '\u00a9' || r == '\u00ae' || r == '\u2122' {
			return true
		}
	}
	return false
}
func wireStatus(status domain.MessageStatus) bridgev1.MessageStatus {
	return bridgev1.MessageStatus(status)
}
func connectionState(detail string) bridgev1.ConnectionState {
	switch detail {
	case "connected":
		return bridgev1.ConnectionState_CONNECTION_STATE_CONNECTED
	case "connecting":
		return bridgev1.ConnectionState_CONNECTION_STATE_CONNECTING
	case "offline":
		return bridgev1.ConnectionState_CONNECTION_STATE_OFFLINE
	case "pairing":
		return bridgev1.ConnectionState_CONNECTION_STATE_PAIRING
	case "logged_out":
		return bridgev1.ConnectionState_CONNECTION_STATE_LOGGED_OUT
	default:
		return bridgev1.ConnectionState_CONNECTION_STATE_FAILED
	}
}
func authConnectionState(client *wa.Client) bridgev1.ConnectionState {
	if client.IsConnected() {
		return bridgev1.ConnectionState_CONNECTION_STATE_CONNECTED
	}
	if client.IsPaired() {
		return bridgev1.ConnectionState_CONNECTION_STATE_OFFLINE
	}
	return bridgev1.ConnectionState_CONNECTION_STATE_PAIRING
}
