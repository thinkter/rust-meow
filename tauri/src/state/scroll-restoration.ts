/**
 * Framework-independent message viewport restoration helpers.
 *
 * A raw scrollTop is not stable when older rows are prepended or media changes
 * height. Persist the first visible message plus its offset from the viewport
 * instead, and resolve that anchor against the next bounded message window.
 */

export interface ScrollSnapshot {
  anchorMessageId: string;
  anchorOffset: number;
  atLatest: boolean;
}

export interface VirtualRow {
  index: number;
  start: number;
  end: number;
}

export type ScrollRestoreTarget =
  | { kind: "anchor"; index: number; offset: number }
  | { kind: "unread"; index: number }
  | { kind: "latest"; index: number }
  | { kind: "empty" };

export function captureScrollSnapshot(
  messageIds: readonly string[],
  virtualRows: readonly VirtualRow[],
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  latestTolerance = 80,
): ScrollSnapshot | undefined {
  if (messageIds.length === 0 || virtualRows.length === 0) return undefined;
  const firstVisible = virtualRows.find((row) => row.end > scrollTop) ?? virtualRows[0];
  const anchorMessageId = firstVisible ? messageIds[firstVisible.index] : undefined;
  if (!firstVisible || !anchorMessageId) return undefined;
  return {
    anchorMessageId,
    anchorOffset: firstVisible.start - scrollTop,
    atLatest: scrollHeight - scrollTop - clientHeight <= latestTolerance,
  };
}

export function resolveScrollRestore(
  messageIds: readonly string[],
  snapshot: ScrollSnapshot | undefined,
  firstUnreadMessageId: string,
): ScrollRestoreTarget {
  if (messageIds.length === 0) return { kind: "empty" };
  if (snapshot?.atLatest) return { kind: "latest", index: messageIds.length - 1 };
  if (snapshot) {
    const index = messageIds.indexOf(snapshot.anchorMessageId);
    if (index >= 0) return { kind: "anchor", index, offset: snapshot.anchorOffset };
  }
  const unreadIndex = firstUnreadMessageId ? messageIds.indexOf(firstUnreadMessageId) : -1;
  if (unreadIndex >= 0) return { kind: "unread", index: unreadIndex };
  return { kind: "latest", index: messageIds.length - 1 };
}

