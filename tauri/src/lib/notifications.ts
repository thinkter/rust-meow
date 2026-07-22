import { getCurrentWindow } from "@tauri-apps/api/window";

import { browserMockEnabled } from "./bridge";
import type { Chat, Message } from "./types";
import { notificationBody, notificationTitle } from "./notification-policy";

export interface NotificationTarget {
  chatId: string;
  messageId: string;
}

/** Request the OS permission only after the user has enabled notifications. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (browserMockEnabled) return false;
  const plugin = await import("@tauri-apps/plugin-notification");
  if (await plugin.isPermissionGranted()) return true;
  return (await plugin.requestPermission()) === "granted";
}

export async function sendMessageNotification(
  chat: Chat | undefined,
  message: Message,
  showPreview: boolean,
): Promise<boolean> {
  if (!(await ensureNotificationPermission())) return false;
  const plugin = await import("@tauri-apps/plugin-notification");
  plugin.sendNotification({
    title: notificationTitle(chat, message),
    body: notificationBody(message, showPreview),
    group: message.chatId,
    autoCancel: true,
    extra: { chatId: message.chatId, messageId: message.id },
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
  const plugin = await import("@tauri-apps/plugin-notification");
  const listener = await plugin.onAction((notification) => {
    const chatId = notification.extra?.chatId;
    const messageId = notification.extra?.messageId;
    if (typeof chatId !== "string" || typeof messageId !== "string" || !chatId || !messageId) return;
    void (async () => {
      const window = getCurrentWindow();
      await window.show().catch(() => undefined);
      await window.setFocus().catch(() => undefined);
      await open({ chatId, messageId });
    })();
  });
  return () => listener.unregister();
}
