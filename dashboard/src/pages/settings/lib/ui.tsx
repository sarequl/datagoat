/**
 * Building blocks for the settings, admin and account pages: layout with section tabs, switches,
 * radio cards, list editors, copy buttons, dialogs, meters. All use the design tokens.
 */
import { Link } from "@tanstack/react-router";
import {
  cloneElement,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Role } from "../../../../../shared/permissions";
import { Button, Card, cx, Input, Notice, Spinner } from "../../../components/ui";
import { SETTINGS_TABS } from "../../../nav";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** Website settings pages: heading plus the section tabs (nav.ts SETTINGS_TABS). */
export function SettingsLayout({
  siteId,
  domain,
  children,
}: {
  siteId: string;
  domain?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" description={domain ? `Website settings for ${domain}` : null} />
      <nav aria-label="Settings sections" className="border-b border-line">
        <ul className="-mb-px flex flex-wrap gap-x-1">
          {SETTINGS_TABS.map((tab) => (
            <li key={tab.path}>
              <Link
                to={`/app/$siteId/${tab.path}`}
                params={{ siteId }}
                className="inline-block border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-text"
                activeProps={{
                  className: "border-primary! font-medium text-primary-text!",
                  "aria-current": "page",
                }}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </div>
  );
}

/** Loading or error state of a page's main query; render the page itself once data is there. */
export function QueryState({ query }: { query: { error: Error | null; refetch?: () => unknown } }) {
  if (query.error)
    return (
      <div className="space-y-2">
        <Notice tone="error">{query.error.message}</Notice>
        {query.refetch ? (
          <Button variant="secondary" onClick={() => void query.refetch?.()}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  return <Spinner />;
}

export function ReadOnlyNotice({ role, action }: { role: Role; action: string }) {
  return (
    <Notice>
      You are a {role} on this website, so you can view but not {action}. Ask an owner for access.
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

/**
 * Labelled form control. Unlike a wrapping <label>, the hint and error are linked with
 * aria-describedby, so the control's accessible name is just the label.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>;
}) {
  const id = useId();
  const note = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {cloneElement(children, {
        id,
        "aria-describedby": note,
        "aria-invalid": error ? true : undefined,
      })}
      {error ? (
        <p id={note} role="alert" className="text-xs text-error-text">
          {error}
        </p>
      ) : hint ? (
        <p id={note} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A label and hint for a group of controls that label themselves (list editors). */
export function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {children}
    </div>
  );
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { className?: string }) {
  return (
    <select
      {...props}
      className={cx(
        "rounded-md border border-line bg-surface px-3 py-2 text-sm text-text disabled:opacity-60",
        className ?? "w-full",
      )}
    />
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <span id={`${id}-label`} className="text-sm font-medium">
          {label}
        </span>
        {description ? (
          <p id={`${id}-desc`} className="mt-0.5 text-xs text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line-strong transition disabled:opacity-50",
          checked ? "bg-primary" : "bg-surface-2",
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "inline-block size-4 rounded-full shadow transition",
            checked ? "translate-x-6 bg-primary-fg" : "translate-x-1 bg-muted",
          )}
        />
      </button>
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: ReactNode;
}

export function RadioCards<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  disabled,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<RadioOption<T>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            "flex cursor-pointer gap-3 rounded-md border p-3 text-sm",
            value === o.value ? "border-primary bg-surface-2" : "border-line",
            disabled && "cursor-default opacity-70",
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-0.5 accent-[var(--dg-primary)]"
          />
          <span className="min-w-0">
            <span className="block font-medium">{o.label}</span>
            {o.description ? (
              <span className="mt-0.5 block text-xs text-muted">{o.description}</span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--dg-primary)]"
      />
      <span>
        {label}
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * Editable list of strings shown as chips: add with Enter or the Add button, remove per item.
 * `validate` returns an error message or null; `normalise` runs before validation.
 */
export function ListEditor({
  label,
  items,
  onChange,
  placeholder,
  validate,
  normalise = (v) => v.trim(),
  disabled,
  renderItem,
  max,
  splitOnSpace = true,
  readOnlyInput = false,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  validate?: (value: string) => string | null;
  normalise?: (value: string) => string;
  disabled?: boolean;
  renderItem?: (value: string) => ReactNode;
  max?: number;
  /** Split typed text on spaces as well as commas (off for values that contain spaces). */
  splitOnSpace?: boolean;
  /** Hide the text input (items are added by another control) but keep remove buttons. */
  readOnlyInput?: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const add = () => {
    const values = text
      .split(splitOnSpace ? /[\s,]+/ : /,/)
      .map(normalise)
      .filter(Boolean);
    if (!values.length) return;
    for (const v of values) {
      const problem = validate?.(v) ?? null;
      if (problem) {
        setError(problem);
        return;
      }
    }
    const next = [...new Set([...items, ...values])];
    if (max && next.length > max) {
      setError(`At most ${max} entries.`);
      return;
    }
    onChange(next);
    setText("");
    setError(null);
  };
  return (
    <div className="space-y-2">
      {!disabled && !readOnlyInput ? (
        <div className="flex gap-2">
          <Input
            id={id}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            value={text}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button variant="secondary" onClick={add} aria-label={`Add to ${label}`}>
            Add
          </Button>
        </div>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-error-text">
          {error}
        </p>
      ) : null}
      {items.length ? (
        <ul aria-label={label} className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={item}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 py-1 pr-1 pl-2 text-xs"
            >
              <span className="truncate font-mono">{renderItem ? renderItem(item) : item}</span>
              {!disabled ? (
                <button
                  type="button"
                  className="rounded px-1 text-muted hover:bg-surface hover:text-text"
                  aria-label={`Remove ${item}`}
                  onClick={() => onChange(items.filter((x) => x !== item))}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">None yet.</p>
      )}
    </div>
  );
}

/** Save button with the result of the last save next to it. */
export function SaveRow({
  dirty,
  pending,
  error,
  saved,
  disabled,
  label = "Save",
  onSave,
}: {
  dirty: boolean;
  pending: boolean;
  error: Error | null;
  saved: boolean;
  disabled?: boolean;
  label?: string;
  onSave?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <Button
        type={onSave ? "button" : "submit"}
        onClick={onSave}
        disabled={disabled || pending || !dirty}
      >
        {pending ? "Saving…" : label}
      </Button>
      <span aria-live="polite" className="text-sm">
        {error ? (
          <span className="text-error-text">{error.message}</span>
        ) : saved && !dirty ? (
          <span className="text-success-text">Saved</span>
        ) : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "error" | "primary";
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "neutral" && "border-line text-muted",
        tone === "success" && "border-success/40 text-success-text",
        tone === "warning" && "border-warning/50 text-warning-text",
        tone === "error" && "border-error/40 text-error-text",
        tone === "primary" && "border-primary/50 text-primary-text",
      )}
    >
      {children}
    </span>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure origins (http://LAN-IP) where the async clipboard is unavailable.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand?.("copy") ?? false;
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <Button
      variant="secondary"
      className={cx("shrink-0 px-2 py-1 text-xs", className)}
      onClick={async () => setState((await writeClipboard(text)) ? "copied" : "failed")}
      aria-label={state === "idle" ? label : undefined}
    >
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      </span>
    </Button>
  );
}

/**
 * A code snippet with its copy button in a toolbar above the text, so the button never covers
 * the code at any width. `wrap` breaks long single-line values (URL templates) instead of
 * scrolling them sideways; multi-line snippets keep their layout and scroll.
 */
export function CodeBlock({
  code,
  label,
  wrap = false,
}: {
  code: string;
  label: string;
  wrap?: boolean;
}) {
  return (
    <figure
      className="min-w-0 overflow-hidden rounded-md border border-line bg-surface-2"
      aria-label={label}
    >
      <div className="flex justify-end border-b border-line px-2 py-1.5">
        <CopyButton text={code} label={`Copy ${label}`} />
      </div>
      <pre
        className={cx(
          "max-h-96 overflow-auto p-3 text-xs leading-relaxed",
          wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]",
        )}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** One-line value (URL, key) with a copy button; `visibleLabel` shows the label above it. */
export function CopyField({
  value,
  label,
  visibleLabel,
  hint,
}: {
  value: string;
  label: string;
  visibleLabel?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      {visibleLabel ? (
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          aria-label={visibleLabel ? undefined : label}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <CopyButton text={value} label={`Copy ${label}`} />
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Meter({
  label,
  value,
  limit,
  display,
  warnAt = 70,
}: {
  label: string;
  value: number;
  limit: number;
  display: string;
  warnAt?: number;
}) {
  const pct = limit ? Math.min(100, (value / limit) * 100) : 0;
  const tone = pct >= 90 ? "bg-error" : pct >= warnAt ? "bg-warning" : "bg-primary";
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted">{display}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${pct.toFixed(1)}% (${display})`}
        className="h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Accessible tab list with arrow-key navigation; renders the active panel. */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onChange(tab.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={value === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={value === t.id ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              "rounded-md border px-2.5 py-1.5 text-xs font-medium",
              value === t.id
                ? "border-primary bg-surface-2 text-primary-text"
                : "border-line text-muted hover:text-text",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${value}`}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (focusables?.[0] ?? panel.current)?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
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
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-surface p-5 shadow-xl"
      >
        <h2 id={titleId} className="mb-3 text-base font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/**
 * Confirmation for destructive or important actions. With `confirmText`, the confirm button stays
 * disabled until the user types it exactly.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "danger",
  confirmText,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  confirmText?: string;
  pending?: boolean;
  error?: Error | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const blocked = confirmText !== undefined && typed.trim() !== confirmText;
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked && !pending) onConfirm();
        }}
      >
        <div className="space-y-2 text-sm text-muted">{children}</div>
        {confirmText !== undefined ? (
          // biome-ignore lint/a11y/noLabelWithoutControl: the input is inside the label
          <label className="block space-y-1 text-sm">
            <span>
              Type <strong className="font-mono text-text">{confirmText}</strong> to confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}
        {error ? <Notice tone="error">{error.message}</Notice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant={tone} disabled={blocked || pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Shows a newly created secret once, with copy and a clear warning. */
export function SecretReveal({
  title,
  secret,
  onDone,
  children,
}: {
  title: string;
  secret: string;
  onDone: () => void;
  children?: ReactNode;
}) {
  return (
    <Card title={title} className="border-primary/50">
      <div className="space-y-3">
        <Notice tone="success">
          Copy it now. For security it is stored hashed and will not be shown again.
        </Notice>
        <CopyField value={secret} label="New secret" />
        {children}
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </Card>
  );
}
