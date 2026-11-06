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
  | "settings";

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
    default:
      return null;
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) ||
    (typeof HTMLElement !== "undefined" && target instanceof HTMLElement && target.isContentEditable)
  );
}
