/**
 * Accessible building blocks for the analytics pages: modal dialog with focus trap, popover
 * menu, tabs with arrow-key navigation, segmented control and small states.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cx } from "../../components/ui";

const FOCUSABLE =
  'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(e: globalThis.KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[hidden]"),
  );
  if (!items.length) return;
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Modal dialog: focus moves in and is trapped, Escape and the backdrop close it. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
  side,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  /** Slide-over panel on the right instead of a centred dialog. */
  side?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const target =
      panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      trapTab(e, panel.current);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className={cx(
        "fixed inset-0 z-50 flex",
        side ? "justify-end" : "items-start justify-center p-4 sm:items-center",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close dialog"
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          "relative flex max-h-full flex-col overflow-hidden border border-line bg-surface shadow-xl",
          side
            ? "h-full w-full max-w-md"
            : cx("w-full rounded-lg", wide ? "max-w-3xl" : "max-w-lg", "max-h-[90vh]"),
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 id={titleId} className="truncate text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="currentColor">
              <path d="M5.3 4 4 5.3 8.7 10 4 14.7 5.3 16 10 11.3l4.7 4.7 1.3-1.3L11.3 10 16 5.3 14.7 4 10 8.7z" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/** Button that toggles a popover panel; closes on Escape and outside clicks. */
export function Popover({
  label,
  button,
  children,
  align = "left",
  className,
  buttonClassName,
}: {
  label: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return (
    <div ref={root} className={cx("relative", className)}>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm hover:bg-surface-2",
          buttonClassName,
        )}
      >
        {button}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={id}
          className={cx(
            "absolute z-40 mt-1 min-w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-1 shadow-xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  active,
  hint,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cx(
        "flex w-full items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-50",
        active && "font-medium text-primary-text",
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-xs text-muted">{hint}</span> : null}
    </button>
  );
}

export interface TabItem {
  id: string;
  label: string;
}

/** Tabs with roving focus (Left/Right/Home/End). */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const tab = tabs[next] as TabItem;
    onChange(tab.id);
    refs.current[tab.id]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex min-w-0 gap-1 overflow-x-auto">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
          className={cx(
            "shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-sm",
            value === t.id ? "bg-selected font-medium text-text" : "text-muted hover:text-text",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a fieldset
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-md border border-line p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded px-2 py-1 text-xs disabled:opacity-40",
            value === o.value ? "bg-selected font-medium text-text" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-center text-sm text-muted">{children}</p>;
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <p role="alert" className="px-1 py-4 text-sm text-error-text">
      {error instanceof Error ? error.message : "Something went wrong"}
    </p>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("animate-pulse rounded bg-surface-2", className)} />;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "primary" | "success" | "error" | "info" | "warning";
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "border-line text-muted",
        tone === "primary" && "border-primary/40 text-primary-text",
        tone === "success" && "border-success/40 text-success-text",
        tone === "error" && "border-error/40 text-error-text",
        tone === "info" && "border-info/40 text-info-text",
        tone === "warning" && "border-warning/40 text-warning-text",
      )}
    >
      {children}
    </span>
  );
}

/** Visually hidden content for screen readers. */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
