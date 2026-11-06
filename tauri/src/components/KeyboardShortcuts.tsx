import { createEffect, Show } from "solid-js";

interface ShortcutGroup {
  label: string;
  rows: readonly [string, string][];
}

const groups: readonly ShortcutGroup[] = [
  {
    label: "Navigate",
    rows: [
      ["j / k", "Move down or up in the current list"],
      ["h / l", "Move between panes, sidebar, conversation, and composer"],
      ["g g / G", "Jump to the first or last item"],
      ["Esc", "Leave the composer or close the active overlay"],
    ],
  },
  {
    label: "Open",
    rows: [
      ["i", "Focus the message composer"],
      ["/", "Focus chat search"],
      ["o", "Open quick search"],
      ["c / m / s", "Chat info, members, or settings"],
    ],
  },
  {
    label: "Message actions",
    rows: [
      ["r", "Reply to the focused message"],
      ["e / f / p", "Edit, forward, or pin the focused message"],
      ["x / d", "Close the current chat tab"],
    ],
  },
];

export function KeyboardShortcuts(props: { open: boolean; onClose: () => void }) {
  let closeButton: HTMLButtonElement | undefined;
  createEffect(() => {
    if (props.open) requestAnimationFrame(() => closeButton?.focus());
  });
  return (
    <Show when={props.open}>
      <div
        class="modal-backdrop shortcuts-backdrop"
        role="presentation"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <section
          class="dialog-card shortcuts-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="keyboard-shortcuts-title"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              props.onClose();
              event.preventDefault();
            } else if (event.key === "Tab") {
              closeButton?.focus();
              event.preventDefault();
            }
          }}
        >
          <header class="shortcuts-heading">
            <div>
              <h2 id="keyboard-shortcuts-title">Keyboard shortcuts</h2>
              <p>Vim bindings stay active everywhere except text fields.</p>
            </div>
            <button ref={closeButton} type="button" class="shortcuts-close" aria-label="Close keyboard shortcuts" onClick={props.onClose}>×</button>
          </header>
          <div class="shortcuts-groups">
            {groups.map((group) => (
              <section class="shortcuts-group" aria-label={group.label}>
                <h3>{group.label}</h3>
                {group.rows.map(([key, description]) => (
                  <div class="shortcut-row">
                    <kbd>{key}</kbd>
                    <span>{description}</span>
                  </div>
                ))}
              </section>
            ))}
          </div>
          <p class="shortcuts-footer"><kbd>?</kbd> toggles this guide · <kbd>Ctrl+K</kbd> also opens quick search</p>
        </section>
      </div>
    </Show>
  );
}
