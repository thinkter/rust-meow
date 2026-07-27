interface SyncStatusView {
  phase: number;
  revision: number;
  messagesProcessed: number;
  whatsAppProgress: number;
  completedAtMs: number;
  detail: string;
}

export function syncStatusActive(status: SyncStatusView): boolean {
  return (
    status.phase === 2 ||
    status.phase === 3 ||
    status.phase === 4 ||
    status.phase === 5
  );
}

export function shouldApplySyncStatus(current: SyncStatusView, next: SyncStatusView): boolean {
  return next.revision >= current.revision;
}

export function syncStatusLabel(status: SyncStatusView, locale?: string): string {
  switch (status.phase) {
    case 2:
      return "Checking WhatsApp sync";
    case 3:
      return `Syncing ${status.messagesProcessed.toLocaleString(locale)} messages (${status.whatsAppProgress}%)`;
    case 4:
      return "Finishing local setup";
    case 5:
      return "Catching up with recent messages";
    case 6:
      return status.completedAtMs > 0
        ? `Up to date · ${new Date(status.completedAtMs).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`
        : "Up to date";
    case 7:
      if (status.messagesProcessed === 0 && status.whatsAppProgress === 0) {
        return "Sync incomplete · Initial chat history was not received; relink this device to request it again";
      }
      return status.detail ? `Sync incomplete · ${status.detail}` : "Sync incomplete";
    case 8:
      return status.detail || "Sync failed";
    case 9:
      return "Offline · sync will resume when connected";
    default:
      return status.detail || "Waiting for initial sync";
  }
}

export function emptyConversationSyncMessage(status: SyncStatusView): string | null {
  switch (status.phase) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return "This chat's history is still syncing. Messages will appear when WhatsApp sends them.";
    case 7:
      if (status.messagesProcessed === 0 && status.whatsAppProgress === 0) {
        return "This chat's history was not received from WhatsApp. Relink this device to request initial history again.";
      }
      return status.detail
        ? `This chat's history has not been received. ${status.detail}.`
        : "This chat's history has only partially synced.";
    case 8:
      return status.detail
        ? `This chat's history could not be synced. ${status.detail}.`
        : "This chat's history could not be synced.";
    case 9:
      return "This chat has no messages stored locally. Sync will resume when WhatsApp reconnects.";
    default:
      return null;
  }
}
