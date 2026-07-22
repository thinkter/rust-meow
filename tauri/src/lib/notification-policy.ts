import type { Chat, Message } from "./types.ts";

export interface NotificationPolicyInput {
  enabled: boolean;
  visible: boolean;
  chatVisible: boolean;
  muted: boolean;
  incoming: boolean;
}

export function shouldNotify(input: NotificationPolicyInput): boolean {
  return (
    input.enabled &&
    input.incoming &&
    !input.muted &&
    !(input.visible && input.chatVisible)
  );
}

export function notificationTitle(chat: Chat | undefined, message: Message): string {
  return chat?.title || message.senderName || chat?.phoneNumber || "New WhatsApp message";
}

export function notificationBody(message: Message, showPreview: boolean): string {
  if (!showPreview) return "New message";
  const content = message.content;
  let preview = "Message";
  if (message.revoked) preview = "This message was deleted";
  else if (content && "text" in content) preview = content.text.text;
  else if (content && "image" in content) preview = content.image.caption || (content.image.sticker ? "Sticker" : "Photo");
  else if (content && "attachment" in content) preview = content.attachment.caption || content.attachment.fileName || content.attachment.kind || "Attachment";
  else if (content && "contacts" in content) preview = content.contacts.contacts.length === 1 ? content.contacts.contacts[0]?.displayName || "Contact" : `${content.contacts.contacts.length} contacts`;
  else if (content && "location" in content) preview = content.location.name || content.location.address || "Location";
  else if (content && "unsupported" in content) preview = content.unsupported.fallbackText || content.unsupported.typeName || "Message";
  const text = preview.replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text || "New message";
}
