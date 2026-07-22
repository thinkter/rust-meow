import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { browserMockEnabled } from "./bridge";
import {
  NotificationPermissionGate,
  type NotificationTarget,
} from "./notification-routing";
import type { Chat, Message } from "./types";
import { notificationBody, notificationTitle } from "./notification-policy";

export type { NotificationTarget } from "./notification-routing";

const permissionGate = new NotificationPermissionGate();

/** Request the OS permission only after the user has enabled notifications. */
export async function ensureNotificationPermission(refresh = false): Promise<boolean> {
  if (browserMockEnabled) return false;
  return permissionGate.check(async () => {
    const plugin = await import("@tauri-apps/plugin-notification");
    if (await plugin.isPermissionGranted()) return true;
    return (await plugin.requestPermission()) === "granted";
  }, refresh);
}

export async function sendMessageNotification(
  chat: Chat | undefined,
  message: Message,
  showPreview: boolean,
): Promise<boolean> {
  if (!(await ensureNotificationPermission())) return false;
  await invoke("show_message_notification", {
    title: notificationTitle(chat, message),
    body: notificationBody(message, showPreview),
    chatId: message.chatId,
    messageId: message.id,
  });
  return true;
}

/**
 * Route notification activation back to the exact message. The listener is
 * registered before backend bootstrap so a click delivered during startup is
 * not lost. Invalid/unrelated plugin actions are ignored.
 */
export async function listenForNotificationActions(
  open: (target: NotificationTarget) => void | Promise<void>,
): Promise<() => void> {
  if (browserMockEnabled) return () => undefined;
  const disposers: Array<() => void> = [];
  let active = true;
  const activate = (target: NotificationTarget) => {
    void (async () => {
      if (!active) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (!active) return;
      const window = getCurrentWindow();
      await window.show().catch(() => undefined);
      await window.setFocus().catch(() => undefined);
      if (!active) return;
      await open(target);
    })();
  };

  const unlisten = await listen<NotificationTarget>("notification-activated", ({ payload }) => {
    activate(payload);
    void invoke<NotificationTarget[]>("take_notification_activations")
      .then((targets) => targets.forEach(activate))
      .catch(() => undefined);
  });
  disposers.push(unlisten);

  // Retain the plugin action path for platforms which provide it, while the
  // native command below supplies reliable desktop click callbacks.
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    const listener = await plugin.onAction((notification) => {
      const chatId = notification.extra?.chatId;
      const messageId = notification.extra?.messageId;
      if (typeof chatId === "string" && typeof messageId === "string") {
        activate({ chatId, messageId });
      }
    });
    disposers.push(() => listener.unregister());
  } catch (error) {
    console.warn("Notification plugin action listener is unavailable", error);
  }

  // Register the event listener first, then drain targets captured before the
  // webview was ready. Duplicate delivery is removed by the app-level queue.
  const pending = await invoke<NotificationTarget[]>("take_notification_activations").catch(() => []);
  for (const target of pending) activate(target);

  return () => {
    active = false;
    for (const dispose of disposers) dispose();
  };
}
