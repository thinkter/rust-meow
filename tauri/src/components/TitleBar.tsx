import { For, onCleanup, onMount, Show, createSignal } from "solid-js";
import { Columns2, MessageCircle, Minus, Square, X } from "lucide-solid";
import type { AppModel } from "../state/app";
import { browserMockEnabled } from "../lib/bridge";
import { IconButton } from "./Primitives";
import { Tabs } from "./Tabs";

/**
 * The eight literal directions `Window.startResizeDragging` accepts. The
 * Tauri JS API declares this union internally (`ResizeDirection` in
 * `@tauri-apps/api/window`) but does not export the type name, so it is
 * repeated here structurally — passing one of these string literals still
 * type-checks against the real method signature because TypeScript compares
 * unions structurally, not by name.
 */
type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const RESIZE_HANDLES: ReadonlyArray<{ cls: string; direction: ResizeDirection }> = [
  { cls: "n", direction: "North" },
  { cls: "s", direction: "South" },
  { cls: "e", direction: "East" },
  { cls: "w", direction: "West" },
  { cls: "ne", direction: "NorthEast" },
  { cls: "nw", direction: "NorthWest" },
  { cls: "se", direction: "SouthEast" },
  { cls: "sw", direction: "SouthWest" },
];

/**
 * Custom chrome that replaces the OS title bar (goal G5). It renders on
 * every screen — startup, pairing, fatal, and chats — so an undecorated
 * Linux window never shows a bare, resize-borderless edge no matter which
 * screen is up. Every window-manager call goes through a lazily-imported
 * `@tauri-apps/api/window` handle, guarded by `browserMockEnabled`, because
 * the browser dev mock has no `__TAURI_INTERNALS__` to call into.
 *
 * Each pane's tabs live directly in this bar, replacing the OS title bar
 * instead of consuming another row of conversation space. In split view the
 * two strips sit side by side, so neither pane's navigation disappears just
 * because focus moved across the divider.
 */
export function TitleBar(props: { model: AppModel }) {
  const { state, actions, prefActions } = props.model;
  const [maximized, setMaximized] = createSignal(false);
  let resizeFrame: number | undefined;

  async function currentWindow() {
    if (browserMockEnabled) return undefined;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  }

  async function refreshMaximized() {
    const win = await currentWindow();
    if (!win) return;
    try {
      setMaximized(await win.isMaximized());
    } catch {
      // The window can be mid-teardown; a stale maximise icon is harmless.
    }
  }

  onMount(() => {
    void refreshMaximized();
    window.addEventListener("resize", scheduleMaximizedRefresh);
  });
  onCleanup(() => {
    window.removeEventListener("resize", scheduleMaximizedRefresh);
    if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
  });

  // Native resize events can arrive much faster than the display refresh
  // rate. At most one isMaximized IPC per frame keeps window dragging cheap.
  function scheduleMaximizedRefresh() {
    if (resizeFrame !== undefined) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = undefined;
      void refreshMaximized();
    });
  }

  async function handleDragPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    // Do not start a drag when the press lands on a real control (window
    // buttons, split toggle) — those need their own click to land.
    if ((event.target as HTMLElement | null)?.closest("button")) return;
    const win = await currentWindow();
    if (!win) return;
    try {
      await win.startDragging();
    } catch {
      // A drag gesture can race the button release; nothing to recover.
    }
  }

  async function handleDoubleClick(event: MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest("button")) return;
    const win = await currentWindow();
    if (!win) return;
    await win.toggleMaximize();
    void refreshMaximized();
  }

  function startResize(direction: ResizeDirection) {
    return async (event: PointerEvent) => {
      if (event.button !== 0) return;
      const win = await currentWindow();
      if (!win) return;
      try {
        await win.startResizeDragging(direction);
      } catch {
        // Same race as dragging: not actionable.
      }
    };
  }

  async function minimize() {
    (await currentWindow())?.minimize();
  }

  async function toggleMaximizeRestore() {
    await (await currentWindow())?.toggleMaximize();
    void refreshMaximized();
  }

  async function closeWindow() {
    (await currentWindow())?.close();
  }

  /** Also the target of `Ctrl+\` in `App.tsx`'s global key handler. */
  function togglePaneSplit() {
    if (state.panes.length >= 2) {
      const other = state.panes.find((pane) => pane.id !== state.focusedPaneId);
      if (other) actions.closePane(other.id);
    } else {
      actions.splitPane();
    }
    prefActions.update("splitView", state.panes.length >= 2);
  }

  return (
    <>
      {/* The title bar mirrors `.app-shell`'s column grid: the brand spans the
          nav-rail + chat-list columns, and everything else lives in the third
          (workspace) column, so the tabs sit above the conversation panes
          rather than sprawling left over the sidebar. When the sidebar is
          collapsed that column shrinks to zero and the tabs slide fully left. */}
      <header class="titlebar">
        <div class="titlebar-brand" aria-hidden="true">
          <span class="brand-mark">
            <MessageCircle size={16} />
          </span>
          <span class="titlebar-title">Rust Meow</span>
        </div>
        <div class="titlebar-main">
          <Show when={state.screen === "chats"}>
            <div class="titlebar-tabs">
              <For each={state.panes}>{(pane) => <Tabs model={props.model} pane={pane} />}</For>
            </div>
          </Show>
          <div
            class="titlebar-drag"
            onPointerDown={(event) => void handleDragPointerDown(event)}
            onDblClick={(event) => void handleDoubleClick(event)}
          />
          <div class="titlebar-controls">
            <Show when={state.screen === "chats"}>
              <IconButton
                label={state.panes.length >= 2 ? "Close split view" : "Split view"}
                active={state.panes.length >= 2}
                onClick={togglePaneSplit}
              >
                <Columns2 size={16} />
              </IconButton>
            </Show>
            <button type="button" class="window-button" aria-label="Minimize" onClick={() => void minimize()}>
              <Minus size={15} />
            </button>
            <button
              type="button"
              class="window-button"
              aria-label={maximized() ? "Restore" : "Maximize"}
              onClick={() => void toggleMaximizeRestore()}
            >
              <Square size={13} />
            </button>
            <button type="button" class="window-button close" aria-label="Close" onClick={() => void closeWindow()}>
              <X size={16} />
            </button>
          </div>
        </div>
      </header>
      <For each={RESIZE_HANDLES}>
        {(handle) => (
          <div
            class={`resize-handle ${handle.cls}`}
            onPointerDown={(event) => void startResize(handle.direction)(event)}
          />
        )}
      </For>
    </>
  );
}
