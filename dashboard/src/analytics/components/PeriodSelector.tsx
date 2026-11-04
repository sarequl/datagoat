/**
 * Period selector: presets with keyboard shortcuts, pinned favourites per website ("More
 * periods" holds the rest), custom range, and prev/next arrows that hop by the period length.
 */
import { useEffect, useState } from "react";
import { cx } from "../../components/ui";
import {
  customLabel,
  PERIOD_OPTIONS,
  type Period,
  type PeriodKey,
  shiftPeriod,
} from "../lib/period";
import { isTypingTarget, readPref, writePref } from "../lib/storage";
import { addDays, maxDay, minDay, ymdInTz } from "../lib/tz";
import { sourceKey, useSource } from "../source";
import type { DashboardState } from "../state";
import { Popover } from "./primitives";

const DEFAULT_PINS = PERIOD_OPTIONS.filter((o) => o.primary).map((o) => o.key);

export function usePinnedPeriods(scope: string) {
  const key = `pinned-periods:${scope}`;
  const [pins, setPins] = useState<string[]>(() => readPref<string[]>(key, DEFAULT_PINS));
  const toggle = (k: string) => {
    setPins((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      writePref(key, next);
      return next;
    });
  };
  return { pins, toggle };
}

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="currentColor">
      <path
        d={
          dir === "left"
            ? "M12.7 4.3 7 10l5.7 5.7 1.4-1.4L9.8 10l4.3-4.3z"
            : "M7.3 4.3 13 10l-5.7 5.7-1.4-1.4L10.2 10 5.9 5.7z"
        }
      />
    </svg>
  );
}

export function PeriodSelector({ state }: { state: DashboardState }) {
  const source = useSource();
  const { pins, toggle } = usePinnedPeriods(sourceKey(source));
  const [showMore, setShowMore] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const today = ymdInTz(state.now, state.timezone);
  const [from, setFrom] = useState(state.range.startDay ?? addDays(today, -29));
  const [to, setTo] = useState(state.range.endDay ?? today);
  const prev = shiftPeriod(state.period, state.range, -1, state.timezone, state.now);
  const next = shiftPeriod(state.period, state.range, 1, state.timezone, state.now);
  const { setPeriod } = state;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const opt = PERIOD_OPTIONS.find((o) => o.shortcut === e.key.toLowerCase());
      if (opt && !e.shiftKey) {
        e.preventDefault();
        setPeriod({ key: opt.key });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setPeriod]);

  const pinned = PERIOD_OPTIONS.filter((o) => pins.includes(o.key));
  const more = PERIOD_OPTIONS.filter((o) => !pins.includes(o.key));
  const current = state.period.key;
  const label =
    current === "custom" && state.range.startDay && state.range.endDay
      ? customLabel(state.range.startDay, state.range.endDay)
      : state.range.label;

  const item = (
    key: Exclude<PeriodKey, "custom">,
    text: string,
    close: () => void,
    shortcut?: string,
  ) => (
    <li key={key} className="flex items-center gap-1">
      <button
        type="button"
        aria-pressed={current === key}
        onClick={() => {
          setPeriod({ key });
          close();
        }}
        className={cx(
          "flex flex-1 items-center justify-between rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface-2",
          current === key && "font-medium text-primary-text",
        )}
      >
        {text}
        {shortcut ? (
          <kbd className="rounded border border-line px-1 font-mono text-[10px] text-muted">
            {shortcut.toUpperCase()}
          </kbd>
        ) : null}
      </button>
      <button
        type="button"
        aria-pressed={pins.includes(key)}
        aria-label={`${pins.includes(key) ? "Unpin" : "Pin"} ${text}`}
        onClick={() => toggle(key)}
        className={cx(
          "rounded-md p-1.5 hover:bg-surface-2",
          pins.includes(key) ? "text-primary-text" : "text-muted",
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="size-3.5"
          fill={pins.includes(key) ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m10 2.5 2.3 4.7 5.2.8-3.8 3.6.9 5.2L10 14.4l-4.6 2.4.9-5.2L2.5 8l5.2-.8z" />
        </svg>
      </button>
    </li>
  );

  const apply = (close: () => void) => {
    if (!from || !to) return;
    const p: Period = { key: "custom", from: minDay(from, to), to: maxDay(from, to) };
    setPeriod(p);
    setCustomOpen(false);
    close();
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Previous period"
        disabled={!prev}
        onClick={() => prev && setPeriod(prev)}
        className="rounded-md border border-line bg-surface p-2 hover:bg-surface-2 disabled:opacity-40"
      >
        <Arrow dir="left" />
      </button>
      <Popover
        label={`Period: ${label}`}
        button={
          <>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="size-4 text-muted"
              fill="currentColor"
            >
              <path d="M6 2h2v2h4V2h2v2h2.5A1.5 1.5 0 0 1 18 5.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 16.5v-11A1.5 1.5 0 0 1 3.5 4H6zm-2 6v8h12V8z" />
            </svg>
            <span className="max-w-[11rem] truncate" data-testid="period-label">
              {label}
            </span>
            {state.range.live && current === "now" ? (
              <span className="size-2 animate-pulse rounded-full bg-success" aria-hidden="true" />
            ) : null}
          </>
        }
      >
        {(close) => (
          <div className="w-72 p-1">
            <ul aria-label="Pinned periods" className="space-y-0.5">
              {pinned.map((o) => item(o.key, o.label, close, o.shortcut))}
            </ul>
            {more.length ? (
              <div className="mt-1 border-t border-line pt-1">
                <button
                  type="button"
                  aria-expanded={showMore}
                  onClick={() => setShowMore((v) => !v)}
                  className="w-full rounded-md px-3 py-1.5 text-left text-sm text-muted hover:bg-surface-2"
                >
                  {showMore ? "Fewer periods" : "More periods"}
                </button>
                {showMore ? (
                  <ul aria-label="More periods" className="space-y-0.5">
                    {more.map((o) => item(o.key, o.label, close, o.shortcut))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="mt-1 border-t border-line pt-1">
              <button
                type="button"
                aria-expanded={customOpen}
                onClick={() => setCustomOpen((v) => !v)}
                className={cx(
                  "w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface-2",
                  current === "custom" && "font-medium text-primary-text",
                )}
              >
                Custom range…
              </button>
              {customOpen ? (
                <form
                  className="space-y-2 px-3 pb-2 pt-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    apply(close);
                  }}
                >
                  <label className="block text-xs text-muted">
                    From
                    <input
                      type="date"
                      value={from}
                      max={today}
                      onChange={(e) => setFrom(e.target.value)}
                      className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-text"
                    />
                  </label>
                  <label className="block text-xs text-muted">
                    To
                    <input
                      type="date"
                      value={to}
                      max={today}
                      onChange={(e) => setTo(e.target.value)}
                      className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-text"
                    />
                  </label>
                  <button
                    type="submit"
                    className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg"
                  >
                    Apply range
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        )}
      </Popover>
      <button
        type="button"
        aria-label="Next period"
        disabled={!next}
        onClick={() => next && setPeriod(next)}
        className="rounded-md border border-line bg-surface p-2 hover:bg-surface-2 disabled:opacity-40"
      >
        <Arrow dir="right" />
      </button>
    </div>
  );
}
