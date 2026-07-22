/**
 * JSON DTOs emitted by the Tauri bridge.
 *
 * The Rust side derives Serde's camelCase representation directly on the
 * Prost-generated messages. Protobuf enum fields therefore cross IPC as their
 * numeric wire values, optional messages cross as `null`, and `bytes` cross as
 * arrays of numbers.
 */

export const ConnectionState = {
  Unspecified: 0,
  Starting: 1,
  Pairing: 2,
  Connecting: 3,
  Connected: 4,
  Reconnecting: 5,
  Offline: 6,
  LoggedOut: 7,
  Failed: 8,
} as const;

export type ConnectionState =
  (typeof ConnectionState)[keyof typeof ConnectionState];

export const ChatKind = {
  Unspecified: 0,
  Direct: 1,
  Group: 2,
  Other: 3,
} as const;

export type ChatKind = (typeof ChatKind)[keyof typeof ChatKind];

export const MessageStatus = {
  Unspecified: 0,
  Pending: 1,
  Sent: 2,
  Delivered: 3,
  Read: 4,
  Failed: 5,
} as const;

export type MessageStatus =
  (typeof MessageStatus)[keyof typeof MessageStatus];

export const AttachmentKind = {
  Unspecified: 0,
  Document: 1,
  Video: 2,
  Audio: 3,
} as const;

export type AttachmentKind =
  (typeof AttachmentKind)[keyof typeof AttachmentKind];

export interface CommandError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface HelloResponse {
  backendVersion: string;
  protocolVersion: number;
}

export interface AuthState {
  paired: boolean;
  loggedIn: boolean;
  ownUserId: string;
  connectionState: ConnectionState;
}

export type AuthStateResponse = AuthState;

export interface StartPairingResponse {
  started: boolean;
}

export interface Chat {
  /** Opaque local conversation ID, not a WhatsApp JID. */
  id: string;
  kind: ChatKind;
  title: string;
  avatarPath: string;
  lastMessagePreview: string;
  lastMessageTimestampMs: number;
  unreadCount: number;
  muted: boolean;
  pinned: boolean;
  archived: boolean;
  phoneNumber: string;
  contactName: string;
  pushName: string;
  businessName: string;
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  jpegThumbnail: number[];
  thumbnailWidth: number;
  thumbnailHeight: number;
}

export interface TextContent {
  text: string;
  linkPreview: LinkPreview | null;
}

export interface ImageContent {
  caption: string;
  mimeType: string;
  localPath: string;
  width: number;
  height: number;
  fileSize: number;
  downloadable: boolean;
  sticker: boolean;
  animated: boolean;
  thumbnailPath: string;
}

export interface AttachmentContent {
  kind: string;
  caption: string;
  mimeType: string;
  fileName: string;
  localPath: string;
  fileSize: number;
  width: number;
  height: number;
  durationSeconds: number;
  animated: boolean;
  voiceNote: boolean;
  downloadable: boolean;
}

export interface ContactContent {
  displayName: string;
  vcard: string;
}

export interface ContactsContent {
  contacts: ContactContent[];
}

export interface LocationContent {
  latitude: number;
  longitude: number;
  name: string;
  address: string;
  url: string;
  live: boolean;
}

export interface UnsupportedContent {
  typeName: string;
  fallbackText: string;
}

/** Serde's externally-tagged representation of the Prost oneof. */
export type MessageContent =
  | { text: TextContent }
  | { unsupported: UnsupportedContent }
  | { image: ImageContent }
  | { attachment: AttachmentContent }
  | { contacts: ContactsContent }
  | { location: LocationContent };

export interface Reaction {
  chatId: string;
  messageId: string;
  senderId: string;
  emoji: string;
  timestampMs: number;
  fromMe: boolean;
  senderName: string;
  senderPhoneNumber: string;
  senderAvatarPath: string;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  fromMe: boolean;
  timestampMs: number;
  status: MessageStatus;
  edited: boolean;
  revoked: boolean;
  expiresAtMs: number;
  senderPhoneNumber: string;
  senderAvatarPath: string;
  reactions: Reaction[];
  replyToMessageId: string;
  content: MessageContent | null;
}

export interface ListChatsResponse {
  chats: Chat[];
  totalCount: number;
  nextCursor: string;
}

export interface ListMessagesResponse {
  messages: Message[];
  hasMore: boolean;
}

export interface OpenMessageWindowResponse {
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
  firstUnreadMessageId: string;
}

export interface ListMessagesAfterResponse {
  messages: Message[];
  hasMore: boolean;
}

export interface ContactSearchResult {
  contactJid: string;
  chatId: string;
  displayName: string;
  secondaryName: string;
  phoneNumber: string;
}

export interface MessageSearchResult {
  chatId: string;
  messageId: string;
  chatTitle: string;
  senderName: string;
  timestampMs: number;
  snippet: string;
  kind: string;
  archived: boolean;
  chat: Chat | null;
}

export interface SearchResults {
  contacts: ContactSearchResult[];
  groups: Chat[];
  messages: MessageSearchResult[];
}

export type SearchLocalResponse = SearchResults;

export interface OpenContactResponse {
  chat: Chat | null;
}

export interface ListMessagesAroundResponse {
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
  anchorMessageId: string;
}

export interface SendTextResponse {
  message: Message | null;
}

export interface SendImageResponse {
  message: Message | null;
}

export interface SendStickerResponse {
  message: Message | null;
}

export interface SendAttachmentResponse {
  message: Message | null;
}

export interface GetMessageImageResponse {
  chatId: string;
  messageId: string;
  imagePath: string;
  thumbnailPath: string;
}

export interface GetMessageAttachmentResponse {
  chatId: string;
  messageId: string;
  localPath: string;
}

export type EmptyResponse = Record<string, never>;
export type MarkReadResponse = EmptyResponse;
export type SetTypingResponse = EmptyResponse;
export type LogoutResponse = EmptyResponse;

export interface GetChatAvatarResponse {
  chatId: string;
  avatarPath: string;
}

export interface SendReactionResponse {
  reaction: Reaction | null;
  removed: boolean;
}

export interface ChatParticipant {
  participantId: string;
  displayName: string;
  phoneNumber: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isMe: boolean;
}

export interface ChatInfo {
  chat: Chat | null;
  address: string;
  about: string;
  verifiedName: string;
  description: string;
  createdAtMs: number;
  createdBy: string;
  participantCount: number;
  participants: ChatParticipant[];
  announceOnly: boolean;
  locked: boolean;
  disappearingTimerSeconds: number;
  isCommunity: boolean;
  joinApprovalRequired: boolean;
}

export type GetChatInfoResponse = ChatInfo;

export interface GetParticipantAvatarResponse {
  participantId: string;
  avatarPath: string;
}

export interface RepairRecentReactionsResponse {
  chatId: string;
  requested: boolean;
  attempts: number;
}

export interface ConnectionChanged {
  state: ConnectionState;
  detail: string;
}

export interface PairingQr {
  code: string;
  expiresAtMs: number;
}

export interface SyncProgress {
  chatsProcessed: number;
  messagesProcessed: number;
  complete: boolean;
}

export interface ChatUpserted {
  chat: Chat | null;
}

export interface MessageUpserted {
  message: Message | null;
}

export interface ReceiptUpdated {
  chatId: string;
  messageId: string;
  status: MessageStatus;
  timestampMs: number;
}

export interface BackendProblem {
  code: string;
  message: string;
  fatal: boolean;
}

export interface ReactionUpdated {
  reaction: Reaction | null;
  removed: boolean;
}

export interface RecentReactionsRepaired {
  chatId: string;
  recoveredReactions: number;
  complete: boolean;
}

export interface ChatMerged {
  oldChatId: string;
  newChatId: string;
}

export interface TypingChanged {
  chatId: string;
  senderId: string;
  senderName: string;
  typing: boolean;
  recording: boolean;
}

export interface BridgeExited {
  message: string;
}

/** Discriminated event payload sent through Tauri's IPC Channel. */
export type FrontendEventPayload =
  | { type: "connectionChanged"; payload: ConnectionChanged }
  | { type: "pairingQr"; payload: PairingQr }
  | { type: "syncProgress"; payload: SyncProgress }
  | { type: "chatUpserted"; payload: ChatUpserted }
  | { type: "messageUpserted"; payload: MessageUpserted }
  | { type: "receiptUpdated"; payload: ReceiptUpdated }
  | { type: "problem"; payload: BackendProblem }
  | { type: "reactionUpdated"; payload: ReactionUpdated }
  | { type: "recentReactionsRepaired"; payload: RecentReactionsRepaired }
  | { type: "chatMerged"; payload: ChatMerged }
  | { type: "typingChanged"; payload: TypingChanged }
  | { type: "bridgeExited"; payload: BridgeExited };

/** Backend sequences are monotonic and nonzero; shell-local events use zero. */
export type FrontendEvent = FrontendEventPayload & { sequence: number };
