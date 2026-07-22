import type { Chat, Message } from "./types";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
});
const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

export function formatTime(timestampMs: number): string {
  if (!timestampMs) return "";
  return timeFormatter.format(new Date(timestampMs));
}

export function formatChatTime(timestampMs: number): string {
  if (!timestampMs) return "";
  const value = new Date(timestampMs);
  const now = new Date();
  if (sameDay(value, now)) return timeFormatter.format(value);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(value, yesterday)) return "Yesterday";
  const age = now.getTime() - value.getTime();
  if (age < 7 * 86_400_000) return weekdayFormatter.format(value);
  return shortDateFormatter.format(value);
}

export function formatDay(timestampMs: number): string {
  const value = new Date(timestampMs);
  const now = new Date();
  if (sameDay(value, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(value, yesterday)) return "Yesterday";
  return dayFormatter.format(value);
}

export function dayKey(timestampMs: number): string {
  const value = new Date(timestampMs);
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
}

export function messageText(message: Message): string {
  if (message.revoked) return "This message was deleted";
  const content = message.content;
  if (!content) return "Message";
  if ("text" in content) return content.text.text;
  if ("image" in content) {
    if (content.image.caption) return content.image.caption;
    return content.image.sticker ? "Sticker" : "Photo";
  }
  if ("attachment" in content) {
    return (
      content.attachment.caption ||
      content.attachment.fileName ||
      content.attachment.kind ||
      "Attachment"
    );
  }
  if ("contacts" in content) {
    const count = content.contacts.contacts.length;
    return count === 1
      ? content.contacts.contacts[0]?.displayName || "Contact"
      : `${count} contacts`;
  }
  if ("location" in content) {
    return content.location.name || content.location.address || "Location";
  }
  if ("poll" in content) return `Poll: ${content.poll.question}`;
  return content.unsupported.fallbackText || content.unsupported.typeName || "Message";
}

export function chatSubtitle(chat: Chat): string {
  return chat.lastMessagePreview || chat.phoneNumber || "No messages yet";
}

export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) return "?";
  const first = Array.from(words[0] ?? "?")[0] ?? "?";
  const last = words.length > 1 ? Array.from(words.at(-1) ?? "")[0] ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

export function hueFor(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!seconds) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`
    : `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function connectionLabel(connection: number): string {
  return (
    [
      "Starting",
      "Starting",
      "Pairing",
      "Connecting",
      "Connected",
      "Reconnecting",
      "Offline",
      "Logged out",
      "Connection failed",
    ][connection] ?? "Unknown"
  );
}

export function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
