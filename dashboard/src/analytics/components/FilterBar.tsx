/**
 * Active filter chips, the advanced filter builder (any dimension, is / is not / contains /
 * does not contain, at least / at most for visit count, several values per filter, several
 * filters combined) and saved segments.
 */
import { useMemo, useState } from "react";
import type { Segment } from "../../../../shared/api-types";
import { Button, cx } from "../../components/ui";
import { useSegmentMutations, useSegments } from "../hooks";
import {
  type ActiveFilter,
  describeFilter,
  FILTER_DEFS,
  FILTER_GROUPS,
  type FilterOp,
  filterDef,
  filtersFromSearch,
  filtersToParams,
  OP_LABELS,
  removeFilter,
  upsertFilter,
} from "../lib/filters";
import { useAnalytics, useSource } from "../source";
import type { DashboardState } from "../state";
import { Dialog } from "./primitives";

function rowValue(row: Record<string, unknown>, field: string): string | null {
  const direct = row[field];
  if (typeof direct === "string") return direct;
  const campaign = row.campaign as Record<string, string> | undefined;
  const v = campaign?.[field];
  return v ? v : null;
}

function useSuggestions(key: string, state: DashboardState, enabled: boolean): string[] {
  const def = filterDef(key);
  const q = useAnalytics<Record<string, unknown>[]>(
    def?.suggest?.endpoint ?? "pages",
    { ...state.rangeParams, limit: 100 },
    { enabled: enabled && Boolean(def?.suggest), keepPrevious: false },
  );
  return useMemo(() => {
    if (def?.values) return [...def.values];
    if (!def?.suggest) return [];
    const field = def.suggest.field;
    const values = (q.data?.data ?? []).map((r) => rowValue(r, field)).filter(Boolean);
    return [...new Set(values as string[])];
  }, [def, q.data]);
}

export function FilterBuilder({
  state,
  initial,
  onDone,
}: {
  state: DashboardState;
  initial?: ActiveFilter;
  onDone: () => void;
}) {
  const [key, setKey] = useState(initial?.key ?? "referrer");
  const def = filterDef(key) ?? (FILTER_DEFS[0] as (typeof FILTER_DEFS)[number]);
  const [op, setOp] = useState<FilterOp>(initial?.op ?? def.ops[0] ?? "is");
  const [value, setValue] = useState(initial?.values.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const suggestions = useSuggestions(key, state, true);
  const listId = `filter-values-${key}`;

  const submit = () => {
    const values = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!values.length) {
      setError("Enter a value");
      return;
    }
    if (def.numeric && values.some((v) => !/^\d+$/.test(v))) {
      setError("Visit count must be a whole number");
      return;
    }
    if (values.length > 50) {
      setError("At most 50 values");
      return;
    }
    const base =
      initial && initial.key !== key ? removeFilter(state.filters, initial.key) : state.filters;
    state.setFilters(upsertFilter(base, { key, op, values }));
    onDone();
  };

  return (
    <form
      className="space-y-3"
      aria-label={initial ? "Edit filter" : "Add filter"}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Dimension</span>
          <select
            value={key}
            data-autofocus
            onChange={(e) => {
              const k = e.target.value;
              setKey(k);
              const d = filterDef(k);
              if (d && !d.ops.includes(op)) setOp(d.ops[0] ?? "is");
              setValue("");
              setError(null);
            }}
            className="w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
          >
            {FILTER_GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {FILTER_DEFS.filter((d) => d.group === g).map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Operator</span>
          <select
            value={op}
            onChange={(e) => setOp(e.target.value as FilterOp)}
            className="w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
          >
            {def.ops.map((o) => (
              <option key={o} value={o}>
                {OP_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Value</span>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          list={listId}
          inputMode={def.numeric ? "numeric" : undefined}
          placeholder={def.numeric ? "2" : "Separate several values with commas"}
          aria-invalid={Boolean(error)}
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
        />
        <datalist id={listId}>
          {suggestions.slice(0, 100).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {error ? (
          <span role="alert" className="mt-1 block text-xs text-error-text">
            {error}
          </span>
        ) : (
          <span className="mt-1 block text-xs text-muted">Several values match any of them.</span>
        )}
      </label>
      {suggestions.length && !def.numeric ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.slice(0, 12).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setValue((v) => (v.trim() ? `${v.replace(/,\s*$/, "")}, ${s}` : s))}
              className="rounded-full border border-line px-2 py-0.5 text-xs hover:bg-surface-2"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">{initial ? "Update filter" : "Add filter"}</Button>
      </div>
    </form>
  );
}

function SegmentsPanel({ state, onApplied }: { state: DashboardState; onApplied: () => void }) {
  const source = useSource();
  const websiteId = source.kind === "site" ? source.websiteId : "";
  const segments = useSegments(websiteId, source.kind === "site");
  const m = useSegmentMutations(websiteId);
  const [name, setName] = useState("");
  const canWrite = source.kind === "site" && source.canWrite;
  const apply = (s: Segment) => {
    state.setFilters(filtersFromSearch(s.filters));
    onApplied();
  };
  return (
    <section aria-labelledby="segments-title" className="space-y-2">
      <h3 id="segments-title" className="text-sm font-semibold">
        Segments
      </h3>
      {segments.data?.length ? (
        <ul className="space-y-1">
          {segments.data.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => apply(s)}
                className="flex-1 truncate rounded-md border border-line px-3 py-1.5 text-left text-sm hover:bg-surface-2"
              >
                <span className="font-medium">{s.name}</span>
                <span className="ml-2 text-xs text-muted">
                  {filtersFromSearch(s.filters).map(describeFilter).join(" · ")}
                </span>
              </button>
              {canWrite ? (
                <button
                  type="button"
                  aria-label={`Delete segment ${s.name}`}
                  onClick={() => m.remove.mutate(s.id)}
                  className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-error-text"
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">
          {segments.isPending ? "Loading segments…" : "No saved segments yet."}
        </p>
      )}
      {canWrite && state.filters.length ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            m.create.mutate(
              { name: name.trim().slice(0, 80), filters: filtersToParams(state.filters) },
              { onSuccess: () => setName("") },
            );
          }}
        >
          <input
            aria-label="Segment name"
            placeholder="Name this filter combination"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
          />
          <Button type="submit" variant="secondary" disabled={!name.trim() || m.create.isPending}>
            Save as segment
          </Button>
        </form>
      ) : null}
      {m.create.isSuccess ? (
        <p role="status" className="text-xs text-success-text">
          Segment saved.
        </p>
      ) : null}
      {m.create.error ? (
        <p role="alert" className="text-xs text-error-text">
          {m.create.error.message}
        </p>
      ) : null}
    </section>
  );
}

export function FilterBar({
  state,
  segments = true,
}: {
  state: DashboardState;
  segments?: boolean;
}) {
  const source = useSource();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ActiveFilter | undefined>();
  const close = () => {
    setOpen(false);
    setEditing(undefined);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => {
          setEditing(undefined);
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm hover:bg-surface-2"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="size-4 text-muted"
          fill="currentColor"
        >
          <path d="M3 4h14l-5.5 6.5V16l-3 1.5v-7z" />
        </svg>
        Filter
      </button>
      {state.filters.map((f) => (
        <span
          key={f.key}
          className="inline-flex max-w-full items-center rounded-md border border-primary/40 bg-surface text-sm"
        >
          <button
            type="button"
            onClick={() => {
              setEditing(f);
              setOpen(true);
            }}
            aria-label={`Edit filter: ${describeFilter(f)}`}
            className="max-w-[16rem] truncate px-2 py-1.5 text-left hover:bg-surface-2"
          >
            <span className="text-muted">{filterDef(f.key)?.label}</span>{" "}
            <span className="text-muted">{OP_LABELS[f.op]}</span>{" "}
            <span className="font-medium">{f.values.join(", ")}</span>
          </button>
          <button
            type="button"
            aria-label={`Remove filter: ${describeFilter(f)}`}
            onClick={() => state.setFilters(removeFilter(state.filters, f.key))}
            className="border-l border-line px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text"
          >
            ✕
          </button>
        </span>
      ))}
      {state.filters.length > 1 ? (
        <button
          type="button"
          onClick={() => state.setFilters([])}
          className="text-sm text-muted underline-offset-2 hover:text-text hover:underline"
        >
          Clear all
        </button>
      ) : null}
      <Dialog open={open} onClose={close} title={editing ? "Edit filter" : "Filters"}>
        <div className="space-y-5">
          {segments && source.kind === "site" && !editing ? (
            <SegmentsPanel state={state} onApplied={close} />
          ) : null}
          <section className={cx(!editing && "border-t border-line pt-4")}>
            {!editing ? <h3 className="mb-2 text-sm font-semibold">Add a filter</h3> : null}
            <FilterBuilder state={state} initial={editing} onDone={close} />
          </section>
        </div>
      </Dialog>
    </div>
  );
}
