import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";

import {
  browserAssetUrl,
  createBrowserMockBridge,
  openBrowserUrl,
  pickBrowserFile,
} from "./browser-mock";
import { SendIdempotency } from "./send-idempotency";

import type {
  AttachmentKind,
  CommandError,
  FrontendEvent,
  GetChatAvatarResponse,
  GetChatInfoResponse,
  GetMessageAttachmentResponse,
  GetMessageImageResponse,
  GetParticipantAvatarResponse,
  HelloResponse,
  AuthStateResponse,
  ListChatsResponse,
  ListMessagesAfterResponse,
  ListMessagesAroundResponse,
  ListMessagesResponse,
  LogoutResponse,
  MarkReadResponse,
  OpenContactResponse,
  OpenMessageWindowResponse,
  RepairRecentReactionsResponse,
  SearchLocalResponse,
  SendAttachmentResponse,
  SendImageResponse,
  SendReactionResponse,
  SendStickerResponse,
  SendTextResponse,
  SetTypingResponse,
  StartPairingResponse,
} from "./types";

export type BackendEventHandler = (
  event: FrontendEvent,
) => void | Promise<void>;

export interface BrowserBackendSubscription {
  readonly browserMock: true;
}

export type BackendSubscription =
  | Channel<FrontendEvent>
  | BrowserBackendSubscription;

export interface FilePickerOptions {
  multiple?: false;
  directory?: false;
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

const hasTauriInternals =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True only for Vite development opened in a normal browser. */
export const browserMockEnabled = import.meta.env.DEV && !hasTauriInternals;

/** One normalized failure shape for Rust command, transport, and IPC errors. */
export class BridgeError extends Error implements CommandError {
  readonly code: string;
  readonly retryable: boolean;
  readonly cause: unknown;

  constructor(error: CommandError, cause?: unknown) {
    super(error.message);
    this.name = "BridgeError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function commandErrorFrom(value: unknown): CommandError | undefined {
  if (!isRecord(value)) return undefined;
  const { code, message, retryable } = value;
  if (
    typeof code !== "string" ||
    typeof message !== "string" ||
    typeof retryable !== "boolean"
  ) {
    return undefined;
  }
  return { code, message, retryable };
}

/** Convert any Tauri rejection into a structured Error instance. */
export function normalizeBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;

  const structured = commandErrorFrom(error);
  if (structured) return new BridgeError(structured, error);

  if (typeof error === "string") {
    try {
      const parsed: unknown = JSON.parse(error);
      const parsedError = commandErrorFrom(parsed);
      if (parsedError) return new BridgeError(parsedError, error);
    } catch {
      // Ordinary string rejections are handled below.
    }
    return new BridgeError(
      { code: "invoke", message: error, retryable: false },
      error,
    );
  }

  if (error instanceof Error) {
    return new BridgeError(
      { code: "invoke", message: error.message, retryable: false },
      error,
    );
  }

  return new BridgeError(
    {
      code: "invoke",
      message: "The native command failed without an error message",
      retryable: false,
    },
    error,
  );
}

async function invokeCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeBridgeError(error);
  }
}

/**
 * Subscribe before starting pairing/loading state. Tauri Channel itself
 * restores IPC message order; this small promise chain also prevents async UI
 * handlers from overtaking one another.
 */
export async function subscribeBackend(
  handler: BackendEventHandler,
): Promise<Channel<FrontendEvent>> {
  let delivery = Promise.resolve();
  const onEvent = new Channel<FrontendEvent>((event) => {
    delivery = delivery
      .then(() => handler(event))
      .then(() => undefined)
      .catch((error: unknown) => {
        // Handler failures are isolated so one bad render cannot stop the
        // ordered delivery of all later backend events.
        console.error("Rust Meow backend event handler failed", error);
      });
  });
  await invokeCommand<void>("subscribe_backend", { onEvent });
  return onEvent;
}

/** Convert a trusted local filesystem path for use in an img/audio src. */
export function assetUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return browserMockEnabled ? browserAssetUrl(path) : convertFileSrc(path);
}

/** Use Tauri's picker in the app and a normal file input during browser dev. */
export async function openFile(options: FilePickerOptions): Promise<string | null> {
  if (browserMockEnabled) return pickBrowserFile(options);
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open(options);
  return typeof result === "string" ? result : null;
}

/** Open a web URL without making components depend directly on Tauri. */
export async function openUrl(url: string): Promise<void> {
  if (browserMockEnabled) {
    openBrowserUrl(url);
    return;
  }
  const opener = await import("@tauri-apps/plugin-opener");
  await opener.openUrl(url);
}

export interface BridgeApi {
  subscribeBackend(handler: BackendEventHandler): Promise<BackendSubscription>;
  hello(): Promise<HelloResponse>;
  getAuthState(): Promise<AuthStateResponse>;
  startPairing(): Promise<StartPairingResponse>;
  listChats(cursor?: string, limit?: number): Promise<ListChatsResponse>;
  listMessages(
    chatId: string,
    beforeTimestampMs?: number,
    beforeMessageId?: string,
    limit?: number,
  ): Promise<ListMessagesResponse>;
  openMessageWindow(chatId: string): Promise<OpenMessageWindowResponse>;
  listMessagesAfter(
    chatId: string,
    afterTimestampMs: number,
    afterMessageId: string,
    limit?: number,
  ): Promise<ListMessagesAfterResponse>;
  searchLocal(query: string): Promise<SearchLocalResponse>;
  openContact(contactJid: string): Promise<OpenContactResponse>;
  listMessagesAround(
    chatId: string,
    messageId: string,
  ): Promise<ListMessagesAroundResponse>;
  sendText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    mentionedJids?: string[],
  ): Promise<SendTextResponse>;
  sendImage(
    chatId: string,
    imagePath: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<SendImageResponse>;
  sendSticker(
    chatId: string,
    imagePath: string,
    replyToMessageId?: string,
  ): Promise<SendStickerResponse>;
  sendAttachment(
    chatId: string,
    filePath: string,
    kind: AttachmentKind,
    caption?: string,
    replyToMessageId?: string,
    voiceNote?: boolean,
  ): Promise<SendAttachmentResponse>;
  getMessageImage(
    chatId: string,
    messageId: string,
  ): Promise<GetMessageImageResponse>;
  getMessageAttachment(
    chatId: string,
    messageId: string,
  ): Promise<GetMessageAttachmentResponse>;
  openMediaPath(path: string): Promise<void>;
  markRead(
    chatId: string,
    throughMessageId: string,
  ): Promise<MarkReadResponse>;
  getChatAvatar(chatId: string): Promise<GetChatAvatarResponse>;
  sendReaction(
    chatId: string,
    messageId: string,
    emoji: string,
  ): Promise<SendReactionResponse>;
  getChatInfo(chatId: string): Promise<GetChatInfoResponse>;
  getParticipantAvatar(
    participantId: string,
  ): Promise<GetParticipantAvatarResponse>;
  repairRecentReactions(
    chatId: string,
  ): Promise<RepairRecentReactionsResponse>;
  setTyping(chatId: string, composing: boolean): Promise<SetTypingResponse>;
  logout(): Promise<LogoutResponse>;
  restartApp(): Promise<never>;
}

const sendIdempotency = new SendIdempotency();

/** Typed, camelCase native facade over every registered Tauri command. */
const nativeBridge: BridgeApi = {
  subscribeBackend,
  hello: () => invokeCommand<HelloResponse>("hello"),
  getAuthState: () => invokeCommand<AuthStateResponse>("get_auth_state"),
  startPairing: () => invokeCommand<StartPairingResponse>("start_pairing"),
  listChats: (cursor = "", limit = 100) =>
    invokeCommand<ListChatsResponse>("list_chats", { cursor, limit }),
  listMessages: (
    chatId,
    beforeTimestampMs = 0,
    beforeMessageId = "",
    limit = 50,
  ) =>
    invokeCommand<ListMessagesResponse>("list_messages", {
      chatId,
      beforeTimestampMs,
      beforeMessageId,
      limit,
    }),
  openMessageWindow: (chatId) =>
    invokeCommand<OpenMessageWindowResponse>("open_message_window", { chatId }),
  listMessagesAfter: (
    chatId,
    afterTimestampMs,
    afterMessageId,
    limit = 50,
  ) =>
    invokeCommand<ListMessagesAfterResponse>("list_messages_after", {
      chatId,
      afterTimestampMs,
      afterMessageId,
      limit,
    }),
  searchLocal: (query) =>
    invokeCommand<SearchLocalResponse>("search_local", { query }),
  openContact: (contactJid) =>
    invokeCommand<OpenContactResponse>("open_contact", { contactJid }),
  listMessagesAround: (chatId, messageId) =>
    invokeCommand<ListMessagesAroundResponse>("list_messages_around", {
      chatId,
      messageId,
    }),
  sendText: (chatId, text, replyToMessageId = "", mentionedJids = []) =>
    sendIdempotency.run(
      chatId,
      ["text", text, replyToMessageId, [...mentionedJids]],
      (clientMessageId) =>
        invokeCommand<SendTextResponse>("send_text", {
          clientMessageId,
          chatId,
          text,
          replyToMessageId,
          mentionedJids,
        }),
    ),
  sendImage: (chatId, imagePath, caption = "", replyToMessageId = "") =>
    sendIdempotency.run(
      chatId,
      ["image", imagePath, caption, replyToMessageId],
      (clientMessageId) =>
        invokeCommand<SendImageResponse>("send_image", {
          clientMessageId,
          chatId,
          imagePath,
          caption,
          replyToMessageId,
        }),
    ),
  sendSticker: (chatId, imagePath, replyToMessageId = "") =>
    sendIdempotency.run(
      chatId,
      ["sticker", imagePath, replyToMessageId],
      (clientMessageId) =>
        invokeCommand<SendStickerResponse>("send_sticker", {
          clientMessageId,
          chatId,
          imagePath,
          replyToMessageId,
        }),
    ),
  sendAttachment: (
    chatId,
    filePath,
    kind,
    caption = "",
    replyToMessageId = "",
    voiceNote = false,
  ) =>
    sendIdempotency.run(
      chatId,
      ["attachment", filePath, kind, caption, replyToMessageId, voiceNote],
      (clientMessageId) =>
        invokeCommand<SendAttachmentResponse>("send_attachment", {
          clientMessageId,
          chatId,
          filePath,
          kind,
          caption,
          replyToMessageId,
          voiceNote,
        }),
    ),
  getMessageImage: (chatId, messageId) =>
    invokeCommand<GetMessageImageResponse>("get_message_image", {
      chatId,
      messageId,
    }),
  getMessageAttachment: (chatId, messageId) =>
    invokeCommand<GetMessageAttachmentResponse>("get_message_attachment", {
      chatId,
      messageId,
    }),
  openMediaPath: (path) => invokeCommand<void>("open_media_path", { path }),
  markRead: (chatId, throughMessageId) =>
    invokeCommand<MarkReadResponse>("mark_read", {
      chatId,
      throughMessageId,
    }),
  getChatAvatar: (chatId) =>
    invokeCommand<GetChatAvatarResponse>("get_chat_avatar", { chatId }),
  sendReaction: (chatId, messageId, emoji) =>
    invokeCommand<SendReactionResponse>("send_reaction", {
      chatId,
      messageId,
      emoji,
    }),
  getChatInfo: (chatId) =>
    invokeCommand<GetChatInfoResponse>("get_chat_info", { chatId }),
  getParticipantAvatar: (participantId) =>
    invokeCommand<GetParticipantAvatarResponse>("get_participant_avatar", {
      participantId,
    }),
  repairRecentReactions: (chatId) =>
    invokeCommand<RepairRecentReactionsResponse>("repair_recent_reactions", {
      chatId,
    }),
  setTyping: (chatId, composing) =>
    invokeCommand<SetTypingResponse>("set_typing", { chatId, composing }),
  logout: () => invokeCommand<LogoutResponse>("logout"),
  restartApp: () => invokeCommand<never>("restart_app"),
};

/**
 * Plain `pnpm dev` uses deterministic local data; every Tauri webview keeps
 * using the native IPC implementation, including development webviews.
 */
export const bridge: BridgeApi = browserMockEnabled
  ? createBrowserMockBridge()
  : nativeBridge;
