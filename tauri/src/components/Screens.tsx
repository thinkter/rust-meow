import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import QRCode from "qrcode";
import {
  CircleAlert,
  LockKeyhole,
  MessageCircleMore,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import { qrPresentation } from "../state/pairing";
import { assetUrl, bridge } from "../lib/bridge";
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
        <LockKeyhole size={38} color="var(--accent-bright)" />
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

export function ImageViewer(props: { model: AppModel }) {
  const viewer = () => props.model.state.imageViewer;
  const close = () => props.model.actions.closeImage();
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  window.addEventListener("keydown", handleKey);
  onCleanup(() => window.removeEventListener("keydown", handleKey));
  return (
    <Show when={viewer()}>
      {(value) => (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label={value().sticker ? "Sticker" : "Photo"} onClick={close}>
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
          <p id="logout-description">This unlinks the device and permanently removes the local session, message cache, avatars, and downloaded media from this computer.</p>
          <div class="dialog-actions">
            <button ref={cancelButton} type="button" class="secondary-button" onClick={() => actions.setLogoutConfirmation(false)}>Cancel</button>
            <button ref={logoutButton} type="button" class="danger-button" onClick={() => void actions.logout()}>Log out and delete local data</button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export function Toasts(props: { model: AppModel }) {
  return (
    <div class="toast-stack" aria-live="assertive">
      {props.model.state.toasts.map((toast) => (
        <div class={`toast ${toast.kind}`}>
          <CircleAlert size={19} />
          <span>{toast.message}</span>
          <IconButton label="Dismiss" onClick={() => props.model.actions.dismissToast(toast.id)}><X size={16} /></IconButton>
        </div>
      ))}
    </div>
  );
}
