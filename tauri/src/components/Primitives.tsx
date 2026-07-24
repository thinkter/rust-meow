import type { JSX, ParentProps } from "solid-js";

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

export function Spinner(props: { label?: string; small?: boolean }) {
  return (
    <span class={`spinner-wrap ${props.small ? "small" : ""}`} role="status">
      <span class="spinner" />
      {props.label ? <span>{props.label}</span> : null}
    </span>
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
