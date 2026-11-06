import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Clock, Search } from "lucide-solid";
import { createVirtualizer } from "@tanstack/solid-virtual";

import { EMOJI_CATEGORIES, EMOJI_ENTRIES, EMOJI_LABELS } from "../lib/emoji-catalog";

/** Full Unicode emoji catalog; re-exported so composer autocomplete ranks the same entries the picker shows. */
export { EMOJI_ENTRIES };

const DEFAULT_RECENT_KEY = "rust-meow-recent-emoji";
const MAX_RECENT = 32;
/** Pre-measurement heights; the virtualizer measures rendered rows and corrects them. */
const CELL_ROW_ESTIMATE = 40;
const LABEL_ROW_ESTIMATE = 28;

interface EmojiSection {
  id: string;
  label: string;
  emojis: string[];
  /** Offset of this section's first emoji within the flattened, currently visible list. */
  startIndex: number;
}

/** One virtualized row: a section heading, or up to `columns` consecutive emoji. */
type EmojiRow =
  | { kind: "label"; key: string; label: string }
  | { kind: "cells"; key: string; startIndex: number; emojis: string[] };

export function EmojiPicker(props: {
  onPick: (emoji: string) => void;
  /** localStorage key for the recently-used list, default "rust-meow-recent-emoji". */
  recentKey?: string;
  /** Denser grid for the reaction popover. */
  compact?: boolean;
}): JSX.Element {
  const recentKey = () => props.recentKey ?? DEFAULT_RECENT_KEY;
  const [recent, setRecent] = createSignal<string[]>(readRecent(recentKey()));
  const [query, setQuery] = createSignal("");
  const [activeCategory, setActiveCategory] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);

  let inputRef: HTMLInputElement | undefined;
  let gridRef: HTMLDivElement | undefined;
  /** Mounted emoji cells by flat index. Cells leave this map when virtualization unmounts them. */
  const cellRefs = new Map<number, HTMLDivElement>();
  /** Flat index to focus as soon as its row mounts after a keyboard-driven scroll; -1 when none. */
  let pendingFocus = -1;

  const searching = createMemo(() => query().trim().length > 0);

  const filteredEmojis = createMemo(() => {
    const q = query().trim().toLocaleLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const [emoji, keywords] of EMOJI_ENTRIES) {
      if (seen.has(emoji)) continue;
      if (emoji === q || keywords.includes(q)) {
        seen.add(emoji);
        result.push(emoji);
      }
    }
    return result;
  });

  /** Sections rendered into the grid, in order; keyboard nav walks this flattened. */
  const sections = createMemo<EmojiSection[]>(() => {
    if (searching()) {
      const matches = filteredEmojis();
      return matches.length > 0 ? [{ id: "search", label: "Search results", emojis: matches, startIndex: 0 }] : [];
    }
    const list: EmojiSection[] = [];
    let offset = 0;
    if (recent().length > 0) {
      list.push({ id: "recent", label: "Recently used", emojis: recent(), startIndex: offset });
      offset += recent().length;
    }
    for (const category of EMOJI_CATEGORIES) {
      list.push({ id: category.id, label: category.label, emojis: category.entries.map(([emoji]) => emoji), startIndex: offset });
      offset += category.entries.length;
    }
    return list;
  });

  const totalVisible = createMemo(() => sections().reduce((sum, section) => sum + section.emojis.length, 0));
  const columns = () => (props.compact ? 10 : 8);

  createEffect(() => {
    const max = totalVisible() - 1;
    if (activeIndex() > max) setActiveIndex(Math.max(0, max));
  });

  /**
   * Virtualized rows in display order, with lookups by stable key, by section id
   * (for category jumps), and by flat emoji index (for keyboard focus).
   */
  const layout = createMemo(() => {
    const cols = columns();
    const rows: EmojiRow[] = [];
    const rowByKey = new Map<string, EmojiRow>();
    const rowOfSection = new Map<string, number>();
    const rowOfEmoji: number[] = [];
    for (const section of sections()) {
      rowOfSection.set(section.id, rows.length);
      const label: EmojiRow = { kind: "label", key: `label:${section.id}`, label: section.label };
      rows.push(label);
      rowByKey.set(label.key, label);
      for (let offset = 0; offset < section.emojis.length; offset += cols) {
        const startIndex = section.startIndex + offset;
        const cells: EmojiRow = {
          kind: "cells",
          key: `cells:${startIndex}:${cols}`,
          startIndex,
          emojis: section.emojis.slice(offset, offset + cols),
        };
        const rowIndex = rows.length;
        rows.push(cells);
        rowByKey.set(cells.key, cells);
        for (let i = 0; i < cells.emojis.length; i++) rowOfEmoji[startIndex + i] = rowIndex;
      }
    }
    return { rows, rowByKey, rowOfSection, rowOfEmoji };
  });

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return layout().rows.length;
    },
    getScrollElement: () => gridRef ?? null,
    estimateSize: (index) => (layout().rows[index]?.kind === "label" ? LABEL_ROW_ESTIMATE : CELL_ROW_ESTIMATE),
    overscan: 4,
    getItemKey: (index) => layout().rows[index]?.key ?? index,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  /**
   * Keys of rows in the virtual window. Keyed rendering means a focused row keeps
   * its DOM while the window scrolls; only rows that leave the window are removed.
   */
  const visibleKeys = createMemo(() =>
    virtualizer.getVirtualItems().flatMap((item) => {
      const key = layout().rows[item.index]?.key;
      return key === undefined ? [] : [key];
    }),
  );

  /** Current virtual position of each visible row, keyed by row key. */
  const visiblePositions = createMemo(() => {
    const positions = new Map<string, { index: number; start: number }>();
    for (const item of virtualizer.getVirtualItems()) {
      const key = layout().rows[item.index]?.key;
      if (key !== undefined) positions.set(key, { index: item.index, start: item.start });
    }
    return positions;
  });

  function cellRowFor(key: string): Extract<EmojiRow, { kind: "cells" }> | undefined {
    const row = layout().rowByKey.get(key);
    return row?.kind === "cells" ? row : undefined;
  }

  function labelFor(key: string): string {
    const row = layout().rowByKey.get(key);
    return row?.kind === "label" ? row.label : "";
  }

  function readRecent(key: string): string[] {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Never trust stored JSON: keep only unique, non-empty strings, capped.
      const unique = new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
      return [...unique].slice(0, MAX_RECENT);
    } catch {
      return [];
    }
  }

  function persistRecent(next: string[]) {
    try {
      localStorage.setItem(recentKey(), JSON.stringify(next));
    } catch {
      // Recents are a nicety; storage can legitimately be unavailable (private mode, quota).
    }
  }

  function pick(emoji: string) {
    setRecent((current) => {
      const next = [emoji, ...current.filter((item) => item !== emoji)].slice(0, MAX_RECENT);
      persistRecent(next);
      return next;
    });
    props.onPick(emoji);
  }

  function focusIndex(index: number) {
    const clamped = Math.max(0, Math.min(index, totalVisible() - 1));
    setActiveIndex(clamped);
    const mounted = cellRefs.get(clamped);
    if (mounted) {
      mounted.focus();
      return;
    }
    const row = layout().rowOfEmoji[clamped];
    if (row === undefined) return;
    pendingFocus = clamped;
    virtualizer.scrollToIndex(row, { align: "auto" });
  }

  function onGridKeyDown(event: KeyboardEvent) {
    if (totalVisible() === 0) return;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusIndex(activeIndex() + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusIndex(activeIndex() - 1);
        break;
      case "ArrowDown":
        event.preventDefault();
        focusIndex(activeIndex() + columns());
        break;
      case "ArrowUp":
        event.preventDefault();
        focusIndex(activeIndex() - columns());
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const emoji = flatEmojiAt(activeIndex());
        if (emoji) pick(emoji);
        break;
      }
      // Escape is intentionally left alone: it bubbles to whichever popover
      // is hosting this picker (Composer / MessageBubble), which is the only
      // thing that knows how to close itself.
    }
  }

  function flatEmojiAt(index: number): string | undefined {
    for (const section of sections()) {
      if (index < section.startIndex || index >= section.startIndex + section.emojis.length) continue;
      return section.emojis[index - section.startIndex];
    }
    return undefined;
  }

  function jumpToCategory(id: string) {
    setActiveCategory(id);
    const row = layout().rowOfSection.get(id);
    if (row !== undefined) virtualizer.scrollToIndex(row, { align: "start", behavior: "smooth" });
  }

  function onSearchKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = flatEmojiAt(0);
      if (first) pick(first);
    }
    // Escape falls through unhandled, same reasoning as the grid handler.
  }

  function renderCell(startIndex: number, emoji: string, localIndex: number) {
    const index = startIndex + localIndex;
    let element: HTMLDivElement | undefined;
    onCleanup(() => {
      if (element && cellRefs.get(index) === element) cellRefs.delete(index);
    });
    return (
      <div
        ref={(el) => {
          element = el;
          cellRefs.set(index, el);
          if (pendingFocus === index) {
            queueMicrotask(() => {
              if (pendingFocus === index && el.isConnected) {
                pendingFocus = -1;
                el.focus();
              }
            });
          }
        }}
        class="emoji-button"
        role="option"
        aria-selected={activeIndex() === index}
        aria-label={EMOJI_LABELS.get(emoji) ?? emoji}
        tabIndex={activeIndex() === index ? 0 : -1}
        onClick={() => {
          setActiveIndex(index);
          pick(emoji);
        }}
        onFocus={() => setActiveIndex(index)}
      >
        {emoji}
      </div>
    );
  }

  return (
    <div
      class={`popover emoji-picker${props.compact ? " compact" : ""}`}
      style={props.compact ? { width: "292px", "max-height": "300px" } : undefined}
    >
      <div class="emoji-picker-header">
        <label class="search-field">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query()}
            placeholder="Search emoji"
            aria-label="Search emoji"
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
          />
        </label>
      </div>

      {!searching() && (
        <div class="emoji-category-strip">
          {recent().length > 0 && (
            <button
              type="button"
              class={`emoji-category${activeCategory() === "recent" ? " active" : ""}`}
              aria-label="Recently used"
              title="Recently used"
              onClick={() => jumpToCategory("recent")}
            >
              <Clock size={15} />
            </button>
          )}
          <For each={EMOJI_CATEGORIES}>
            {(category) => (
              <button
                type="button"
                class={`emoji-category${activeCategory() === category.id ? " active" : ""}`}
                aria-label={category.label}
                title={category.label}
                onClick={() => jumpToCategory(category.id)}
              >
                {category.icon}
              </button>
            )}
          </For>
        </div>
      )}

      <div class="emoji-grid" ref={gridRef} role="listbox" aria-label="Emoji" onKeyDown={onGridKeyDown}>
        <Show
          when={layout().rows.length > 0}
          fallback={<div class="emoji-section-label" style={{ "grid-column": "1 / -1" }}>No emoji found</div>}
        >
          <div class="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px`, "grid-column": "1 / -1" }}>
            <For each={visibleKeys()}>
              {(key) => (
                <Show when={visiblePositions().get(key)}>
                  {(placed) => (
                    <div
                      class="virtual-row"
                      role="presentation"
                      data-index={placed().index}
                      ref={(element) =>
                        queueMicrotask(() => {
                          if (element.isConnected) virtualizer.measureElement(element);
                        })
                      }
                      style={{ transform: `translateY(${placed().start}px)` }}
                    >
                      <Show
                        when={layout().rowByKey.get(key)?.kind === "label"}
                        fallback={
                          <div
                            role="presentation"
                            style={{
                              display: "grid",
                              "grid-template-columns": `repeat(${columns()}, 1fr)`,
                              gap: "2px",
                            }}
                          >
                            <For each={cellRowFor(key)?.emojis ?? []}>
                              {(emoji, localIndex) => renderCell(cellRowFor(key)?.startIndex ?? 0, emoji, localIndex())}
                            </For>
                          </div>
                        }
                      >
                        <div class="emoji-section-label" role="presentation">
                          {labelFor(key)}
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
