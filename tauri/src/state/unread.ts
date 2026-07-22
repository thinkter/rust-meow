/**
 * Returns the only safe optimistic badge value for a visible read boundary.
 *
 * A bounded window with newer messages cannot prove how many unread rows lie
 * beyond its last incoming message. Keep the backend-provided count until the
 * mark-read operation emits an authoritative chat upsert. A window at the
 * newest boundary can safely clear the badge immediately.
 */
export function optimisticUnreadCount(current: number, hasNewer: boolean): number {
  return hasNewer ? current : 0;
}

/**
 * Roll back an optimistic badge only while both the value and its backend
 * revision are unchanged. The revision distinguishes an authoritative upsert
 * that confirms the same value from the absence of any backend update.
 */
export function shouldRestoreOptimisticUnread(
  current: number | undefined,
  optimistic: number,
  revisionBefore: number,
  revisionNow: number,
): boolean {
  return current === optimistic && revisionNow === revisionBefore;
}
