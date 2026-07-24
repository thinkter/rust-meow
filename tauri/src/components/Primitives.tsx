import { createSignal, onCleanup, onMount, Show, type JSX, type ParentProps } from "solid-js";

interface IconButtonProps extends ParentProps {
  label: string;
  class?: string;
  disabled?: boolean;
  active?: boolean;
  type?: "button" | "submit";
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
}

export function IconButton(props: IconButtonProps) {
  return (
    <button
      type={props.type ?? "button"}
      class={`icon-button ${props.active ? "active" : ""} ${props.class ?? ""}`}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export const DEFAULT_SPINNER_DELAY_MS = 180;

/**
 * Patient progress indicator: most local reads finish within a frame or two,
 * so revealing progress immediately creates a distracting blank/spinner/content
 * flash. Slow work still gets feedback after the short perception threshold.
 */
export function Spinner(props: { label?: string; small?: boolean; delayMs?: number }) {
  const delay = Math.max(0, props.delayMs ?? DEFAULT_SPINNER_DELAY_MS);
  const [visible, setVisible] = createSignal(delay === 0);

  onMount(() => {
    if (delay === 0) return;
    const timer = window.setTimeout(() => setVisible(true), delay);
    onCleanup(() => window.clearTimeout(timer));
  });

  return (
    <Show when={visible()}>
      <span class={`spinner-wrap ${props.small ? "small" : ""}`} role="status">
        <span class="spinner" />
        {props.label ? <span>{props.label}</span> : null}
      </span>
    </Show>
  );
}

export function EmptyState(props: ParentProps & { title?: string; style?: JSX.CSSProperties }) {
  return (
    <div class="empty-state" style={props.style}>
      {props.children}
      {props.title !== undefined ? <strong>{props.title}</strong> : null}
    </div>
  );
}
