import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import QRCode from "qrcode";
import {
  CircleAlert,
  Download,
  Files,
  Forward,
  LockKeyhole,
  MessageCircleMore,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import { qrPresentation } from "../state/pairing";
import { assetUrl, bridge, localFileName } from "../lib/bridge";
import { AttachmentKind } from "../lib/types";
import { IconButton, Spinner } from "./Primitives";

export function StartupScreen() {
  return (
    <main class="startup-screen">
      <div class="startup-card">
        <div class="hero-icon"><MessageCircleMore size={58} /></div>
        <h2>Opening Rust Meow</h2>
        <p>Starting the private WhatsApp bridge and loading your conversations.</p>
        <div style={{ "margin-top": "24px" }}><Spinner label="Starting" /></div>
      </div>
    </main>
  );
}

export function PairingScreen(props: { model: AppModel }) {
  const { state, actions } = props.model;
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
  const [now, setNow] = createSignal(Date.now());
  const timer = window.setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => window.clearInterval(timer));
  const qr = () => qrPresentation(state.qrCode, state.qrExpiresAtMs, now());
  createEffect(() => {
    const target = canvas();
    if (!target || !state.qrCode) return;
    void QRCode.toCanvas(target, state.qrCode, {
      width: 248,
      margin: 1,
      color: { dark: "#0b141a", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
  });
  return (
    <main class="pairing-screen">
      <div class="pairing-card">
        <LockKeyhole size={38} color="var(--accent)" />
        <h2>Link Rust Meow to WhatsApp</h2>
        <p>Your session and message cache stay on this computer.</p>
        <Show
          when={qr().phase === "active"}
          fallback={
            <div class="qr-frame">
              <Show
                when={qr().phase === "expired"}
                fallback={<Spinner label="Waiting for a QR code" />}
              >
                <div role="status" class="qr-expired">
                  <CircleAlert size={24} />
                  <strong>QR code expired</strong>
                  <span>Waiting for a fresh code…</span>
                </div>
              </Show>
            </div>
          }
        >
          <div class="qr-frame"><canvas ref={setCanvas} aria-label="WhatsApp pairing QR code" /></div>
        </Show>
        <Show when={qr().phase === "active" && qr().secondsRemaining > 0}>
          <p class="qr-expiry">This code refreshes in {qr().secondsRemaining} seconds.</p>
        </Show>
        <ol class="pairing-steps">
          <li>Open WhatsApp on your phone.</li>
          <li>Go to <strong>Linked devices</strong>, then choose <strong>Link a device</strong>.</li>
          <li>Scan this QR code.</li>
        </ol>
        <button type="button" class="secondary-button" style={{ "margin-top": "18px" }} onClick={() => void actions.refreshPairing()}>
          <RefreshCw size={16} style={{ "vertical-align": "middle", "margin-right": "7px" }} />
          Refresh QR code
        </button>
      </div>
    </main>
  );
}

export function EmptyConversation() {
  return (
    <section class="conversation-empty">
      <div class="conversation-empty-card">
        <div class="hero-icon"><MessageCircleMore size={60} /></div>
        <h2>Rust Meow for desktop</h2>
        <p>Select a conversation or search for a contact to start chatting.</p>
        <p style={{ "margin-top": "15px", display: "flex", "align-items": "center", gap: "7px" }}>
          <ShieldCheck size={15} /> Your linked-device credentials never enter the webview.
        </p>
      </div>
    </section>
  );
}

export function FatalScreen(props: { model: AppModel }) {
  return (
    <main class="fatal-screen">
      <div class="fatal-card">
        <CircleAlert size={46} color="var(--danger)" />
        <h2>Rust Meow needs to restart</h2>
        <p>{props.model.state.fatalError}</p>
        <button type="button" class="primary-button" style={{ "margin-top": "20px" }} onClick={() => void bridge.restartApp()}>
          Restart app
        </button>
      </div>
    </main>
  );
}

/** The final path segment, used as the suggested file name when saving media. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments.at(-1) || "file";
}

export function ImageViewer(props: { model: AppModel }) {
  const viewer = () => props.model.state.imageViewer;
  const close = () => props.model.actions.closeImage();
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  window.addEventListener("keydown", handleKey);
  onCleanup(() => window.removeEventListener("keydown", handleKey));

  async function saveToFolder(path: string) {
    // `saveMediaAs` is landing on `AppModel["actions"]` alongside the CORE
    // agent's save-location work; call it defensively so this button degrades
    // to a no-op rather than a type error until that lands.
    const actions = props.model.actions as AppModel["actions"] & {
      saveMediaAs?: (path: string, suggestedName: string) => Promise<void>;
    };
    if (!actions.saveMediaAs) return;
    try {
      await actions.saveMediaAs(path, basename(path));
    } catch (error) {
      console.error("Could not save the media file", error);
    }
  }

  return (
    <Show when={viewer()}>
      {(value) => (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label={value().sticker ? "Sticker" : "Photo"} onClick={close}>
          <div style={{ position: "fixed", top: "18px", right: "62px" }} onClick={(event) => event.stopPropagation()}>
            <IconButton label="Save to folder" onClick={() => void saveToFolder(value().path)}><Download size={20} /></IconButton>
          </div>
          <IconButton label="Close image" class="modal-close" onClick={close}><X size={21} /></IconButton>
          <div class="image-viewer" onClick={(event) => event.stopPropagation()}>
            <img src={assetUrl(value().path)} alt={value().caption || (value().sticker ? "Sticker" : "Photo")} />
            <Show when={value().caption}><div class="image-viewer-caption">{value().caption}</div></Show>
          </div>
        </div>
      )}
    </Show>
  );
}

export function LogoutDialog(props: { model: AppModel }) {
  const { state, actions } = props.model;
  let cancelButton: HTMLButtonElement | undefined;
  let logoutButton: HTMLButtonElement | undefined;
  createEffect(() => {
    if (state.logoutConfirmation) queueMicrotask(() => cancelButton?.focus());
  });
  return (
    <Show when={state.logoutConfirmation}>
      <div
        class="modal-backdrop"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-title"
        aria-describedby="logout-description"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          if (event.shiftKey && document.activeElement === cancelButton) {
            logoutButton?.focus();
            event.preventDefault();
          } else if (!event.shiftKey && document.activeElement === logoutButton) {
            cancelButton?.focus();
            event.preventDefault();
          }
        }}
      >
        <div class="dialog-card">
          <h2 id="logout-title">Log out of Rust Meow?</h2>
          <p id="logout-description">This unlinks the device and removes the local session, message cache, avatars, and downloaded media stored by Rust Meow on this computer.</p>
          <div class="dialog-actions">
            <button ref={cancelButton} type="button" class="secondary-button" onClick={() => actions.setLogoutConfirmation(false)}>Cancel</button>
            <button ref={logoutButton} type="button" class="danger-button" onClick={() => void actions.logout()}>Log out and delete local data</button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export function ForwardDialog(props: { model: AppModel }) {
  const { state, actions } = props.model;
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string[]>([]);
  const [sending, setSending] = createSignal(false);
  let searchInput: HTMLInputElement | undefined;

  createEffect(() => {
    if (!state.forwardDialog) {
      setQuery("");
      setSelected([]);
      setSending(false);
      return;
    }
    queueMicrotask(() => searchInput?.focus());
  });

  const chats = () => {
    const needle = query().trim().toLocaleLowerCase();
    return state.chats.filter((chat) =>
      !needle || `${chat.title} ${chat.phoneNumber}`.toLocaleLowerCase().includes(needle),
    );
  };
  const toggle = (chatId: string) =>
    setSelected((current) =>
      current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId],
    );

  return (
    <Show when={state.forwardDialog}>
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="forward-title">
        <div class="dialog-card forward-dialog">
          <div class="forward-dialog-heading">
            <Forward size={21} />
            <h2 id="forward-title">Forward message</h2>
          </div>
          <label class="forward-search">
            <Search size={16} />
            <input
              ref={searchInput}
              type="search"
              value={query()}
              placeholder="Search chats"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div class="forward-chat-list" role="group" aria-label="Choose chats">
            <For each={chats()}>
              {(chat) => (
                <label class="forward-chat-row">
                  <input
                    type="checkbox"
                    checked={selected().includes(chat.id)}
                    onChange={() => toggle(chat.id)}
                  />
                  <span>
                    <strong>{chat.title || chat.phoneNumber}</strong>
                    <small>{chat.lastMessagePreview}</small>
                  </span>
                </label>
              )}
            </For>
          </div>
          <div class="dialog-actions">
            <button type="button" class="secondary-button" disabled={sending()} onClick={() => actions.cancelForward()}>Cancel</button>
            <button
              type="button"
              class="primary-button"
              disabled={sending() || selected().length === 0}
              onClick={() => {
                setSending(true);
                void actions.forwardMessage(selected()).finally(() => setSending(false));
              }}
            >
              Forward{selected().length > 0 ? ` to ${selected().length}` : ""}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export function FileSendDialog(props: { model: AppModel }) {
  const { state, actions } = props.model;
  let cancelButton: HTMLButtonElement | undefined;

  createEffect(() => {
    if (state.fileSendConfirmation) queueMicrotask(() => cancelButton?.focus());
  });

  const request = () => state.fileSendConfirmation;
  const count = () => request()?.paths.length ?? 0;
  const supportsCaption = () => {
    const value = request();
    return Boolean(
      value &&
      (value.mode === "image" ||
        (value.mode === "attachment" && value.attachmentKind !== AttachmentKind.Audio)),
    );
  };
  const noun = () => {
    const value = request();
    if (!value) return "file";
    if (value.mode === "image") return count() === 1 ? "photo" : "photos";
    if (value.mode === "sticker") return count() === 1 ? "sticker" : "stickers";
    if (value.attachmentKind === AttachmentKind.Video) return count() === 1 ? "video" : "videos";
    if (value.attachmentKind === AttachmentKind.Audio) return count() === 1 ? "audio file" : "audio files";
    return count() === 1 ? "document" : "documents";
  };

  return (
    <Show when={request()}>
      {(value) => (
        <div class="modal-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="file-send-title">
          <div class="dialog-card file-send-dialog">
            <div class="forward-dialog-heading">
              <Files size={22} />
              <h2 id="file-send-title">Send {count()} {noun()}?</h2>
            </div>
            <p>
              Check your selection before it is sent to{" "}
              {state.chats.find((chat) => chat.id === value().chatId)?.title || "this chat"}.
            </p>
            <div class="file-send-list" role="list" aria-label="Files to send">
              <For each={value().paths}>
                {(path) => (
                  <div class="file-send-row" role="listitem">
                    <Files size={17} />
                    <span title={localFileName(path)}>{localFileName(path)}</span>
                  </div>
                )}
              </For>
            </div>
            <Show
              when={
                (supportsCaption() && props.model.actions.activeDraft(value().chatId).text.trim()) ||
                props.model.actions.activeDraft(value().chatId).replyToMessageId
              }
            >
              <p class="file-send-note">
                {supportsCaption() && props.model.actions.activeDraft(value().chatId).text.trim()
                  ? "Your message will be used as the caption on the first file."
                  : ""}
                {props.model.actions.activeDraft(value().chatId).replyToMessageId
                  ? `${supportsCaption() && props.model.actions.activeDraft(value().chatId).text.trim() ? " " : ""}Your reply context will apply to the first file.`
                  : ""}
              </p>
            </Show>
            <div class="dialog-actions">
              <button ref={cancelButton} type="button" class="secondary-button" disabled={state.sending} onClick={() => actions.cancelFileSend()}>
                Cancel
              </button>
              <button type="button" class="primary-button" disabled={state.sending} onClick={() => void actions.confirmFileSend()}>
                {value().mode === "sticker" ? "Create and send" : "Send"} {count()}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

export function Toasts(props: { model: AppModel }) {
  return (
    <div class="toast-stack" aria-live="assertive">
      <For each={props.model.state.toasts}>
        {(toast) => (
          <div class={`toast ${toast.kind}`}>
            <CircleAlert size={19} />
            <span>{toast.message}</span>
            <IconButton label="Dismiss" onClick={() => props.model.actions.dismissToast(toast.id)}><X size={16} /></IconButton>
          </div>
        )}
      </For>
    </div>
  );
}
