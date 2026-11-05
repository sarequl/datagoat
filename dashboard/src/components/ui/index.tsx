/** Small UI primitives built on the design tokens (styles.css). */

import { Link, type LinkProps } from "@tanstack/react-router";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { LogoMark } from "../Logo";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50",
        variant === "primary" && "bg-primary text-primary-fg hover:opacity-90",
        variant === "secondary" && "border border-line bg-surface hover:bg-surface-2",
        variant === "ghost" && "hover:bg-surface-2",
        variant === "danger" && "bg-danger text-danger-fg hover:opacity-90",
        className,
      )}
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return (
      <input
        ref={ref}
        {...props}
        className={cx(
          "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-text placeholder:text-muted",
          props.className,
        )}
      />
    );
  },
);

/**
 * A secret the server already stores (API token, bot token). It is never sent back, so the field
 * shows a masked placeholder and a Replace button; Replace opens an empty input and Cancel goes
 * back to keeping the stored value. Without a stored value it is a plain password input.
 */
export function SecretInput({
  stored,
  value,
  onChange,
  placeholder,
}: {
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [replacing, setReplacing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Focus the new, empty input after Replace.
  useEffect(() => {
    if (replacing) input.current?.focus();
  }, [replacing]);
  if (stored && !replacing) {
    return (
      <div className="flex gap-2">
        <Input
          readOnly
          value="••••••••••••••••••••"
          className="font-mono tracking-wider text-muted"
        />
        <Button
          // Inside a <label> a button would otherwise be named after the field.
          aria-label="Replace"
          variant="secondary"
          onClick={(e) => {
            e.preventDefault();
            setReplacing(true);
          }}
        >
          Replace
        </Button>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <Input
        ref={input}
        type="password"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {stored ? (
        <Button
          // Inside a <label> a button would otherwise be named after the field.
          aria-label="Cancel"
          variant="secondary"
          onClick={(e) => {
            e.preventDefault();
            onChange("");
            setReplacing(false);
          }}
        >
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Card({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface p-5", className)}>
      {title ? <h2 className="mb-3 text-base font-semibold">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "success";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-error/40 text-error-text",
        tone === "success" && "border-success/40 text-success-text",
        tone === "info" && "border-line text-muted",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Full-page loading state (session check, lazy route chunks). Centered on the viewport and shown
 * only after `delayMs`, so fast loads (the common case) never flash a loader. The logo pulses
 * unless the visitor prefers reduced motion.
 */
export function PageLoader({
  label = "Loading",
  delayMs = 300,
}: {
  label?: string;
  delayMs?: number;
}) {
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-40 grid place-items-center"
    >
      <span className="sr-only">{label}…</span>
      {visible ? <LogoMark size={40} className="motion-safe:animate-pulse" /> : null}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 p-6 text-sm text-muted"
    >
      <span className="size-4 animate-spin rounded-full border-2 border-line border-t-primary" />
      {label}…
    </div>
  );
}

/** "← Parent" link above a detail page's title: its own row, a hit area and spacing. */
export function BackLink({ children, ...props }: LinkProps & { children: ReactNode }) {
  return (
    <div className="mb-1">
      <Link
        {...props}
        className="-ml-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m14 7-5 5 5 5" />
        </svg>
        {children}
      </Link>
    </div>
  );
}
