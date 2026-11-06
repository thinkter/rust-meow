export type VimCommand =
  | "move-up"
  | "move-down"
  | "move-left"
  | "move-right"
  | "last"
  | "pending-g"
  | "focus-composer"
  | "focus-search"
  | "toggle-spotlight"
  | "close-tab"
  | "reply"
  | "edit"
  | "forward"
  | "pin"
  | "toggle-members"
  | "chat-info"
  | "settings"
  | "toggle-shortcuts";

export interface VimKeyInput {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** Resolve unmodified normal-mode keys; text editing is filtered by the caller. */
export function resolveVimCommand(input: VimKeyInput): VimCommand | null {
  if (input.altKey || input.ctrlKey || input.metaKey) return null;
  switch (input.key) {
    case "j":
    case "ArrowDown":
      return "move-down";
    case "k":
    case "ArrowUp":
      return "move-up";
    case "h":
    case "ArrowLeft":
      return "move-left";
    case "l":
    case "ArrowRight":
      return "move-right";
    case "G":
    case "End":
      return "last";
    case "g":
      return "pending-g";
    case "i":
      return "focus-composer";
    case "/":
      return "focus-search";
    case "o":
      return "toggle-spotlight";
    case "x":
    case "d":
      return "close-tab";
    case "r":
      return "reply";
    case "e":
      return "edit";
    case "f":
      return "forward";
    case "p":
      return "pin";
    case "m":
      return "toggle-members";
    case "c":
      return "chat-info";
    case "s":
      return "settings";
    case "?":
      return "toggle-shortcuts";
    default:
      return null;
  }
}

/** Window event name carrying a message-list command to the focused pane. */
export const VIM_MESSAGE_EVENT = "rust-meow-vim-message";

/** `step` moves the virtual message cursor by one; `edge` selects the first or last loaded message. */
export type VimMessageCommand =
  | { kind: "step"; direction: -1 | 1 }
  | { kind: "edge"; edge: "first" | "last" };

export interface VimMessageEventDetail {
  paneId: string;
  chatId: string;
  command: VimMessageCommand;
}

/** The virtual message cursor, keyed by message id so prepends and trims do not shift it. */
export interface VimMessageCursor {
  id: string;
  index: number;
}

export interface VisibleIndexRange {
  first: number;
  last: number;
}

/** Index of the cursor's message in `ids`, or null when there is no cursor or no messages. */
export function resolveVimCursorIndex(
  ids: readonly string[],
  cursor: VimMessageCursor | null,
): number | null {
  if (!cursor || ids.length === 0) return null;
  if (ids[cursor.index] === cursor.id) return cursor.index;
  const found = ids.indexOf(cursor.id);
  if (found >= 0) return found;
  return Math.max(0, Math.min(ids.length - 1, cursor.index));
}

/**
 * Target index for a message-list command. Without a cursor, a step lands on
 * the nearest visible edge in its direction (top for `j`, bottom for `k`), so
 * the first press always selects something on screen. Returns null for an
 * empty list. `current` must already be a valid index (see
 * `resolveVimCursorIndex`).
 */
export function resolveVimMessageIndex(input: {
  count: number;
  current: number | null;
  command: VimMessageCommand;
  visible: VisibleIndexRange | null;
}): number | null {
  const { count, current, command, visible } = input;
  if (count <= 0) return null;
  const last = count - 1;
  if (command.kind === "edge") return command.edge === "first" ? 0 : last;
  let target: number;
  if (current !== null) target = current + command.direction;
  else if (visible) target = command.direction > 0 ? visible.first : visible.last;
  else target = command.direction > 0 ? 0 : last;
  return Math.max(0, Math.min(last, target));
}

/** Inclusive index range of items intersecting the half-open viewport `[viewportStart, viewportEnd)`. */
export function resolveVisibleIndexRange(
  items: readonly { index: number; start: number; end: number }[],
  viewportStart: number,
  viewportEnd: number,
): VisibleIndexRange | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.end <= viewportStart || item.start >= viewportEnd) continue;
    first = Math.min(first, item.index);
    last = Math.max(last, item.index);
  }
  return first === Number.POSITIVE_INFINITY ? null : { first, last };
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) ||
    (typeof HTMLElement !== "undefined" && target instanceof HTMLElement && target.isContentEditable)
  );
}
