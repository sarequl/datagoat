/**
 * Funnel builder: a name and 2–8 ordered steps, each a page visit (URL with a match type and an
 * optional hostname) or a goal (completed / not completed). Steps can be reordered and removed.
 */
import { useState } from "react";
import type { FunnelStep, FunnelUrlMatchType } from "../../../../shared/api-types";
import { Button } from "../../components/ui";

export const MATCH_TYPES: Array<{ value: FunnelUrlMatchType; label: string }> = [
  { value: "equals", label: "equals" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "contains", label: "contains" },
  { value: "not_equals", label: "does not equal" },
  { value: "not_contains", label: "does not contain" },
  { value: "wildcard", label: "matches wildcard (*)" },
];

const MIN = 2;
const MAX = 8;

function blank(type: FunnelStep["type"] = "pageview"): FunnelStep {
  return type === "pageview"
    ? { name: "", type, url: "/", urlMatchType: "equals" }
    : { name: "", type, goalName: "", goalCompletionType: "completed" };
}

export function validateFunnel(name: string, steps: FunnelStep[]): string | null {
  if (!name.trim()) return "Give the funnel a name";
  if (steps.length < MIN || steps.length > MAX) return `A funnel has ${MIN} to ${MAX} steps`;
  for (const [i, s] of steps.entries()) {
    if (s.type === "pageview" && !s.url?.trim()) return `Step ${i + 1}: enter a URL`;
    if (s.type === "goal" && !s.goalName?.trim()) return `Step ${i + 1}: choose a goal`;
  }
  return null;
}

export function FunnelBuilder({
  initialName = "",
  initialSteps,
  goals,
  submitLabel,
  busy,
  error: serverError,
  onSubmit,
  onCancel,
}: {
  initialName?: string;
  initialSteps?: FunnelStep[];
  goals: string[];
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (name: string, steps: FunnelStep[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [steps, setSteps] = useState<FunnelStep[]>(
    initialSteps?.length ? initialSteps.map((s) => ({ ...s })) : [blank(), blank("goal")],
  );
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<FunnelStep>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j] as FunnelStep, next[i] as FunnelStep];
      return next;
    });

  return (
    <form
      className="space-y-4"
      aria-label="Funnel"
      onSubmit={(e) => {
        e.preventDefault();
        const finalSteps = steps.map((s, i) => {
          const label =
            s.name.trim() ||
            (s.type === "pageview"
              ? `Visited ${s.url}`
              : `${s.goalCompletionType === "not_completed" ? "Did not complete" : "Completed"} ${s.goalName}`) ||
            `Step ${i + 1}`;
          const base: FunnelStep = { ...(s.id ? { id: s.id } : {}), name: label, type: s.type };
          return s.type === "pageview"
            ? {
                ...base,
                url: s.url?.trim(),
                urlMatchType: s.urlMatchType ?? "equals",
                ...(s.hostname?.trim() ? { hostname: s.hostname.trim() } : {}),
              }
            : {
                ...base,
                goalName: s.goalName?.trim(),
                goalCompletionType: s.goalCompletionType ?? "completed",
              };
        });
        const problem = validateFunnel(name, finalSteps);
        setError(problem);
        if (!problem) onSubmit(name.trim(), finalSteps);
      }}
    >
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Funnel name</span>
        <input
          data-autofocus
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          placeholder="SaaS onboarding"
          className="w-full rounded-md border border-line bg-surface px-3 py-2"
        />
      </label>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and reorderable
          <li key={i} className="rounded-md border border-line p-3">
            <fieldset className="space-y-2">
              <legend className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                Step {i + 1}
                <span className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-2 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} down`}
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                    className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-2 disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove step ${i + 1}`}
                    disabled={steps.length <= MIN}
                    onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                    className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-error-text disabled:opacity-30"
                  >
                    ✕
                  </button>
                </span>
              </legend>
              <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
                <label className="text-xs text-muted">
                  Type
                  <select
                    value={s.type}
                    onChange={(e) => {
                      const type = e.target.value as FunnelStep["type"];
                      setSteps((prev) =>
                        prev.map((x, j) =>
                          j === i ? { ...blank(type), name: x.name, id: x.id } : x,
                        ),
                      );
                    }}
                    className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-text"
                  >
                    <option value="pageview">Page visit</option>
                    <option value="goal">Goal</option>
                  </select>
                </label>
                <label className="text-xs text-muted">
                  Label (optional)
                  <input
                    value={s.name}
                    maxLength={100}
                    onChange={(e) => set(i, { name: e.target.value })}
                    className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-text"
                  />
                </label>
              </div>
              {s.type === "pageview" ? (
                <div className="grid gap-2 sm:grid-cols-[11rem_1fr_10rem]">
                  <label className="text-xs text-muted">
                    URL
                    <select
                      value={s.urlMatchType ?? "equals"}
                      onChange={(e) =>
                        set(i, { urlMatchType: e.target.value as FunnelUrlMatchType })
                      }
                      className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-text"
                    >
                      {MATCH_TYPES.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-muted">
                    Path
                    <input
                      value={s.url ?? ""}
                      onChange={(e) => set(i, { url: e.target.value })}
                      placeholder="/pricing"
                      className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm text-text"
                    />
                  </label>
                  <label className="text-xs text-muted">
                    Hostname (optional)
                    <input
                      value={s.hostname ?? ""}
                      onChange={(e) => set(i, { hostname: e.target.value })}
                      placeholder="app.example.com"
                      className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-text"
                    />
                  </label>
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-[1fr_11rem]">
                  <label className="text-xs text-muted">
                    Goal
                    <input
                      value={s.goalName ?? ""}
                      list="funnel-goals"
                      onChange={(e) => set(i, { goalName: e.target.value })}
                      placeholder="signup"
                      className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm text-text"
                    />
                  </label>
                  <label className="text-xs text-muted">
                    Condition
                    <select
                      value={s.goalCompletionType ?? "completed"}
                      onChange={(e) =>
                        set(i, {
                          goalCompletionType: e.target.value as FunnelStep["goalCompletionType"],
                        })
                      }
                      className="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-text"
                    >
                      <option value="completed">completed</option>
                      <option value="not_completed">not completed</option>
                    </select>
                  </label>
                </div>
              )}
            </fieldset>
          </li>
        ))}
      </ol>
      <datalist id="funnel-goals">
        {goals.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={steps.length >= MAX}
          onClick={() => setSteps((p) => [...p, blank()])}
        >
          + Page step
        </Button>
        <Button
          variant="secondary"
          disabled={steps.length >= MAX}
          onClick={() => setSteps((p) => [...p, blank("goal")])}
        >
          + Goal step
        </Button>
        <span className="self-center text-xs text-muted">
          {steps.length} of {MAX} steps
        </span>
      </div>
      {error || serverError ? (
        <p role="alert" className="text-sm text-error-text">
          {error ?? serverError}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
