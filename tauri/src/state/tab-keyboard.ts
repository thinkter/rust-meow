import type { Pane } from "./workspace";

export type TabKeyboardCommand =
  | { kind: "reorder"; index: number; direction: "left" | "right" }
  | { kind: "move-pane"; paneId: string; index: number; direction: "left" | "right" }
  | { kind: "close" }
  | { kind: "boundary"; message: string };

export interface TabKeyboardInput {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  platformModifier: boolean;
}

/** Translate tab-strip keyboard gestures without touching the DOM. */
export function tabKeyboardCommand(
  input: TabKeyboardInput,
  panes: readonly Pane[],
  paneId: string,
  chatId: string,
): TabKeyboardCommand | undefined {
  const paneIndex = panes.findIndex((pane) => pane.id === paneId);
  const pane = panes[paneIndex];
  if (!pane) return undefined;
  const tabIndex = pane.tabChatIds.indexOf(chatId);
  if (tabIndex < 0) return undefined;

  if (input.key === "Delete" && !input.altKey && !input.platformModifier) {
    return { kind: "close" };
  }

  if (input.altKey && input.shiftKey && !input.platformModifier) {
    if (input.key !== "ArrowLeft" && input.key !== "ArrowRight") return undefined;
    const delta = input.key === "ArrowLeft" ? -1 : 1;
    const nextIndex = tabIndex + delta;
    if (nextIndex < 0 || nextIndex >= pane.tabChatIds.length) {
      return {
        kind: "boundary",
        message: `Tab is already ${delta < 0 ? "first" : "last"} in this pane`,
      };
    }
    return { kind: "reorder", index: nextIndex, direction: delta < 0 ? "left" : "right" };
  }

  if (input.platformModifier && input.shiftKey && !input.altKey) {
    if (input.key !== "ArrowLeft" && input.key !== "ArrowRight") return undefined;
    const delta = input.key === "ArrowLeft" ? -1 : 1;
    const targetPane = panes[paneIndex + delta];
    if (!targetPane) {
      return {
        kind: "boundary",
        message: `There is no pane to the ${delta < 0 ? "left" : "right"}`,
      };
    }
    return {
      kind: "move-pane",
      paneId: targetPane.id,
      index: Math.min(tabIndex, targetPane.tabChatIds.length),
      direction: delta < 0 ? "left" : "right",
    };
  }

  return undefined;
}
