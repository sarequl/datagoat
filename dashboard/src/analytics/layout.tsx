/**
 * Customizable Overview: the cards below the headline card are grouped in sections; in Customize
 * mode the user reorders sections and the cards inside them (drag and drop, or Move up/down
 * buttons for the keyboard and touch screens), hides and shows cards, and resets to the default.
 * The layout is saved per user and website (`/api/v1/admin/account/overview-layout`) when the
 * user presses Done, so the Overview looks the same on every device.
 *
 * Widths are automatic: cards sit two per row on wide screens, and a card left without a partner
 * at the end of a section (or before a full-width card) stretches across the row.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import type { OverviewLayout, OverviewLayoutResponse } from "../../../shared/api-types";
import { api, apiGet } from "../api/client";
import { cx } from "../components/ui";

export interface CardDef {
  id: string;
  label: string;
  node: ReactNode;
  /** Always take the whole row (e.g. the activity heatmap). */
  full?: boolean;
}

export interface SectionDef {
  id: string;
  title?: string;
  cards: CardDef[];
}

export const EMPTY_LAYOUT: OverviewLayout = { sections: [], cards: {}, hidden: [] };

/** Order `items` by `order` (unknown ids ignored); items missing from `order` keep their place. */
export function orderBy<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = items
    .filter((i) => rank.has(i.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  // New cards (not in the saved order) go back to their default position among the known ones.
  const out = [...known];
  items.forEach((item, defaultIndex) => {
    if (!rank.has(item.id)) out.splice(Math.min(defaultIndex, out.length), 0, item);
  });
  return out;
}

/** Sections and cards in the user's order. */
export function applyLayout(sections: SectionDef[], layout: OverviewLayout | null): SectionDef[] {
  const l = layout ?? EMPTY_LAYOUT;
  return orderBy(sections, l.sections).map((s) => ({
    ...s,
    cards: orderBy(s.cards, l.cards[s.id]),
  }));
}

/** Which visible cards span the whole row: full cards, and half cards without a partner. */
export function fullWidth(cards: Array<{ id: string; full?: boolean }>): Set<string> {
  const out = new Set<string>();
  let open: string | null = null; // a half card waiting for a partner on its row
  for (const c of cards) {
    if (c.full) {
      if (open) out.add(open);
      open = null;
      out.add(c.id);
    } else if (open) open = null;
    else open = c.id;
  }
  if (open) out.add(open);
  return out;
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** The saved layout of a website, and a way to save it (optimistically). */
export function useOverviewLayout(siteId: string) {
  const qc = useQueryClient();
  const key = ["overview-layout", siteId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await apiGet<OverviewLayoutResponse[]>("/api/v1/admin/account/overview-layout", {
          websiteId: siteId,
        })
      )[0]?.layout ?? null,
    staleTime: 5 * 60_000,
    retry: false,
    enabled: Boolean(siteId),
  });
  const save = useMutation({
    mutationFn: (layout: OverviewLayout | null) =>
      api.put<OverviewLayoutResponse[]>("/api/v1/admin/account/overview-layout", {
        websiteId: siteId,
        layout,
      }),
    onMutate: (layout) => {
      const before = qc.getQueryData(key);
      qc.setQueryData(key, layout);
      return { before };
    },
    onError: (_e, _l, ctx) => qc.setQueryData(key, ctx?.before ?? null),
  });
  return { layout: query.data ?? null, ready: !query.isPending, save };
}

/** The full layout as currently shown (every section and card id), for saving. */
function snapshot(sections: SectionDef[], hidden: string[]): OverviewLayout {
  return {
    sections: sections.map((s) => s.id),
    cards: Object.fromEntries(sections.map((s) => [s.id, s.cards.map((c) => c.id)])),
    hidden,
  };
}

function Grip() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
      {[4, 8, 12].flatMap((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" />),
      )}
    </svg>
  );
}

const TOOL =
  "grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent";

function Arrow({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={dir === "up" ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
    </svg>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">{children}</h2>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * The arranged sections. Outside Customize mode it simply renders the visible cards; in Customize
 * mode every card and section gets a drag handle, Move up/down buttons and Hide/Show.
 */
export function ArrangedSections({
  sections,
  hidden,
  editing,
  onChange,
}: {
  sections: SectionDef[];
  hidden: string[];
  editing: boolean;
  /** The new layout, while editing (saved by the caller on Done). */
  onChange: (layout: OverviewLayout) => void;
}) {
  const [drag, setDrag] = useState<{
    kind: "card" | "section";
    id: string;
    section?: string;
  } | null>(null);
  const commit = (next: SectionDef[], nextHidden = hidden) => onChange(snapshot(next, nextHidden));
  const moveCard = (sectionId: string, from: number, to: number) =>
    commit(
      sections.map((s) => (s.id === sectionId ? { ...s, cards: move(s.cards, from, to) } : s)),
    );
  const moveSection = (from: number, to: number) => commit(move(sections, from, to));
  const toggle = (id: string) =>
    commit(sections, hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]);

  const dragOverCard = (e: DragEvent, sectionId: string, index: number) => {
    if (drag?.kind !== "card" || drag.section !== sectionId) return;
    e.preventDefault();
    const s = sections.find((x) => x.id === sectionId);
    const from = s?.cards.findIndex((c) => c.id === drag.id) ?? -1;
    if (from >= 0 && from !== index) moveCard(sectionId, from, index);
  };
  const dragOverSection = (e: DragEvent, index: number) => {
    if (drag?.kind !== "section") return;
    e.preventDefault();
    const from = sections.findIndex((s) => s.id === drag.id);
    if (from >= 0 && from !== index) moveSection(from, index);
  };

  return (
    <div className="space-y-4">
      {sections.map((section, si) => {
        const cards = editing ? section.cards : section.cards.filter((c) => !hidden.includes(c.id));
        if (!cards.length && !editing) return null;
        const wide = fullWidth(cards);
        return (
          <section
            key={section.id}
            aria-label={editing ? `${section.title ?? "Breakdowns"} section` : undefined}
            data-testid={`section-${section.id}`}
            onDragOver={(e) => dragOverSection(e, si)}
            className={cx(
              "space-y-4",
              editing && "rounded-xl border border-dashed border-line-strong p-3",
              drag?.kind === "section" && drag.id === section.id && "opacity-60",
            )}
          >
            {editing ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", section.id);
                    setDrag({ kind: "section", id: section.id });
                  }}
                  onDragEnd={() => setDrag(null)}
                  aria-label={`Drag the ${section.title ?? "Breakdowns"} section`}
                  className={cx(TOOL, "cursor-grab active:cursor-grabbing")}
                >
                  <Grip />
                </button>
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                  {section.title ?? "Breakdowns"}
                </span>
                <span className="ml-auto flex">
                  <button
                    type="button"
                    className={TOOL}
                    aria-label={`Move the ${section.title ?? "Breakdowns"} section up`}
                    disabled={si === 0}
                    onClick={() => moveSection(si, si - 1)}
                  >
                    <Arrow dir="up" />
                  </button>
                  <button
                    type="button"
                    className={TOOL}
                    aria-label={`Move the ${section.title ?? "Breakdowns"} section down`}
                    disabled={si === sections.length - 1}
                    onClick={() => moveSection(si, si + 1)}
                  >
                    <Arrow dir="down" />
                  </button>
                </span>
              </div>
            ) : section.title ? (
              <SectionTitle>{section.title}</SectionTitle>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-2">
              {cards.map((card, ci) => {
                const isHidden = hidden.includes(card.id);
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; keyboard users use the Move buttons
                  <div
                    key={card.id}
                    data-card={card.id}
                    onDragOver={(e) => dragOverCard(e, section.id, ci)}
                    className={cx(
                      "relative min-w-0",
                      wide.has(card.id) && "lg:col-span-2",
                      editing && "rounded-lg ring-1 ring-line-strong",
                      drag?.kind === "card" && drag.id === card.id && "opacity-50",
                    )}
                  >
                    {editing ? (
                      <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-1 rounded-t-lg border-b border-line bg-surface/95 px-2 py-1 backdrop-blur">
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", card.id);
                            setDrag({ kind: "card", id: card.id, section: section.id });
                          }}
                          onDragEnd={() => setDrag(null)}
                          aria-label={`Drag ${card.label}`}
                          className={cx(TOOL, "cursor-grab active:cursor-grabbing")}
                        >
                          <Grip />
                        </button>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {card.label}
                        </span>
                        <button
                          type="button"
                          className={TOOL}
                          aria-label={`Move ${card.label} up`}
                          disabled={ci === 0}
                          onClick={() => moveCard(section.id, ci, ci - 1)}
                        >
                          <Arrow dir="up" />
                        </button>
                        <button
                          type="button"
                          className={TOOL}
                          aria-label={`Move ${card.label} down`}
                          disabled={ci === cards.length - 1}
                          onClick={() => moveCard(section.id, ci, ci + 1)}
                        >
                          <Arrow dir="down" />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggle(card.id)}
                          aria-label={`${isHidden ? "Show" : "Hide"} ${card.label}`}
                          className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
                        >
                          {isHidden ? "Show" : "Hide"}
                        </button>
                      </div>
                    ) : null}
                    {editing && isHidden ? (
                      <div className="grid h-28 place-items-center rounded-lg border border-dashed border-line bg-surface-2/60 pt-8 text-sm text-muted">
                        Hidden
                      </div>
                    ) : (
                      <div
                        className={cx(
                          editing && "pointer-events-none select-none pt-10 opacity-90",
                        )}
                        aria-hidden={editing || undefined}
                        // React 18 has no boolean `inert` prop yet; an empty string sets it.
                        {...(editing ? { inert: "" } : {})}
                      >
                        {card.node}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The Overview's customizable part: renders the sections in the saved order, and owns Customize
 * mode (a draft that is saved on Done, dropped on Cancel; Reset goes back to the default).
 */
export function CustomizableOverview({
  siteId,
  sections: defaults,
  editing,
  onEditingChange,
}: {
  siteId: string;
  sections: SectionDef[];
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const { layout, ready, save } = useOverviewLayout(siteId);
  const [draft, setDraft] = useState<OverviewLayout | null>(null);
  // Entering Customize mode starts from the saved layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the mode changes
  useEffect(() => {
    setDraft(editing ? (layout ?? null) : null);
  }, [editing]);
  const current = editing ? draft : layout;
  const sections = useMemo(() => applyLayout(defaults, current), [defaults, current]);
  const hidden = current?.hidden ?? [];
  if (!ready) return null;
  return (
    <>
      <ArrangedSections
        sections={sections}
        hidden={hidden}
        editing={editing}
        onChange={(next) => setDraft(next)}
      />
      {!editing && hidden.length ? (
        <p className="text-center text-xs text-muted">
          {hidden.length} hidden {hidden.length === 1 ? "card" : "cards"} ·{" "}
          <button
            type="button"
            onClick={() => onEditingChange(true)}
            className="underline underline-offset-2 hover:text-text"
          >
            Customize to show them
          </button>
        </p>
      ) : null}
      {editing ? (
        <div
          role="toolbar"
          aria-label="Customize Overview"
          className="sticky bottom-4 z-30 mx-auto flex w-fit flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 shadow-xl"
        >
          <span className="px-1 text-sm text-muted">
            Drag cards or use the arrows to rearrange.
          </span>
          <button
            type="button"
            onClick={() => setDraft(null)}
            className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-text"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={() => onEditingChange(false)}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const isDefault =
                !draft ||
                (!draft.hidden.length &&
                  JSON.stringify(snapshot(applyLayout(defaults, draft), [])) ===
                    JSON.stringify(snapshot(defaults, [])));
              save.mutate(isDefault ? null : draft);
              onEditingChange(false);
            }}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg hover:opacity-90"
          >
            Done
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Hide one card right away (the "Hide this card" link on setup cards), saving the layout. */
export function useHideCard(siteId: string) {
  const { layout, save } = useOverviewLayout(siteId);
  return (id: string) => {
    const base = layout ?? EMPTY_LAYOUT;
    if (base.hidden.includes(id)) return;
    save.mutate({ ...base, hidden: [...base.hidden, id] });
  };
}
