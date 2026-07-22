# Rust Meow desktop redesign — implementation contract

Every agent working on this redesign follows this document. It fixes the parts
that cross file boundaries: the design tokens, the CSS class inventory, and the
`AppModel` API. Anything not fixed here is the owning agent's call.

Stack reminder: **SolidJS** (not React) + TanStack Solid Virtual, Tauri v2,
Go sidecar. `pnpm check` (`tsc --noEmit`) must stay clean. No new npm
dependencies without a very good reason.

---

## 1. Goals

| # | Goal |
| --- | --- |
| G1 | Group conversations show each sender's avatar beside their messages |
| G2 | React with **any** emoji, not just six quick ones |
| G3 | Send the user's existing WhatsApp stickers from a sticker tray |
| G4 | `Ctrl+Tab` behaves like the GPUI app: a hold-to-cycle overlay switcher |
| G5 | No OS title bar — custom chrome instead |
| G6 | Full restyle + user-authorable theming; default theme is Vercel-inspired |
| G7 | Configurable save/download location in settings |
| G8 | Discord-style member list docked open on the right of group chats |
| G9 | Two conversation panes + a tab strip |
| G10 | Hover action floaters sit on the **left** of a bubble, not the right |
| G11 | Experimental "compact" density |
| G12 | Jump-to-latest button while scrolled up |
| G13 | Long URLs wrap instead of overflowing the pane |

---

## 2. Design language

Vercel/Geist-inspired: near-black surfaces, hairline `1px` borders doing the
work that shadows used to, tight radii (6–10px), high-contrast text, one blue
accent, generous negative space. No gradients except the brand mark. No glows.
Motion is short and cheap: 120–160ms `ease-out` on hover/appearance only.

Type scale (all multiplied by `var(--scale)`):
`11px` micro · `12px` meta · `13px` secondary · `14px` body · `15px` bubble
text · `17px` panel title · `20px` hero. Weights 400/500/600 only.

Radii: `--radius-sm: 6px`, `--radius-md: 8px`, `--radius-lg: 12px`,
`--radius-full: 999px`. Declare these in `styles.css`; they are not themeable.

---

## 3. Design tokens (the theming contract)

Defined in `tauri/src/lib/theme.ts` — **already written, do not redefine.**
Applied as `--<token>` custom properties on `:root` by
`state/preferences.ts`. Stylesheets must read these and never hardcode a
colour.

```
--bg-app --bg-panel --bg-elevated --bg-hover --bg-active --bg-input --bg-overlay
--border --border-strong --border-focus
--fg --fg-muted --fg-subtle --fg-inverted
--accent --accent-hover --accent-fg --accent-soft
--bubble-in-bg --bubble-in-fg --bubble-out-bg --bubble-out-fg --quote-bar
--success --warning --danger --info
--shadow-sm --shadow-md --shadow-lg
```

Also set by preferences, and free to use:

- `--scale` — number, the UI scale multiplier (0.8–1.6)
- `html[data-appearance="dark"|"light"]`
- `html[data-density="comfortable"|"compact"]`

Per-message hue for sender colouring stays as `--sender-hue` on the bubble.

---

## 4. Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ .titlebar   [brand] [.tab-strip ................] [.titlebar-controls]│ 38px
├──────┬────────────────┬─────────────────────────────┬────────────────┤
│ .nav │ .sidebar       │ .pane-group                 │ .member-panel  │
│ -rail│ chat list      │  ┌ .pane ─────┬ .pane ─────┐│ (groups only,  │
│ 56px │ 300px          │  │ conversation│ conversation││  240px,       │
│      │                │  └────────────┴─────────────┘│  toggleable)   │
└──────┴────────────────┴─────────────────────────────┴────────────────┘
```

- The tab strip lives **in** the title bar (browser/Discord style). That is what
  replaces the OS title bar rather than adding a second one.
- `.member-panel` is docked open by default for group chats
  (`preferences.memberPanelOpen`). Contact chats show it only on demand.
- `.pane-group` holds one or two `.pane` children. The focused pane carries
  `.pane-focused`.
- Chat info and settings render as overlay sheets over the pane group, not as a
  third column, so the member panel keeps its slot.

---

## 5. CSS class inventory

`styles.css` is owned by one agent. Everyone else uses these names and does not
invent new top-level classes without adding them here.

**Chrome** `.titlebar` `.titlebar-drag` `.titlebar-brand` `.titlebar-controls`
`.window-button` `.window-button.close` `.resize-handle` (+ `.n .s .e .w .ne .nw .se .sw`)

**Tabs** `.tab-strip` `.tab` `.tab.active` `.tab-avatar` `.tab-title`
`.tab-badge` `.tab-close` `.tab-add`

**Shell** `.app-shell` `.app-shell.sidebar-collapsed` `.nav-rail` `.nav-spacer` `.brand-mark` `.workspace`
`.pane-group` `.pane` `.pane-focused` `.pane-divider`

**Sidebar** `.sidebar` `.sidebar-header` `.sidebar-title` `.sidebar-search-wrap`
`.search-field` `.clear-search` `.chat-filters` `.filter-chip` `.chat-list`
`.virtual-canvas` `.virtual-row` `.chat-row` `.chat-row.selected`
`.chat-row.unread` `.chat-row-body` `.chat-row-line` `.chat-title` `.chat-time`
`.chat-preview` `.chat-flags` `.chat-badge` `.sync-strip` `.progress-track`
`.search-results` `.search-section-label` `.search-result-row`
`.search-result-copy`

**Conversation** `.conversation-shell` `.conversation-header`
`.conversation-contact` `.conversation-heading` `.conversation-search`
`.connection-banner` `.message-scroller` `.message-canvas` `.message-row`
`.message-row.from-me` `.message-row.with-date` `.message-row.with-unread`
`.message-avatar` `.message-avatar-spacer` `.date-separator`
`.unread-separator` `.floating-jump`

**Bubble** `.message-bubble` `.message-bubble.highlight` `.message-sender`
`.quoted-message` `.message-text` `.message-meta` `.reaction-row`
`.reaction-chip` `.reaction-chip.mine` `.reply-count` `.message-actions`
`.message-image` `.message-image.sticker` `.media-placeholder` `.link-preview`
`.link-preview-meta` `.attachment-card` `.attachment-icon` `.attachment-meta`
`.contact-card` `.contact-icon` `.contact-meta` `.location-card`
`.location-icon` `.location-meta`

**Pickers** `.popover` `.emoji-picker` `.emoji-picker-header`
`.emoji-category-strip` `.emoji-category` `.emoji-section-label` `.emoji-grid`
`.emoji-button` `.reaction-picker` `.reaction-quick-row`
`.reaction-picker-expand` `.sticker-tray` `.sticker-tab-strip`
`.sticker-pack-tab` `.sticker-grid` `.sticker-cell` `.sticker-empty`
`.attachment-menu` `.popover-menu-item` `.mention-picker` `.mention-row`

**Composer** `.composer-wrap` `.composer` `.composer-input-wrap`
`.composer-input` `.send-button` `.reply-composer` `.reply-composer-card`

**Right side** `.member-panel` `.member-panel-header` `.member-section-label`
`.member-row` `.member-row-copy` `.role-badge` `.right-panel`
`.right-panel-header` `.right-panel-scroll` `.profile-hero` `.info-section`
`.info-row` `.participant-list` `.participant-row` `.participant-row-copy`

**Settings** `.settings-panel` `.settings-nav` `.settings-nav-item`
`.settings-page` `.settings-section` `.setting-row` `.setting-copy`
`.segmented-control` `.toggle-switch` `.toggle-switch.on` `.toggle-knob`
`.path-row` `.path-value` `.theme-grid` `.theme-card` `.theme-card.active`
`.theme-swatch` `.theme-editor` `.token-row` `.token-swatch`

**Switcher** `.chat-switcher-overlay` `.chat-switcher` `.switcher-row`
`.switcher-row.active` `.switcher-hint`

**Full-screen states** `.startup-screen` `.startup-card` `.pairing-screen`
`.pairing-card` `.qr-frame` `.qr-expired` `.qr-expiry` `.pairing-steps`
`.fatal-screen` `.fatal-card` `.hero-icon` `.conversation-empty`
`.conversation-empty-card`

**Overlays** `.modal-backdrop` `.modal-close` `.image-viewer`
`.image-viewer-caption` `.dialog-card` `.dialog-actions` `.toast-stack`
`.toast` `.toast.error` `.toast.info`

**Shared** `.avatar` `.icon-button` `.icon-button.active` `.spinner`
`.spinner-wrap` `.empty-state` `.secondary-button` `.primary-button`
`.danger-button`

---

## 6. `AppModel` API

`tauri/src/state/app.ts` moves from *one* active conversation to *N* keyed by
chat id, because two panes can show two chats at once.

```ts
export interface ConversationState {
  chatId: string;
  messages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  firstUnreadMessageId: string;
  highlightedMessageId: string;
  liveMessageVersion: number;
}

export interface Pane {
  id: string;          // stable, e.g. "pane-1"
  tabChatIds: string[];// tab order within the pane
  activeChatId: string;
}
```

New/changed state:

```ts
conversations: Record<string, ConversationState>;
panes: Pane[];                 // length 1 or 2
focusedPaneId: string;
switcher: { chatIds: string[]; highlighted: number } | null;
stickers: { packs: StickerPack[]; loading: boolean; error: string };
```

`state.selectedChatId` **stays**, defined as the focused pane's `activeChatId`,
so untouched call sites keep working.

Actions — existing ones keep their names; those that acted on "the" conversation
take an optional trailing `chatId` that defaults to `state.selectedChatId`:

```ts
conversation(chatId: string): ConversationState   // never undefined; empty default
selectChat(chatId, aroundMessageId?, paneId?)
openInNewTab(chatId, paneId?)
closeTab(chatId, paneId?)
moveTab(chatId, fromPaneId, toPaneId, index)
focusPane(paneId)
splitPane()            // create the second pane
closePane(paneId)
loadOlder(chatId?) / loadNewer(chatId?) / jumpToLatest(chatId?)
openSwitcher(reverse) / cycleSwitcher(reverse) / commitSwitcher() / cancelSwitcher()
loadStickers() / sendStickerFromPack(stickerId, chatId?)
```

Preferences live in their own store and are merged into the model:

```ts
const { preferences, prefActions } = createPreferences();
// exposed as model.preferences and model.prefActions
```

---

## 7. Behaviour specs

### G4 — `Ctrl+Tab` switcher (match the GPUI reference)

Reference implementation: `desktop/src/main.rs` — `ChatSwitcher` (≈line 557),
`cycle_recent_chat` (≈2619), `render_chat_switcher` (≈5006).

1. `Ctrl+Tab` with the overlay closed: build the candidate list from
   session-recent chats, falling back to the visible chat list until enough
   history exists (`recent_chat_candidates`, ≈2525). Open the overlay.
2. Initial highlight: reverse → last candidate; forward and the active chat is
   first → index 1; forward otherwise → index 0.
3. Further `Ctrl+Tab` / `Ctrl+Shift+Tab` while it is open only moves the
   highlight; it does **not** switch chats.
4. **Releasing Ctrl commits** the highlighted chat. `Escape` cancels. Clicking a
   row commits that row.
5. Opening it closes the emoji picker, chat info, settings, and image viewer.

The webview equivalent of the GPUI modifier watch is a `keyup` listener on
`window` for `event.key === "Control"` plus a `blur` guard, both capture-phase.
Note that the `keydown` handler already exists in `App.tsx` and calls
`actions.cycleRecentChat` — replace that call.

### G1 — group avatars

Only in group chats, only on incoming messages. Avatar sits in a fixed
`calc(30px * var(--scale))` gutter to the left of the bubble; consecutive
messages from the same sender within 5 minutes render
`.message-avatar-spacer` instead so bubbles stay grouped. Hydrate through
`actions.loadParticipantAvatar(senderId)` — it already exists, dedupes, and
fails silently.

### G2 — react with any emoji

The quick row keeps the six defaults plus a `＋` that expands the full picker.
Extract the emoji data and grid out of `Composer.tsx` into
`components/EmojiPicker.tsx` with a `onPick(emoji)` prop, so the composer and
the reaction picker share one implementation. Add category grouping and a
recent-emoji list persisted under `rust-meow-recent-emoji`.

### G10 — floaters on the left

`.message-actions` is currently absolutely positioned to the right. Flip it:
outgoing (`.from-me`) bubbles get actions on their left, incoming bubbles also
get them on the left of the bubble (in the avatar gutter side). Never let the
floater overlap the bubble text; it appears on `:hover` and `:focus-within`.

### G11 — compact density

`html[data-density="compact"]`: bubble padding `4px 8px`, row gap `1px`,
line-height `1.35`, hide the avatar gutter, meta timestamps inline at 10px,
message max-width `82%`. It is a pure stylesheet concern plus a
`estimateMessageHeight` adjustment in `Conversation.tsx`.

### G13 — URL wrapping

`.message-text` and `.message-text a` need
`overflow-wrap: anywhere; word-break: break-word;` and the bubble needs
`min-width: 0`. `.link-preview` needs `max-width: 100%` with its title/URL
lines clamped. Bubbles cap at `min(560px, 74%)` of the pane, and the pane must
never scroll horizontally.

### G5 — custom chrome

`tauri.conf.json` → `"decorations": false`. Because Linux then loses resize
borders, render eight `.resize-handle` elements calling
`getCurrentWindow().startResizeDragging(direction)`. `.titlebar-drag` calls
`startDragging()` on pointer-down and toggles maximise on double-click.
Capabilities needed in `src-tauri/capabilities/default.json`:
`core:window:allow-start-dragging`, `core:window:allow-start-resize-dragging`,
`core:window:allow-minimize`, `core:window:allow-toggle-maximize`,
`core:window:allow-close`, `core:window:allow-is-maximized`.

### G7 — save location

Settings exposes a directory picker (`openFile({ directory: true })`) storing
`preferences.downloadDir`. A new Rust command `save_media_as` copies a media
file there. Media bubbles gain a "Save to folder" action. When `downloadDir` is
empty, fall back to prompting for a destination each time.

---

## 8. Ownership

| Agent | Owns |
| --- | --- |
| CORE | `state/app.ts`, `state/workspace.ts` |
| CSS | `styles.css` |
| SHELL | `App.tsx`, `components/TitleBar.tsx`, `Tabs.tsx`, `ChatSwitcher.tsx`, `MemberPanel.tsx`, `tauri.conf.json`, `capabilities/default.json` |
| BUBBLE | `components/MessageBubble.tsx`, `components/Conversation.tsx` |
| PICKERS | `components/Composer.tsx`, `components/EmojiPicker.tsx`, `components/StickerTray.tsx` |
| SETTINGS | `components/Panels.tsx`, `components/Screens.tsx` |
| STICKERS | `proto/bridge.proto`, `backend/`, `src-tauri/src/lib.rs`, sticker parts of `lib/bridge.ts` + `lib/types.ts` |

Shared read-only for everyone: `lib/theme.ts`, `state/preferences.ts`,
`lib/format.ts`, `components/Primitives.tsx`, `components/Avatar.tsx`.
If you need a change in a file you do not own, say so in your report instead of
editing it.
