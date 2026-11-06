/**
 * "Search or jump to…" (⌘K / Ctrl+K): a dialog listing every page of the current website, the
 * other websites and the account pages. Type to filter, ↑/↓ to move, Enter to open, Escape to
 * close. The input is a combobox that owns the result listbox (aria-activedescendant).
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WebsiteSummary } from "../../../shared/api-types";
import { SITE_PAGES } from "../nav";
import { Icon, type IconName, PAGE_ICONS } from "./NavIcons";

export interface Command {
  id: string;
  label: string;
  section: string;
  icon: IconName;
  run: () => void;
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const words = q.split(/\s+/);
  return commands.filter((c) => {
    const text = `${c.label} ${c.section}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Opens on ⌘K / Ctrl+K anywhere in the app. */
export function useCommandShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        onOpen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpen]);
}

export function CommandMenu({
  open,
  onClose,
  siteId,
  websites,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  websites: WebsiteSummary[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      void navigate({ to });
      onClose();
    };
    const pages: Command[] = siteId
      ? SITE_PAGES.filter((p) => !p.path.includes("$")).map((p) => ({
          id: `page:${p.path}`,
          label: p.label,
          section: p.group === "Analytics" ? "Pages" : p.group,
          icon:
            PAGE_ICONS[p.path] ??
            PAGE_ICONS[p.group] ??
            (p.group === "Settings" ? "settings" : "page"),
          run: go(`/app/${siteId}/${p.path}`),
        }))
      : [];
    const sites: Command[] = websites
      .filter((w) => w._id !== siteId)
      .map((w) => ({
        id: `site:${w._id}`,
        label: `Switch to ${w.name ?? w.domain}`,
        section: "Websites",
        icon: "websites",
        run: go(`/app/${w._id}/overview`),
      }));
    return [
      ...pages,
      ...sites,
      {
        id: "all",
        label: "All websites",
        section: "Websites",
        icon: "websites",
        run: go("/app/websites"),
      },
      {
        id: "new",
        label: "Add website",
        section: "Websites",
        icon: "plus",
        run: go("/app/new-site"),
      },
      {
        id: "account",
        label: "Account",
        section: "Account",
        icon: "account",
        run: go("/app/account"),
      },
    ];
  }, [navigate, onClose, siteId, websites]);

  const results = filterCommands(commands, query);
  const current = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => input.current?.focus());
    return () => previous?.focus?.();
  }, [open]);

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((current + 1) % Math.max(1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current - 1 + results.length) % Math.max(1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[current]?.run();
    } else if (e.key === "Tab") {
      // The dialog has one control; keep focus in it.
      e.preventDefault();
    }
  };

  let lastSection = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close search"
        tabIndex={-1}
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search or jump to"
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" className="size-4 shrink-0 text-muted" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results.length ? `${listId}-${current}` : undefined}
            aria-label="Search pages and websites"
            placeholder="Search pages and websites…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            // The dialog is the focus indicator; the global focus ring would box the input.
            style={{ outline: "none" }}
            className="h-11 w-full bg-transparent text-sm placeholder:text-muted"
          />
          <kbd className="rounded border border-line px-1.5 font-mono text-[11px] text-muted">
            Esc
          </kbd>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">No matches for “{query}”.</p>
          ) : (
            results.map((c, i) => {
              const heading = c.section !== lastSection ? c.section : null;
              lastSection = c.section;
              return (
                <div key={c.id}>
                  {heading ? (
                    <div
                      role="presentation"
                      className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted"
                    >
                      {heading}
                    </div>
                  ) : null}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === current}
                    tabIndex={-1}
                    onMouseMove={() => setActive(i)}
                    onClick={() => c.run()}
                    onKeyDown={onKeyDown}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${
                      i === current ? "bg-selected text-text" : "text-muted"
                    }`}
                  >
                    <Icon name={c.icon} className="size-4 shrink-0" />
                    {c.label}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
