import { Match, Switch, type Component, type JSX } from "solid-js";

export type ThemeIconName =
  | "archive"
  | "attach"
  | "bell"
  | "chat"
  | "check"
  | "check-double"
  | "clock"
  | "close"
  | "copy"
  | "download"
  | "edit"
  | "globe"
  | "maximize"
  | "messages"
  | "minimize"
  | "new-chat"
  | "palette"
  | "pin"
  | "poll"
  | "reply"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "sidebar"
  | "smile"
  | "split"
  | "sticker"
  | "storage"
  | "trash"
  | "warning";

interface ThemeIconProps {
  icon: Component<{ size?: number; class?: string }>;
  name: ThemeIconName;
  size?: number;
  class?: string;
}

/**
 * Modern themes keep the crisp Lucide outline set. Skeuomorphic themes reveal
 * a bundled, original filled glyph in the same slot. Keeping both in the DOM
 * makes theme switching instant and avoids loading an external sprite sheet.
 */
export function ThemeIcon(props: ThemeIconProps) {
  return (
    <>
      <props.icon size={props.size} class={`theme-icon-modern ${props.class ?? ""}`} />
      <svg
        class={`theme-icon-skeuo ${props.class ?? ""}`}
        width={props.size ?? 18}
        height={props.size ?? 18}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <Glyph name={props.name} />
      </svg>
    </>
  );
}

function Glyph(props: { name: ThemeIconName }): JSX.Element {
  return (
    <Switch>
      <Match when={props.name === "chat"}>
        <path d="M3 5.8C3 3.7 5 2 7.4 2h9.2C19 2 21 3.7 21 5.8v7.4c0 2.1-2 3.8-4.4 3.8H11l-5.7 4.2.9-4.5C4.3 16.2 3 14.9 3 13.2z" />
        <path class="icon-highlight" d="M6.8 5h10.4c.7 0 1.3.4 1.6.9H5.2c.3-.5.9-.9 1.6-.9z" />
      </Match>
      <Match when={props.name === "messages"}>
        <path d="M2.5 5.5A3.5 3.5 0 0 1 6 2h8a3.5 3.5 0 0 1 3.5 3.5v5A3.5 3.5 0 0 1 14 14H9l-4.6 3.2.8-3.6a3.5 3.5 0 0 1-2.7-3.4z" />
        <path d="M9 16h6.3l3.8 2.7-.7-3a3.2 3.2 0 0 0 3.1-3.2V9A3.5 3.5 0 0 0 18 5.5v5A4.5 4.5 0 0 1 13.5 15H9z" opacity=".72" />
      </Match>
      <Match when={props.name === "new-chat"}>
        <path d="M2 5.5A3.5 3.5 0 0 1 5.5 2h9A3.5 3.5 0 0 1 18 5.5v6a3.5 3.5 0 0 1-3.5 3.5H9l-4.8 3.4.8-3.8a3.5 3.5 0 0 1-3-3.5z" />
        <path class="icon-cutout" d="M18.5 14v-3h2v3h3v2h-3v3h-2v-3h-3v-2z" />
      </Match>
      <Match when={props.name === "search"}>
        <circle cx="10.2" cy="10.2" r="6.7" />
        <path d="m14.8 14.1 1.5-1.5 5.2 5.2a1.1 1.1 0 0 1 0 1.6l-.6.6a1.1 1.1 0 0 1-1.6 0z" />
        <circle class="icon-cutout" cx="10.2" cy="10.2" r="4.2" />
        <path class="icon-highlight" d="M6.5 8.8A4.4 4.4 0 0 1 10.4 6c1.2 0 2.3.5 3.1 1.2a5 5 0 0 0-7 1.6z" />
      </Match>
      <Match when={props.name === "archive"}>
        <path d="M3 7h18v13H3z" />
        <path d="M2 3h20v5H2z" />
        <path class="icon-cutout" d="M8 10h8v2H8z" />
        <path class="icon-highlight" d="M4 4h16v1H4z" />
      </Match>
      <Match when={props.name === "sidebar"}>
        <rect x="2" y="3" width="20" height="18" rx="2.5" />
        <path class="icon-cutout" d="M8 5h2v14H8z" />
        <path class="icon-highlight" d="M4 5h3v1H4zm8 0h8v1h-8z" />
      </Match>
      <Match when={props.name === "split"}>
        <rect x="2" y="3" width="20" height="18" rx="2.5" />
        <path class="icon-cutout" d="M11 4h2v16h-2z" />
        <path class="icon-highlight" d="M4 5h6v1H4zm10 0h6v1h-6z" />
      </Match>
      <Match when={props.name === "shield"}>
        <path d="M12 1.8 21 5v6.2c0 5.2-3.7 9.4-9 11-5.3-1.6-9-5.8-9-11V5z" />
        <path class="icon-highlight" d="M12 4 5.4 6.3v4.8c0 .5 0 1 .2 1.5C6.2 8.6 8.6 6 12 4z" />
        <path class="icon-cutout" d="m8.4 11.6 2.1 2.1 4.9-5 1.4 1.5-6.3 6.3L7 13z" />
      </Match>
      <Match when={props.name === "settings"}>
        <path d="m10.2 1.5-.7 2.3-1.6.7-2.2-1.1-2.3 2.3 1.1 2.2-.7 1.6-2.3.7v3.3l2.3.7.7 1.6L3.4 18l2.3 2.3 2.2-1.1 1.6.7.7 2.3h3.3l.7-2.3 1.6-.7 2.2 1.1 2.3-2.3-1.1-2.2.7-1.6 2.3-.7v-3.3l-2.3-.7-.7-1.6 1.1-2.2L18 3.4l-2.2 1.1-1.6-.7-.7-2.3z" />
        <circle class="icon-cutout" cx="11.8" cy="11.8" r="3.4" />
        <path class="icon-highlight" d="M10.5 3h2l.4 1.5h-2.8z" />
      </Match>
      <Match when={props.name === "send"}>
        <path d="M2 3.2 22 12 2 20.8l2.2-7.3L15 12 4.2 10.5z" />
        <path class="icon-highlight" d="m4 5.5 14.2 6.2-13.6-3z" />
      </Match>
      <Match when={props.name === "attach"}>
        <path d="M7.2 12.9 14 6.1a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7.1-7.1l8.1-8.1 1.5 1.5-8.1 8.1a2.9 2.9 0 0 0 4.1 4.1l8.5-8.5a.9.9 0 1 0-1.3-1.3l-6.8 6.8a1 1 0 0 0 1.4 1.4l5.1-5.1 1.5 1.5-5.1 5.1a3.1 3.1 0 0 1-4.3-4.3z" />
      </Match>
      <Match when={props.name === "smile"}>
        <circle cx="12" cy="12" r="10" />
        <circle class="icon-cutout" cx="8.3" cy="9.2" r="1.3" />
        <circle class="icon-cutout" cx="15.7" cy="9.2" r="1.3" />
        <path class="icon-cutout" d="M6.6 13.2h10.8c-.6 3.1-2.5 5-5.4 5s-4.8-1.9-5.4-5z" />
        <path class="icon-highlight" d="M5.5 7.4A8.5 8.5 0 0 1 12 4c2.5 0 4.8 1.1 6.3 2.8A9.1 9.1 0 0 0 5.5 7.4z" />
      </Match>
      <Match when={props.name === "sticker"}>
        <path d="M3 2h18v12.5L13.5 22H3z" />
        <path class="icon-cutout" d="M13 14h6.5L13 20.5z" />
        <circle class="icon-cutout" cx="8" cy="8" r="1.2" />
        <circle class="icon-cutout" cx="14.5" cy="8" r="1.2" />
        <path class="icon-cutout" d="M7 11h8c-.6 2-1.9 3-4 3s-3.4-1-4-3z" />
      </Match>
      <Match when={props.name === "poll"}>
        <rect x="3" y="3" width="18" height="18" rx="2.5" />
        <path class="icon-cutout" d="M7 7h2v8H7zm4 3h2v5h-2zm4-5h2v10h-2zm-8 11h10v2H7z" />
      </Match>
      <Match when={props.name === "palette"}>
        <path d="M12 2C6.2 2 2 5.8 2 10.7 2 15.2 5.5 18 9.2 18h1.1c1 0 1.5.9 1 1.7-.8 1.4.3 2.4 1.9 2.3 5-.5 8.8-4.5 8.8-9.7C22 6.5 17.8 2 12 2z" />
        <circle class="icon-cutout" cx="7.2" cy="9.2" r="1.5" />
        <circle class="icon-cutout" cx="10.5" cy="6.4" r="1.5" />
        <circle class="icon-cutout" cx="15" cy="6.8" r="1.5" />
        <circle class="icon-cutout" cx="17.8" cy="10.5" r="1.5" />
      </Match>
      <Match when={props.name === "bell"}>
        <path d="M4 17h16l-2-2.7V9a6 6 0 0 0-12 0v5.3z" />
        <path d="M9 19h6a3 3 0 0 1-6 0z" />
        <path class="icon-highlight" d="M8 8.5A4.2 4.2 0 0 1 12 5c1.5 0 2.8.7 3.6 1.7A5 5 0 0 0 8 8.5z" />
      </Match>
      <Match when={props.name === "storage"}>
        <rect x="2" y="3" width="20" height="7" rx="2" />
        <rect x="2" y="13" width="20" height="8" rx="2" />
        <circle class="icon-cutout" cx="18" cy="6.5" r="1.3" />
        <circle class="icon-cutout" cx="18" cy="17" r="1.3" />
        <path class="icon-highlight" d="M5 5h9v1H5zm0 10h9v1H5z" />
      </Match>
      <Match when={props.name === "globe"}>
        <circle cx="12" cy="12" r="10" />
        <path class="icon-cutout" d="M5 11h14v2H5zm6-7h2v16h-2z" />
        <path class="icon-cutout" d="M12 2c3.2 0 5.7 4.4 5.7 10S15.2 22 12 22v-2c1.8 0 3.7-3.2 3.7-8S13.8 4 12 4zm0 0v2c-1.8 0-3.7 3.2-3.7 8s1.9 8 3.7 8v2c-3.2 0-5.7-4.4-5.7-10S8.8 2 12 2z" />
      </Match>
      <Match when={props.name === "minimize"}>
        <rect x="4" y="11" width="16" height="3" rx="1" />
      </Match>
      <Match when={props.name === "maximize"}>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect class="icon-cutout" x="7" y="8" width="10" height="9" />
      </Match>
      <Match when={props.name === "close"}>
        <path d="m5 3 7 7 7-7 2 2-7 7 7 7-2 2-7-7-7 7-2-2 7-7-7-7z" />
      </Match>
      <Match when={props.name === "check"}>
        <path d="m2.5 12.5 3.2-3.2 4 4L18.3 4.7l3.2 3.2L9.7 19.7z" />
      </Match>
      <Match when={props.name === "clock"}>
        <circle cx="12" cy="12" r="10" />
        <path class="icon-cutout" d="M11 5h2v6.2l4.3 2.5-1 1.8-5.3-3.1z" />
        <path class="icon-highlight" d="M5.5 8A8.2 8.2 0 0 1 12 4c2.6 0 4.9 1.2 6.4 3A9 9 0 0 0 5.5 8z" />
      </Match>
      <Match when={props.name === "check-double"}>
        <path d="m1 12 2.7-2.7 4 4 8.6-8.6L19 7.4 7.7 18.7zm10.4 3.3L20.3 6.4 23 9.1 14.1 18z" />
      </Match>
      <Match when={props.name === "warning"}>
        <path d="M10 2.8a2.3 2.3 0 0 1 4 0l9.1 16A2.1 2.1 0 0 1 21.2 22H2.8a2.1 2.1 0 0 1-1.9-3.2z" />
        <path class="icon-cutout" d="M10.6 7h2.8l-.4 8h-2zm0 10h2.8v2.5h-2.8z" />
      </Match>
      <Match when={props.name === "reply"}>
        <path d="M10 4 1.5 11.5 10 19v-4.3c6.1 0 9.3 1.7 12.5 5.3-.9-7.2-4.6-11.3-12.5-11.3z" />
      </Match>
      <Match when={props.name === "edit"}>
        <path d="m3 16 13-13a2.8 2.8 0 0 1 4 4L7 20l-5 1z" />
        <path class="icon-cutout" d="m14.6 5.4 1.8-1.8 4 4-1.8 1.8z" />
      </Match>
      <Match when={props.name === "pin"}>
        <path d="m8 2 8 0-1 6 4 4v2h-6v8l-2-2v-6H5v-2l4-4z" />
      </Match>
      <Match when={props.name === "trash"}>
        <path d="M5 7h14l-1 15H6zM3 3h18v3H3zm5-2h8v3H8z" />
        <path class="icon-cutout" d="M9 10h2v8H9zm4 0h2v8h-2z" />
      </Match>
      <Match when={props.name === "copy"}>
        <rect x="7" y="2" width="15" height="15" rx="2" />
        <rect x="2" y="7" width="15" height="15" rx="2" opacity=".72" />
        <path class="icon-highlight" d="M9 4h11v1H9zM4 9h11v1H4z" />
      </Match>
      <Match when={props.name === "download"}>
        <path d="M9 2h6v9h5l-8 8-8-8h5zM3 20h18v3H3z" />
      </Match>
    </Switch>
  );
}
