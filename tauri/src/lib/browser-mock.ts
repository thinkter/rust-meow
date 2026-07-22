import {
  AttachmentKind,
  ChatKind,
  ConnectionState,
  MessageStatus,
  type AttachmentContent,
  type Chat,
  type ChatInfo,
  type ChatParticipant,
  type FrontendEventPayload,
  type Message,
  type MessageContent,
  type Reaction,
} from "./types";
import type {
  BackendEventHandler,
  BackendSubscription,
  BridgeApi,
  FilePickerOptions,
} from "./bridge";

const OWN_USER_ID = "919900001111@s.whatsapp.net";
const PROTOCOL_VERSION = 14;
const STARTED_AT = Date.now();
const MINUTE = 60_000;
const DAY = 86_400_000;

interface BrowserFileMetadata {
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface BrowserMockControl {
  listChatIds(): Array<{ id: string; title: string }>;
  archiveChat(chatId: string, archived?: boolean): void;
  muteChat(chatId: string, muted?: boolean): void;
  blockChat(chatId: string, blocked?: boolean): void;
  receiveMessage(chatId: string, text?: string): void;
  setLiveEvents(enabled: boolean): void;
}

declare global {
  interface Window {
    __RUST_MEOW_MOCK__?: BrowserMockControl;
  }
}

const browserFiles = new Map<string, BrowserFileMetadata>();

/** Open a normal browser file input and retain enough metadata for mock sends. */
export function pickBrowserFile(options: FilePickerOptions): Promise<string | null> {
  // A browser cannot hand back a real directory path, and the mock bridge never
  // writes to disk, so answer directory picks with a recognisable placeholder
  // instead of opening a file input the user cannot satisfy.
  if (options.directory) return Promise.resolve("/tmp/rust-meow-mock-downloads");

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    input.dataset.rustMeowBrowserPicker = "true";
    input.accept = (options.filters ?? [])
      .flatMap((filter) => filter.extensions)
      .map((extension) => `.${extension}`)
      .join(",");
    document.body.append(input);

    let settled = false;
    const finish = (path: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(path);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      const path = URL.createObjectURL(file);
      browserFiles.set(path, {
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSize: file.size,
      });
      finish(path);
    }, { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.click();
  });
}

export function browserAssetUrl(path: string | null | undefined): string | undefined {
  return path || undefined;
}

export function openBrowserUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function openBrowserPath(path: string): void {
  const link = document.createElement("a");
  link.href = path;
  const metadata = browserFiles.get(path);
  if (metadata || path.startsWith("data:")) {
    link.download = metadata?.fileName || "rust-meow-attachment";
  } else {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  document.body.append(link);
  link.click();
  link.remove();
}

export function createBrowserMockBridge(): BridgeApi {
  return new BrowserMockBridge();
}

class BrowserMockBridge implements BridgeApi {
  private readonly handlers = new Set<BackendEventHandler>();
  private readonly chats = new Map<string, Chat>();
  private readonly messages = new Map<string, Message[]>();
  private readonly info = new Map<string, ChatInfo>();
  private readonly blockedChats = new Set<string>();
  private delivery = Promise.resolve();
  private activeChatId = "";
  private paired = true;
  private connected = true;
  private liveEvents = true;
  private liveIndex = 0;
  private messageSequence = 0;
  private eventSequence = 0;

  constructor() {
    const fixture = buildFixture();
    for (const chat of fixture.chats) this.chats.set(chat.id, chat);
    for (const [chatId, messages] of fixture.messages) this.messages.set(chatId, messages);
    for (const [chatId, info] of fixture.info) this.info.set(chatId, info);
    this.blockedChats.add("chat-spam");
    this.installControl();
  }

  async subscribeBackend(handler: BackendEventHandler): Promise<BackendSubscription> {
    this.handlers.add(handler);
    this.startLiveEvents();
    return { browserMock: true };
  }

  async hello() {
    return { backendVersion: "browser-mock 0.1.0", protocolVersion: PROTOCOL_VERSION };
  }

  async getAuthState() {
    return {
      paired: this.paired,
      loggedIn: this.connected,
      ownUserId: OWN_USER_ID,
      connectionState: this.connected ? ConnectionState.Connected : ConnectionState.LoggedOut,
    };
  }

  async startPairing() {
    this.connected = false;
    void this.emit({
      type: "connectionChanged",
      payload: { state: ConnectionState.Pairing, detail: "Browser mock pairing" },
    });
    void this.emit({
      type: "pairingQr",
      payload: {
        code: `rust-meow-browser-mock:${Date.now()}`,
        expiresAtMs: Date.now() + 60_000,
      },
    });
    return { started: true };
  }

  async listChats(cursor = "", limit = 100) {
    const offset = parseCursor(cursor);
    const all = this.sortedChats();
    const page = all.slice(offset, offset + normalizedLimit(limit, 100));
    const nextOffset = offset + page.length;
    return {
      chats: copy(page),
      totalCount: all.length,
      nextCursor: nextOffset < all.length ? String(nextOffset) : "",
    };
  }

  async listMessages(
    chatId: string,
    beforeTimestampMs = 0,
    beforeMessageId = "",
    limit = 50,
  ) {
    this.requireChat(chatId);
    const all = this.messageList(chatId);
    const eligible = beforeTimestampMs > 0
      ? all.filter((message) => isBefore(message, beforeTimestampMs, beforeMessageId))
      : all;
    const count = normalizedLimit(limit, 50);
    return {
      messages: copy(eligible.slice(Math.max(0, eligible.length - count))),
      hasMore: eligible.length > count,
    };
  }

  async openMessageWindow(chatId: string) {
    const chat = this.requireChat(chatId);
    this.activeChatId = chatId;
    const all = this.messageList(chatId);
    const start = Math.max(0, all.length - 50);
    const windowMessages = all.slice(start);
    const unreadIncoming = windowMessages.filter((message) => !message.fromMe);
    const unreadIndex = Math.max(0, unreadIncoming.length - chat.unreadCount);
    return {
      messages: copy(windowMessages),
      hasOlder: start > 0,
      hasNewer: false,
      firstUnreadMessageId: chat.unreadCount > 0 ? unreadIncoming[unreadIndex]?.id ?? "" : "",
    };
  }

  async listMessagesAfter(
    chatId: string,
    afterTimestampMs: number,
    afterMessageId: string,
    limit = 50,
  ) {
    this.requireChat(chatId);
    const eligible = this.messageList(chatId).filter((message) =>
      isAfter(message, afterTimestampMs, afterMessageId)
    );
    const count = normalizedLimit(limit, 50);
    return {
      messages: copy(eligible.slice(0, count)),
      hasMore: eligible.length > count,
    };
  }

  async searchLocal(query: string) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return { contacts: [], groups: [], messages: [] };
    const chats = this.sortedChats();
    const contacts = chats
      .filter((chat) => chat.kind === ChatKind.Direct)
      .filter((chat) => chatSearchText(chat).includes(needle))
      .map((chat) => ({
        contactJid: contactJid(chat),
        chatId: chat.id,
        displayName: chat.title,
        secondaryName: chat.pushName || chat.businessName,
        phoneNumber: chat.phoneNumber,
      }));
    if (`dr meera dentist 919811223344`.includes(needle)) {
      contacts.push({
        contactJid: "919811223344@s.whatsapp.net",
        chatId: "",
        displayName: "Dr. Meera Shah",
        secondaryName: "Dentist",
        phoneNumber: "+91 98112 23344",
      });
    }
    const groups = chats.filter((chat) =>
      chat.kind === ChatKind.Group && chatSearchText(chat).includes(needle)
    );
    const messages = chats.flatMap((chat) =>
      this.messageList(chat.id)
        .filter((message) => searchableMessageText(message).includes(needle))
        .map((message) => ({
          chatId: chat.id,
          messageId: message.id,
          chatTitle: chat.title,
          senderName: message.fromMe ? "You" : message.senderName,
          timestampMs: message.timestampMs,
          snippet: messagePreview(message),
          kind: messageKind(message),
          archived: chat.archived,
          chat: copy(chat),
        })),
    ).sort((left, right) => right.timestampMs - left.timestampMs).slice(0, 40);
    return { contacts: copy(contacts), groups: copy(groups), messages: copy(messages) };
  }

  async openContact(contact: string) {
    const existing = this.sortedChats().find((chat) => contactJid(chat) === contact);
    if (existing) return { chat: copy(existing) };
    const phone = contact.split("@")[0] ?? contact;
    const chat = makeChat({
      id: `chat-${phone}`,
      title: contact === "919811223344@s.whatsapp.net" ? "Dr. Meera Shah" : `+${phone}`,
      phoneNumber: `+${phone}`,
      contactName: contact === "919811223344@s.whatsapp.net" ? "Dr. Meera Shah" : "",
      pushName: contact === "919811223344@s.whatsapp.net" ? "Meera" : "",
      lastMessageTimestampMs: 0,
      lastMessagePreview: "No messages yet",
    });
    this.chats.set(chat.id, chat);
    this.messages.set(chat.id, []);
    this.info.set(chat.id, directInfo(chat, "Available"));
    void this.emit({ type: "chatUpserted", payload: { chat: copy(chat) } });
    return { chat: copy(chat) };
  }

  async listMessagesAround(chatId: string, messageId: string) {
    this.requireChat(chatId);
    this.activeChatId = chatId;
    const all = this.messageList(chatId);
    const anchor = all.findIndex((message) => message.id === messageId);
    if (anchor < 0) throw commandFailure("not_found", "That message is no longer in the mock cache");
    const start = Math.max(0, anchor - 24);
    const end = Math.min(all.length, anchor + 25);
    return {
      messages: copy(all.slice(start, end)),
      hasOlder: start > 0,
      hasNewer: end < all.length,
      anchorMessageId: messageId,
    };
  }

  async sendText(
    chatId: string,
    text: string,
    replyToMessageId = "",
    _mentionedJids: string[] = [],
  ) {
    const trimmed = text.trim();
    if (!trimmed) throw commandFailure("invalid_argument", "A message cannot be empty");
    const message = this.outgoing(chatId, { text: textContent(trimmed) }, replyToMessageId);
    return { message: copy(message) };
  }

  async sendImage(chatId: string, imagePath: string, caption = "", replyToMessageId = "") {
    const metadata = browserFiles.get(imagePath);
    const message = this.outgoing(chatId, {
      image: {
        caption,
        mimeType: metadata?.mimeType || "image/jpeg",
        localPath: imagePath || mockPhoto("New photo"),
        width: 1280,
        height: 960,
        fileSize: metadata?.fileSize || 286_000,
        downloadable: false,
        sticker: false,
        animated: false,
        thumbnailPath: imagePath || mockPhoto("New photo"),
      },
    }, replyToMessageId);
    return { message: copy(message) };
  }

  async sendSticker(chatId: string, imagePath: string, replyToMessageId = "") {
    const metadata = browserFiles.get(imagePath);
    const message = this.outgoing(chatId, {
      image: {
        caption: "",
        mimeType: metadata?.mimeType || "image/webp",
        localPath: imagePath || mockSticker("✨"),
        width: 512,
        height: 512,
        fileSize: metadata?.fileSize || 42_000,
        downloadable: false,
        sticker: true,
        animated: false,
        thumbnailPath: imagePath || mockSticker("✨"),
      },
    }, replyToMessageId);
    return { message: copy(message) };
  }

  async sendAttachment(
    chatId: string,
    filePath: string,
    kind: AttachmentKind,
    caption = "",
    replyToMessageId = "",
    voiceNote = false,
  ) {
    const metadata = browserFiles.get(filePath);
    const attachmentKind = attachmentKindName(kind);
    const attachment: AttachmentContent = {
      kind: attachmentKind,
      caption,
      mimeType: metadata?.mimeType || defaultMimeType(kind),
      fileName: metadata?.fileName || defaultFileName(kind),
      localPath: filePath || downloadedAttachment(kind),
      fileSize: metadata?.fileSize || 84_200,
      width: kind === AttachmentKind.Video ? 1280 : 0,
      height: kind === AttachmentKind.Video ? 720 : 0,
      durationSeconds: kind === AttachmentKind.Audio ? 18 : kind === AttachmentKind.Video ? 12 : 0,
      animated: false,
      voiceNote,
      downloadable: false,
    };
    const message = this.outgoing(chatId, { attachment }, replyToMessageId);
    return { message: copy(message) };
  }

  async getMessageImage(chatId: string, messageId: string) {
    const message = this.requireMessage(chatId, messageId);
    if (!(message.content && "image" in message.content)) {
      throw commandFailure("not_media", "That message is not an image");
    }
    const path = message.content.image.localPath || mockPhoto(message.content.image.caption || "Downloaded photo");
    message.content.image.localPath = path;
    message.content.image.thumbnailPath ||= path;
    return { chatId, messageId, imagePath: path, thumbnailPath: message.content.image.thumbnailPath };
  }

  async getMessageAttachment(chatId: string, messageId: string) {
    const message = this.requireMessage(chatId, messageId);
    if (!(message.content && "attachment" in message.content)) {
      throw commandFailure("not_media", "That message has no downloadable attachment");
    }
    message.content.attachment.localPath ||= downloadedAttachment(
      attachmentKindValue(message.content.attachment.kind),
    );
    return { chatId, messageId, localPath: message.content.attachment.localPath };
  }

  async openMediaPath(path: string) {
    openBrowserPath(path);
  }

  async saveMediaAs(sourcePath: string, destinationDir: string, fileName: string) {
    // The mock never touches the filesystem; report the path the native command
    // would have produced so the calling UI can be exercised end to end.
    void sourcePath;
    return `${destinationDir.replace(/\/+$/, "")}/${fileName}`;
  }

  async markRead(chatId: string, _throughMessageId: string) {
    const chat = this.requireChat(chatId);
    if (chat.unreadCount !== 0) {
      chat.unreadCount = 0;
      void this.emit({ type: "chatUpserted", payload: { chat: copy(chat) } });
    }
    return {};
  }

  async getChatAvatar(chatId: string) {
    const chat = this.requireChat(chatId);
    chat.avatarPath ||= avatarDataUrl(chat.title, colorFor(chat.id));
    return { chatId, avatarPath: chat.avatarPath };
  }

  async sendReaction(chatId: string, messageId: string, emoji: string) {
    const message = this.requireMessage(chatId, messageId);
    const existing = message.reactions.find((reaction) => reaction.fromMe);
    message.reactions = message.reactions.filter((reaction) => !reaction.fromMe);
    const removed = emoji.length === 0;
    const reaction: Reaction = existing ?? {
      chatId,
      messageId,
      senderId: OWN_USER_ID,
      emoji,
      timestampMs: Date.now(),
      fromMe: true,
      senderName: "You",
      senderPhoneNumber: "+91 99000 01111",
      senderAvatarPath: "",
    };
    reaction.emoji = emoji;
    reaction.timestampMs = Date.now();
    if (!removed) message.reactions.push(reaction);
    void this.emit({
      type: "reactionUpdated",
      payload: { reaction: copy(reaction), removed },
    });
    return { reaction: copy(reaction), removed };
  }

  async getChatInfo(chatId: string) {
    const chat = this.requireChat(chatId);
    const info = this.info.get(chatId) ?? directInfo(chat, "Hey there! I am using WhatsApp.");
    const response = copy({ ...info, chat });
    if (this.blockedChats.has(chatId)) {
      response.about = "Blocked in the browser mock. Unblock with window.__RUST_MEOW_MOCK__.blockChat(chatId, false).";
    }
    return response;
  }

  async getParticipantAvatar(participantId: string) {
    const name = participantId.split("@")[0] ?? participantId;
    return { participantId, avatarPath: avatarDataUrl(name, colorFor(participantId)) };
  }

  async repairRecentReactions(chatId: string) {
    this.requireChat(chatId);
    return { chatId, requested: true, attempts: 1 };
  }

  async setTyping(chatId: string, _composing: boolean) {
    this.requireChat(chatId);
    return {};
  }

  async logout() {
    this.paired = false;
    this.connected = false;
    this.activeChatId = "";
    void this.emit({
      type: "connectionChanged",
      payload: { state: ConnectionState.LoggedOut, detail: "Browser mock logged out" },
    });
    return {};
  }

  async restartApp(): Promise<never> {
    window.location.reload();
    return new Promise<never>(() => undefined);
  }

  private outgoing(chatId: string, content: MessageContent, replyToMessageId: string): Message {
    this.assertCanSend(chatId);
    if (replyToMessageId) this.requireMessage(chatId, replyToMessageId);
    const timestampMs = Date.now();
    const message = makeMessage({
      id: `mock-out-${timestampMs}-${++this.messageSequence}`,
      chatId,
      timestampMs,
      fromMe: true,
      senderId: OWN_USER_ID,
      senderName: "You",
      content,
      replyToMessageId,
      status: MessageStatus.Pending,
    });
    this.messageList(chatId).push(message);
    this.touchChat(chatId, message, false);
    this.scheduleReceipts(message);
    return message;
  }

  private scheduleReceipts(message: Message): void {
    const statuses = [MessageStatus.Sent, MessageStatus.Delivered, MessageStatus.Read] as const;
    const delays = [120, 520, 1_250];
    statuses.forEach((status, index) => {
      window.setTimeout(() => {
        message.status = status;
        void this.emit({
          type: "receiptUpdated",
          payload: {
            chatId: message.chatId,
            messageId: message.id,
            status,
            timestampMs: Date.now(),
          },
        });
      }, delays[index]);
    });
  }

  private addIncoming(chatId: string, text: string): void {
    if (this.blockedChats.has(chatId)) return;
    const chat = this.requireChat(chatId);
    const participant = firstOtherParticipant(this.info.get(chatId));
    const timestampMs = Date.now();
    const message = makeMessage({
      id: `mock-in-${timestampMs}-${++this.messageSequence}`,
      chatId,
      timestampMs,
      fromMe: false,
      senderId: participant?.participantId || contactJid(chat),
      senderName: participant?.displayName || chat.title,
      senderPhoneNumber: participant?.phoneNumber || chat.phoneNumber,
      content: { text: textContent(text) },
      status: MessageStatus.Read,
    });
    this.messageList(chatId).push(message);
    chat.lastMessagePreview = messagePreview(message);
    chat.lastMessageTimestampMs = message.timestampMs;
    if (chatId !== this.activeChatId) chat.unreadCount += 1;
    void this.emit({ type: "messageUpserted", payload: { message: copy(message) } });
    void this.emit({ type: "chatUpserted", payload: { chat: copy(chat) } });
  }

  private touchChat(chatId: string, message: Message, incrementUnread: boolean): void {
    const chat = this.requireChat(chatId);
    chat.lastMessagePreview = messagePreview(message);
    chat.lastMessageTimestampMs = message.timestampMs;
    if (incrementUnread && !message.fromMe) chat.unreadCount += 1;
    void this.emit({ type: "chatUpserted", payload: { chat: copy(chat) } });
  }

  private assertCanSend(chatId: string): void {
    this.requireChat(chatId);
    if (!this.connected) throw commandFailure("offline", "The browser mock is logged out", true);
    if (this.blockedChats.has(chatId)) {
      throw commandFailure(
        "blocked",
        "This browser-mock contact is blocked. Unblock it from window.__RUST_MEOW_MOCK__ first.",
      );
    }
  }

  private requireChat(chatId: string): Chat {
    const chat = this.chats.get(chatId);
    if (!chat) throw commandFailure("not_found", `Unknown mock chat: ${chatId}`);
    return chat;
  }

  private messageList(chatId: string): Message[] {
    const messages = this.messages.get(chatId);
    if (!messages) throw commandFailure("not_found", `No mock history for chat: ${chatId}`);
    return messages;
  }

  private requireMessage(chatId: string, messageId: string): Message {
    this.requireChat(chatId);
    const message = this.messageList(chatId).find((candidate) => candidate.id === messageId);
    if (!message) throw commandFailure("not_found", `Unknown mock message: ${messageId}`);
    return message;
  }

  private sortedChats(): Chat[] {
    return [...this.chats.values()].sort((left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.lastMessageTimestampMs - left.lastMessageTimestampMs ||
      left.id.localeCompare(right.id)
    );
  }

  private emit(event: FrontendEventPayload): Promise<void> {
    const sequenced = { ...event, sequence: ++this.eventSequence };
    this.delivery = this.delivery.then(async () => {
      for (const handler of this.handlers) await handler(copy(sequenced));
    }).catch((error: unknown) => {
      console.error("Rust Meow browser mock event handler failed", error);
    });
    return this.delivery;
  }

  private startLiveEvents(): void {
    window.setInterval(() => {
      if (!this.liveEvents || !this.connected) return;
      const scenarios = [
        ["chat-family", "Boarding now — save me a window seat ✈️"],
        ["chat-priya", "Perfect, I’ll bring coffee ☕"],
        ["chat-design", "The updated prototype is ready for review."],
      ] as const;
      const [chatId, text] = scenarios[this.liveIndex++ % scenarios.length];
      const chat = this.requireChat(chatId);
      const participant = firstOtherParticipant(this.info.get(chatId));
      const senderId = participant?.participantId || contactJid(chat);
      const senderName = participant?.displayName || chat.title;
      void this.emit({
        type: "typingChanged",
        payload: { chatId, senderId, senderName, typing: true, recording: false },
      });
      window.setTimeout(() => {
        this.addIncoming(chatId, text);
        void this.emit({
          type: "typingChanged",
          payload: { chatId, senderId, senderName, typing: false, recording: false },
        });
      }, 1_100);
    }, 7_500);
  }

  private installControl(): void {
    window.__RUST_MEOW_MOCK__ = {
      listChatIds: () => this.sortedChats().map(({ id, title }) => ({ id, title })),
      archiveChat: (chatId, archived) => this.patchChatFlag(chatId, "archived", archived),
      muteChat: (chatId, muted) => this.patchChatFlag(chatId, "muted", muted),
      blockChat: (chatId, blocked = true) => {
        this.requireChat(chatId);
        if (blocked) this.blockedChats.add(chatId);
        else this.blockedChats.delete(chatId);
        void this.emit({
          type: "problem",
          payload: {
            code: "browser_mock",
            message: `${this.requireChat(chatId).title} is now ${blocked ? "blocked" : "unblocked"} in the browser mock.`,
            fatal: false,
          },
        });
      },
      receiveMessage: (chatId, text = "A manually injected browser-mock message") => {
        this.addIncoming(chatId, text);
      },
      setLiveEvents: (enabled) => {
        this.liveEvents = enabled;
      },
    };
  }

  private patchChatFlag(chatId: string, field: "archived" | "muted", value?: boolean): void {
    const chat = this.requireChat(chatId);
    chat[field] = value ?? !chat[field];
    void this.emit({ type: "chatUpserted", payload: { chat: copy(chat) } });
  }
}

function buildFixture(): {
  chats: Chat[];
  messages: Map<string, Message[]>;
  info: Map<string, ChatInfo>;
} {
  const chats = [
    makeChat({ id: "chat-family", kind: ChatKind.Group, title: "Family Weekend", pinned: true, unreadCount: 4, lastMessagePreview: "Aarav: Train leaves at 6:20", lastMessageTimestampMs: STARTED_AT - 2 * MINUTE }),
    makeChat({ id: "chat-priya", title: "Priya Nair", phoneNumber: "+91 98765 41020", contactName: "Priya Nair", pushName: "Priya", muted: true, pinned: true, lastMessagePreview: "The photos came out so well!", lastMessageTimestampMs: STARTED_AT - 8 * MINUTE }),
    makeChat({ id: "chat-design", kind: ChatKind.Group, title: "Design Crew", unreadCount: 2, lastMessagePreview: "Maya: Prototype review at 3?", lastMessageTimestampMs: STARTED_AT - 19 * MINUTE }),
    makeChat({ id: "chat-ravi", title: "Ravi Kulkarni", phoneNumber: "+91 99887 76655", contactName: "Ravi Kulkarni", pushName: "Ravi", unreadCount: 1, lastMessagePreview: "Can you send the address?", lastMessageTimestampMs: STARTED_AT - 42 * MINUTE }),
    makeChat({ id: "chat-grocer", title: "Green Basket", phoneNumber: "+91 80412 00991", businessName: "Green Basket Organics", lastMessagePreview: "Your order is out for delivery", lastMessageTimestampMs: STARTED_AT - 78 * MINUTE }),
    makeChat({ id: "chat-flat", kind: ChatKind.Group, title: "Flat 4B", lastMessagePreview: "I paid the electricity bill", lastMessageTimestampMs: STARTED_AT - 4 * 60 * MINUTE }),
    makeChat({ id: "chat-maya", title: "Maya Thomas", phoneNumber: "+91 97000 12345", contactName: "Maya Thomas", pushName: "Maya", lastMessagePreview: "Voice message", lastMessageTimestampMs: STARTED_AT - 8 * 60 * MINUTE }),
    makeChat({ id: "chat-product", kind: ChatKind.Group, title: "Product Launch", muted: true, lastMessagePreview: "Nikhil: Docs are updated", lastMessageTimestampMs: STARTED_AT - DAY }),
    makeChat({ id: "chat-office", kind: ChatKind.Group, title: "Old Office Crew", archived: true, lastMessagePreview: "Lunch sometime next week?", lastMessageTimestampMs: STARTED_AT - 3 * DAY }),
    makeChat({ id: "chat-college", kind: ChatKind.Group, title: "College Reunion 2019", archived: true, muted: true, unreadCount: 6, lastMessagePreview: "48 new messages", lastMessageTimestampMs: STARTED_AT - 5 * DAY }),
    makeChat({ id: "chat-spam", title: "Unknown sender", phoneNumber: "+91 91111 00000", archived: true, lastMessagePreview: "This contact is blocked", lastMessageTimestampMs: STARTED_AT - 12 * DAY }),
    makeChat({ id: "chat-alice", title: "Alice Fernandes", phoneNumber: "+91 98220 33445", contactName: "Alice Fernandes", pushName: "Alice", lastMessagePreview: "See you Friday!", lastMessageTimestampMs: STARTED_AT - 18 * DAY }),
  ];

  const messages = new Map<string, Message[]>();
  messages.set("chat-family", familyMessages());
  messages.set("chat-priya", priyaMessages());
  messages.set("chat-design", designMessages());
  messages.set("chat-ravi", simpleConversation("chat-ravi", "Ravi Kulkarni", "919988776655@s.whatsapp.net", [
    "Hey, are you free this evening?",
    "After seven should work.",
    "Can you send the address?",
  ]));
  messages.set("chat-grocer", simpleConversation("chat-grocer", "Green Basket", "918041200991@s.whatsapp.net", [
    "Thanks for ordering from Green Basket Organics.",
    "Your order is packed and ready.",
    "Your order is out for delivery",
  ]));
  messages.set("chat-flat", simpleConversation("chat-flat", "Neha", "919700220033@s.whatsapp.net", [
    "The water cans are here.",
    "I paid the electricity bill",
  ]));
  messages.set("chat-maya", mayaMessages());
  messages.set("chat-product", simpleConversation("chat-product", "Nikhil", "919844445555@s.whatsapp.net", [
    "QA is green for the release candidate.",
    "Docs are updated with the migration steps.",
  ]));
  messages.set("chat-office", simpleConversation("chat-office", "Kabir", "919811110909@s.whatsapp.net", [
    "Found this group while cleaning up chats 😄",
    "Lunch sometime next week?",
  ]));
  messages.set("chat-college", simpleConversation("chat-college", "Ananya", "919966667777@s.whatsapp.net", [
    "Reunion venue poll closes tonight.",
    "I vote for the campus lawn.",
    "Who still has the 2019 group photo?",
  ]));
  messages.set("chat-spam", [makeMessage({
    id: "spam-1",
    chatId: "chat-spam",
    timestampMs: STARTED_AT - 12 * DAY,
    fromMe: false,
    senderId: "919111100000@s.whatsapp.net",
    senderName: "Unknown sender",
    senderPhoneNumber: "+91 91111 00000",
    content: { unsupported: { typeName: "blocked_contact", fallbackText: "This contact is blocked in the browser mock" } },
    status: MessageStatus.Read,
  })]);
  messages.set("chat-alice", simpleConversation("chat-alice", "Alice Fernandes", "919822033445@s.whatsapp.net", [
    "Your talk was excellent!",
    "Thank you — that means a lot.",
    "See you Friday!",
  ]));

  const info = new Map<string, ChatInfo>();
  for (const chat of chats) {
    info.set(chat.id, chat.kind === ChatKind.Group ? groupInfo(chat) : directInfo(chat, directAbout(chat.id)));
  }
  return { chats, messages, info };
}

function familyMessages(): Message[] {
  const chatId = "chat-family";
  const aarav = "919820001010@s.whatsapp.net";
  const leela = "919811112222@s.whatsapp.net";
  const messages = [
    makeMessage({ id: "family-01", chatId, timestampMs: STARTED_AT - DAY - 95 * MINUTE, fromMe: false, senderId: leela, senderName: "Leela", senderPhoneNumber: "+91 98111 12222", content: { text: textContent("I booked the homestay for Saturday 🏡") }, status: MessageStatus.Read }),
    makeMessage({ id: "family-02", chatId, timestampMs: STARTED_AT - DAY - 86 * MINUTE, fromMe: true, senderId: OWN_USER_ID, senderName: "You", content: { text: textContent("Amazing. Here is the route: https://www.openstreetmap.org") }, status: MessageStatus.Read }),
    makeMessage({ id: "family-03", chatId, timestampMs: STARTED_AT - DAY - 72 * MINUTE, fromMe: false, senderId: aarav, senderName: "Aarav", senderPhoneNumber: "+91 98200 01010", content: { image: imageContent("Sunrise from the last trip", "") }, status: MessageStatus.Read }),
    makeMessage({ id: "family-04", chatId, timestampMs: STARTED_AT - DAY - 68 * MINUTE, fromMe: true, senderId: OWN_USER_ID, senderName: "You", content: { text: textContent("That view! Let’s leave before traffic.") }, replyToMessageId: "family-03", status: MessageStatus.Read }),
    makeMessage({ id: "family-05", chatId, timestampMs: STARTED_AT - DAY - 41 * MINUTE, fromMe: false, senderId: leela, senderName: "Leela", senderPhoneNumber: "+91 98111 12222", content: { attachment: attachmentContent("document", "weekend-plan.pdf", "application/pdf", "Packing checklist", 184_220) }, status: MessageStatus.Read }),
    makeMessage({ id: "family-06", chatId, timestampMs: STARTED_AT - DAY - 24 * MINUTE, fromMe: false, senderId: aarav, senderName: "Aarav", senderPhoneNumber: "+91 98200 01010", content: { location: { latitude: 12.4244, longitude: 75.7382, name: "Madikeri Homestay", address: "Galibeedu Road, Madikeri", url: "https://www.openstreetmap.org/?mlat=12.4244&mlon=75.7382", live: false } }, status: MessageStatus.Read }),
    makeMessage({ id: "family-07", chatId, timestampMs: STARTED_AT - 17 * MINUTE, fromMe: false, senderId: leela, senderName: "Leela", senderPhoneNumber: "+91 98111 12222", content: { contacts: { contacts: [{ displayName: "Homestay host", vcard: "BEGIN:VCARD\nFN:Homestay host\nTEL:+919900001234\nEND:VCARD" }] } }, status: MessageStatus.Read }),
    makeMessage({ id: "family-08", chatId, timestampMs: STARTED_AT - 12 * MINUTE, fromMe: true, senderId: OWN_USER_ID, senderName: "You", content: { image: stickerContent("🚗") }, status: MessageStatus.Read }),
    makeMessage({ id: "family-09", chatId, timestampMs: STARTED_AT - 9 * MINUTE, fromMe: false, senderId: aarav, senderName: "Aarav", senderPhoneNumber: "+91 98200 01010", content: { text: textContent("I’ll pick everyone up near the metro.") }, status: MessageStatus.Read }),
    makeMessage({ id: "family-10", chatId, timestampMs: STARTED_AT - 6 * MINUTE, fromMe: false, senderId: leela, senderName: "Leela", senderPhoneNumber: "+91 98111 12222", content: { text: textContent("I have snacks covered ✅") }, status: MessageStatus.Read }),
    makeMessage({ id: "family-11", chatId, timestampMs: STARTED_AT - 4 * MINUTE, fromMe: false, senderId: aarav, senderName: "Aarav", senderPhoneNumber: "+91 98200 01010", content: { text: textContent("Train leaves at 6:20") }, status: MessageStatus.Read }),
  ];
  messages[2]!.reactions.push(reaction(chatId, "family-03", leela, "Leela", "❤️"));
  messages[2]!.reactions.push(reaction(chatId, "family-03", OWN_USER_ID, "You", "❤️", true));
  return messages;
}

function priyaMessages(): Message[] {
  const chatId = "chat-priya";
  const priya = "919876541020@s.whatsapp.net";
  return [
    makeMessage({ id: "priya-01", chatId, timestampMs: STARTED_AT - 7 * 60 * MINUTE, fromMe: false, senderId: priya, senderName: "Priya Nair", senderPhoneNumber: "+91 98765 41020", content: { text: textContent("Did you get home okay?") }, status: MessageStatus.Read }),
    makeMessage({ id: "priya-02", chatId, timestampMs: STARTED_AT - 6 * 60 * MINUTE, fromMe: true, senderId: OWN_USER_ID, senderName: "You", content: { text: textContent("Yep! Thanks for checking.") }, status: MessageStatus.Read }),
    makeMessage({ id: "priya-03", chatId, timestampMs: STARTED_AT - 47 * MINUTE, fromMe: false, senderId: priya, senderName: "Priya Nair", senderPhoneNumber: "+91 98765 41020", content: { attachment: { ...attachmentContent("audio", "voice-note.ogg", "audio/ogg", "", 32_400), durationSeconds: 18, voiceNote: true } }, status: MessageStatus.Read }),
    makeMessage({ id: "priya-04", chatId, timestampMs: STARTED_AT - 31 * MINUTE, fromMe: true, senderId: OWN_USER_ID, senderName: "You", content: { text: textContent("I’ll send the album tonight.") }, status: MessageStatus.Delivered }),
    makeMessage({ id: "priya-05", chatId, timestampMs: STARTED_AT - 8 * MINUTE, fromMe: false, senderId: priya, senderName: "Priya Nair", senderPhoneNumber: "+91 98765 41020", content: { image: { ...imageContent("The photos came out so well!", mockPhoto("Night market")), downloadable: false } }, status: MessageStatus.Read }),
  ];
}

function designMessages(): Message[] {
  const chatId = "chat-design";
  return [
    makeMessage({ id: "design-01", chatId, timestampMs: STARTED_AT - 5 * 60 * MINUTE, fromMe: false, senderId: "919700012345@s.whatsapp.net", senderName: "Maya", senderPhoneNumber: "+91 97000 12345", content: { text: textContent("I pushed the revised onboarding flow.") }, status: MessageStatus.Read }),
    makeMessage({ id: "design-02", chatId, timestampMs: STARTED_AT - 4 * 60 * MINUTE, fromMe: true, senderId: OWN_USER_ID, senderName: "You", content: { text: textContent("The reduced motion states look much better.") }, status: MessageStatus.Read }),
    makeMessage({ id: "design-03", chatId, timestampMs: STARTED_AT - 90 * MINUTE, fromMe: false, senderId: "919944400011@s.whatsapp.net", senderName: "Dev", senderPhoneNumber: "+91 99444 00011", content: { attachment: attachmentContent("video", "prototype-walkthrough.mp4", "video/mp4", "Latest prototype", 4_820_000) }, status: MessageStatus.Read }),
    makeMessage({ id: "design-04", chatId, timestampMs: STARTED_AT - 19 * MINUTE, fromMe: false, senderId: "919700012345@s.whatsapp.net", senderName: "Maya", senderPhoneNumber: "+91 97000 12345", content: { text: textContent("Prototype review at 3?") }, status: MessageStatus.Read }),
  ];
}

function mayaMessages(): Message[] {
  const messages = simpleConversation("chat-maya", "Maya Thomas", "919700012345@s.whatsapp.net", [
    "Are we still on for the design review?",
    "Yes, 3 PM works.",
  ]);
  messages.push(makeMessage({
    id: "maya-audio",
    chatId: "chat-maya",
    timestampMs: STARTED_AT - 8 * 60 * MINUTE,
    fromMe: false,
    senderId: "919700012345@s.whatsapp.net",
    senderName: "Maya Thomas",
    senderPhoneNumber: "+91 97000 12345",
    content: { attachment: { ...attachmentContent("audio", "voice-note.ogg", "audio/ogg", "", 29_800), durationSeconds: 12, voiceNote: true } },
    status: MessageStatus.Read,
  }));
  return messages.sort(messageOrder);
}

function simpleConversation(chatId: string, senderName: string, senderId: string, texts: string[]): Message[] {
  return texts.map((text, index) => makeMessage({
    id: `${chatId}-${index + 1}`,
    chatId,
    timestampMs: STARTED_AT - (texts.length - index) * 23 * MINUTE,
    fromMe: index % 3 === 1,
    senderId: index % 3 === 1 ? OWN_USER_ID : senderId,
    senderName: index % 3 === 1 ? "You" : senderName,
    senderPhoneNumber: index % 3 === 1 ? "" : `+${senderId.split("@")[0]}`,
    content: { text: textContent(text) },
    status: MessageStatus.Read,
  }));
}

function makeChat(input: Partial<Chat> & Pick<Chat, "id" | "title">): Chat {
  return {
    id: input.id,
    kind: input.kind ?? ChatKind.Direct,
    title: input.title,
    avatarPath: input.avatarPath ?? "",
    lastMessagePreview: input.lastMessagePreview ?? "",
    lastMessageTimestampMs: input.lastMessageTimestampMs ?? STARTED_AT,
    unreadCount: input.unreadCount ?? 0,
    muted: input.muted ?? false,
    pinned: input.pinned ?? false,
    archived: input.archived ?? false,
    phoneNumber: input.phoneNumber ?? "",
    contactName: input.contactName ?? "",
    pushName: input.pushName ?? "",
    businessName: input.businessName ?? "",
  };
}

function makeMessage(input: {
  id: string;
  chatId: string;
  timestampMs: number;
  fromMe: boolean;
  senderId: string;
  senderName: string;
  content: MessageContent | null;
  status: MessageStatus;
  senderPhoneNumber?: string;
  replyToMessageId?: string;
}): Message {
  return {
    id: input.id,
    chatId: input.chatId,
    senderId: input.senderId,
    senderName: input.senderName,
    fromMe: input.fromMe,
    timestampMs: input.timestampMs,
    status: input.status,
    edited: false,
    revoked: false,
    expiresAtMs: 0,
    senderPhoneNumber: input.senderPhoneNumber ?? "",
    senderAvatarPath: "",
    reactions: [],
    replyToMessageId: input.replyToMessageId ?? "",
    content: input.content,
  };
}

function textContent(text: string) {
  const url = text.match(/https?:\/\/[^\s]+/)?.[0] ?? "";
  return {
    text,
    linkPreview: url
      ? {
          url,
          title: "OpenStreetMap",
          description: "Maps and directions shared in this conversation",
          jpegThumbnail: [],
          thumbnailWidth: 0,
          thumbnailHeight: 0,
        }
      : null,
  };
}

function imageContent(caption: string, localPath: string) {
  return {
    caption,
    mimeType: "image/jpeg",
    localPath,
    width: 1280,
    height: 853,
    fileSize: 342_000,
    downloadable: !localPath,
    sticker: false,
    animated: false,
    thumbnailPath: "",
  };
}

function stickerContent(label: string) {
  const path = mockSticker(label);
  return {
    ...imageContent("", path),
    mimeType: "image/webp",
    width: 512,
    height: 512,
    fileSize: 31_000,
    downloadable: false,
    sticker: true,
    thumbnailPath: path,
  };
}

function attachmentContent(
  kind: string,
  fileName: string,
  mimeType: string,
  caption: string,
  fileSize: number,
): AttachmentContent {
  return {
    kind,
    caption,
    mimeType,
    fileName,
    localPath: "",
    fileSize,
    width: kind === "video" ? 1280 : 0,
    height: kind === "video" ? 720 : 0,
    durationSeconds: kind === "video" ? 12 : 0,
    animated: false,
    voiceNote: false,
    downloadable: true,
  };
}

function reaction(
  chatId: string,
  messageId: string,
  senderId: string,
  senderName: string,
  emoji: string,
  fromMe = false,
): Reaction {
  return {
    chatId,
    messageId,
    senderId,
    emoji,
    timestampMs: STARTED_AT - 70 * MINUTE,
    fromMe,
    senderName,
    senderPhoneNumber: "",
    senderAvatarPath: "",
  };
}

function groupInfo(chat: Chat): ChatInfo {
  const participants: ChatParticipant[] = chat.id === "chat-family"
    ? [
        participant(OWN_USER_ID, "You", "+91 99000 01111", true, false, true),
        participant("919820001010@s.whatsapp.net", "Aarav", "+91 98200 01010", true, true),
        participant("919811112222@s.whatsapp.net", "Leela", "+91 98111 12222"),
        participant("919933344455@s.whatsapp.net", "Amma", "+91 99333 44455"),
      ]
    : [
        participant(OWN_USER_ID, "You", "+91 99000 01111", false, false, true),
        participant("919700012345@s.whatsapp.net", "Maya", "+91 97000 12345", true),
        participant("919944400011@s.whatsapp.net", "Dev", "+91 99444 00011"),
        participant("919844445555@s.whatsapp.net", "Nikhil", "+91 98444 45555"),
      ];
  return {
    chat,
    address: `${chat.id}@g.us`,
    about: "",
    verifiedName: "",
    description: chat.id === "chat-family"
      ? "Weekend plans, recipes, and the occasional terrible joke."
      : `${chat.title} coordination and updates.`,
    createdAtMs: STARTED_AT - 540 * DAY,
    createdBy: participants.find((item) => item.isSuperAdmin)?.displayName ?? "Maya",
    participantCount: participants.length,
    participants,
    announceOnly: chat.id === "chat-product",
    locked: chat.id === "chat-product",
    disappearingTimerSeconds: chat.id === "chat-design" ? 604_800 : 0,
    isCommunity: chat.id === "chat-product",
    joinApprovalRequired: chat.id === "chat-college",
  };
}

function directInfo(chat: Chat, about: string): ChatInfo {
  return {
    chat,
    address: contactJid(chat),
    about,
    verifiedName: chat.businessName,
    description: "",
    createdAtMs: 0,
    createdBy: "",
    participantCount: 0,
    participants: [],
    announceOnly: false,
    locked: false,
    disappearingTimerSeconds: chat.id === "chat-priya" ? 86_400 : 0,
    isCommunity: false,
    joinApprovalRequired: false,
  };
}

function participant(
  participantId: string,
  displayName: string,
  phoneNumber: string,
  isAdmin = false,
  isSuperAdmin = false,
  isMe = false,
): ChatParticipant {
  return { participantId, displayName, phoneNumber, isAdmin, isSuperAdmin, isMe };
}

function directAbout(chatId: string): string {
  const about: Record<string, string> = {
    "chat-priya": "Building, travelling, and always looking for good coffee.",
    "chat-ravi": "Available",
    "chat-grocer": "Fresh produce delivered every day from 8 AM to 8 PM.",
    "chat-maya": "Designing thoughtful software.",
    "chat-spam": "This contact is blocked in the browser mock.",
    "chat-alice": "Hey there! I am using WhatsApp.",
  };
  return about[chatId] ?? "Hey there! I am using WhatsApp.";
}

function firstOtherParticipant(info: ChatInfo | undefined): ChatParticipant | undefined {
  return info?.participants.find((participant) => !participant.isMe);
}

function contactJid(chat: Chat): string {
  const digits = chat.phoneNumber.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : `${chat.id}@g.us`;
}

function chatSearchText(chat: Chat): string {
  return `${chat.title} ${chat.phoneNumber} ${chat.contactName} ${chat.pushName} ${chat.businessName}`.toLocaleLowerCase();
}

function searchableMessageText(message: Message): string {
  return `${message.senderName} ${messagePreview(message)}`.toLocaleLowerCase();
}

function messagePreview(message: Message): string {
  if (message.revoked) return "This message was deleted";
  if (!message.content) return "Message";
  if ("text" in message.content) return message.content.text.text;
  if ("image" in message.content) return message.content.image.caption || (message.content.image.sticker ? "Sticker" : "Photo");
  if ("attachment" in message.content) {
    return message.content.attachment.caption || message.content.attachment.fileName || attachmentKindName(attachmentKindValue(message.content.attachment.kind));
  }
  if ("contacts" in message.content) return "Contact";
  if ("location" in message.content) return message.content.location.name || "Location";
  return message.content.unsupported.fallbackText || "Unsupported message";
}

function messageKind(message: Message): string {
  if (!message.content) return "unknown";
  return Object.keys(message.content)[0] ?? "unknown";
}

function isBefore(message: Message, timestampMs: number, messageId: string): boolean {
  return message.timestampMs < timestampMs ||
    (message.timestampMs === timestampMs && (!messageId || message.id.localeCompare(messageId) < 0));
}

function isAfter(message: Message, timestampMs: number, messageId: string): boolean {
  return message.timestampMs > timestampMs ||
    (message.timestampMs === timestampMs && message.id.localeCompare(messageId) > 0);
}

function messageOrder(left: Message, right: Message): number {
  return left.timestampMs - right.timestampMs || left.id.localeCompare(right.id);
}

function parseCursor(cursor: string): number {
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedLimit(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(200, Math.floor(value)) : fallback;
}

function commandFailure(code: string, message: string, retryable = false) {
  return { code, message, retryable };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function colorFor(seed: string): string {
  const palette = ["#4f46e5", "#0f766e", "#be123c", "#a16207", "#7e22ce", "#0369a1"];
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

function avatarDataUrl(name: string, background: string): string {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase()).join("") || "?";
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="64" fill="${background}"/><text x="64" y="70" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="44" font-family="system-ui,sans-serif" font-weight="700">${escapeXml(initials)}</text></svg>`);
}

function mockPhoto(label: string): string {
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 853"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0f766e"/><stop offset="1" stop-color="#172554"/></linearGradient></defs><rect width="1280" height="853" fill="url(#g)"/><circle cx="980" cy="190" r="90" fill="#fde68a" opacity=".9"/><path d="M0 710 300 390 510 615 730 320 1100 710Z" fill="#d1fae5" opacity=".7"/><text x="58" y="790" fill="white" font-size="44" font-family="system-ui,sans-serif">${escapeXml(label)}</text></svg>`);
}

function mockSticker(label: string): string {
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="220" fill="#fef3c7" stroke="#f59e0b" stroke-width="18"/><text x="256" y="285" text-anchor="middle" font-size="190" font-family="system-ui,sans-serif">${escapeXml(label)}</text></svg>`);
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]!);
}

function attachmentKindName(kind: AttachmentKind): string {
  if (kind === AttachmentKind.Video) return "video";
  if (kind === AttachmentKind.Audio) return "audio";
  return "document";
}

function attachmentKindValue(kind: string): AttachmentKind {
  if (kind === "video") return AttachmentKind.Video;
  if (kind === "audio") return AttachmentKind.Audio;
  return AttachmentKind.Document;
}

function defaultMimeType(kind: AttachmentKind): string {
  if (kind === AttachmentKind.Video) return "video/mp4";
  if (kind === AttachmentKind.Audio) return "audio/ogg";
  return "application/octet-stream";
}

function defaultFileName(kind: AttachmentKind): string {
  if (kind === AttachmentKind.Video) return "video.mp4";
  if (kind === AttachmentKind.Audio) return "audio.ogg";
  return "document.txt";
}

function downloadedAttachment(kind: AttachmentKind): string {
  if (kind === AttachmentKind.Video) {
    return "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
  }
  if (kind === AttachmentKind.Audio) {
    return "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  }
  return `data:text/plain;charset=utf-8,${encodeURIComponent("Rust Meow browser mock attachment\n\nThis file was generated locally for UI dogfooding.")}`;
}
