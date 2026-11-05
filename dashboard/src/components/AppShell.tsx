/**
 * Signed-in layout (Polar-style): the sidebar sits on the shell colour and the page is an inset,
 * rounded card. Sidebar: website switcher, "Search or jump to…" (⌘K), Analytics, Growth, then
 * Integrations and the collapsible Developers and Settings groups, and the account menu.
 */
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { WebsiteSummary } from "../../../shared/api-types";
import { useRealtimeCount } from "../analytics/hooks";
import { useLogout, useMe } from "../api/hooks";
import { COLLAPSIBLE_GROUPS, type NavGroup, type NavItem, SITE_PAGES } from "../nav";
import { CommandMenu, isMac, useCommandShortcut } from "./CommandMenu";
import { LogoMark } from "./Logo";
import { Icon, PAGE_ICONS } from "./NavIcons";
import { ThemeToggle } from "./ThemeToggle";

const TILE_COLOURS = ["#6d7cff", "#e16540", "#00a96e", "#00b5ff", "#c05cd6", "#e0a100", "#e2557a"];

/** A coloured letter tile for a website (no favicon request leaves the browser). */
export function SiteTile({ domain, size = 28 }: { domain: string; size?: number }) {
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-[7px] text-[13px] font-bold text-white"
      style={{ width: size, height: size, background: TILE_COLOURS[hash % TILE_COLOURS.length] }}
    >
      {domain.replace(/^www\./, "")[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/**
 * Website switcher: looks like a button, works as a native select (keyboard, screen readers and
 * phones get the platform picker). The last options open All websites and Add website.
 */
export function SiteSwitcher({
  websites,
  current,
}: {
  websites: WebsiteSummary[];
  current: string;
}) {
  const navigate = useNavigate();
  const site = websites.find((w) => w._id === current) ?? websites[0];
  return (
    <div className="relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 focus-within:outline-2 focus-within:outline-primary hover:bg-shell-hover">
      <SiteTile domain={site?.domain ?? "?"} />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold">
          {site?.name ?? site?.domain ?? "No website"}
        </div>
        {site?.name && site.name !== site.domain ? (
          <div className="truncate text-xs text-muted">{site.domain}</div>
        ) : null}
      </div>
      <Icon name="updown" className="ml-auto size-4 shrink-0 text-muted" />
      <select
        aria-label="Website"
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new") void navigate({ to: "/app/new-site" });
          else if (v === "__all") void navigate({ to: "/app/websites" });
          else void navigate({ to: "/app/$siteId/overview", params: { siteId: v } });
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {websites.map((w) => (
          <option key={w._id} value={w._id}>
            {w.name ?? w.domain}
          </option>
        ))}
        <option value="__all">All websites</option>
        <option value="__new">+ Add website</option>
      </select>
    </div>
  );
}

const ITEM =
  "group flex items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-sm font-medium text-muted hover:bg-shell-hover hover:text-text";
const ITEM_ACTIVE = "bg-pill text-text shadow-pill hover:bg-pill";

/** Whether `pathname` is on `item` (its sub-pages, e.g. a visitor profile, count too). */
export function isActive(pathname: string, siteId: string, item: NavItem): boolean {
  const base = `/app/${siteId}/`;
  // Every settings tab highlights "General".
  const path = item.path === "settings/general" ? "settings" : item.path;
  return pathname === base + path || pathname.startsWith(`${base}${path}/`);
}

function NavLink({
  item,
  siteId,
  active,
  nested,
  badge,
}: {
  item: NavItem;
  siteId: string;
  active: boolean;
  nested?: boolean;
  badge?: ReactNode;
}) {
  const icon = PAGE_ICONS[item.path];
  return (
    <Link
      to={`/app/$siteId/${item.path}`}
      params={{ siteId }}
      aria-current={active ? "page" : undefined}
      className={`${ITEM} ${nested ? "py-1 text-[13.5px]" : ""} ${
        active ? (nested ? "text-text font-semibold" : ITEM_ACTIVE) : ""
      }`}
    >
      {icon && !nested ? (
        <Icon
          name={icon}
          className={`size-4 shrink-0 ${active ? "text-primary" : "text-muted group-hover:text-text"}`}
        />
      ) : null}
      <span className="truncate">{item.navLabel ?? item.label}</span>
      {badge}
    </Link>
  );
}

function LiveBadge({ siteId }: { siteId: string }) {
  const live = useRealtimeCount(siteId, Boolean(siteId));
  if (live.data === undefined) return null;
  return (
    <span
      className="ml-auto flex items-center gap-1.5 text-xs tabular-nums text-muted"
      title={`${live.data} visitors online`}
    >
      <span
        className={`size-1.5 rounded-full ${live.data > 0 ? "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--dg-success)_22%,transparent)]" : "bg-muted"}`}
      />
      <span className="sr-only">Visitors online: </span>
      {live.data}
    </span>
  );
}

function NavGroupSection({
  group,
  siteId,
  pathname,
}: {
  group: NavGroup;
  siteId: string;
  pathname: string;
}) {
  const items = SITE_PAGES.filter((p) => p.group === group && !p.hidden);
  const containsActive = SITE_PAGES.some((p) => p.group === group && isActive(pathname, siteId, p));
  const [open, setOpen] = useState(containsActive);
  const listId = useId();
  // Entering the group (from a link elsewhere, ⌘K, the browser) opens it.
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className={`${ITEM} w-full ${containsActive && !open ? ITEM_ACTIVE : ""}`}
      >
        <Icon
          name={PAGE_ICONS[group] ?? "page"}
          className={`size-4 shrink-0 ${containsActive ? "text-primary" : "text-muted group-hover:text-text"}`}
        />
        {group}
        <Icon name={open ? "down" : "right"} className="ml-auto size-4 shrink-0 text-muted" />
      </button>
      {open ? (
        <ul
          id={listId}
          className="my-0.5 ml-[1.15rem] space-y-px border-l border-line-strong pl-2.5"
        >
          {items.map((p) => (
            <li key={p.path}>
              <NavLink item={p} siteId={siteId} active={isActive(pathname, siteId, p)} nested />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AccountMenu() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const email = me.data?.user.email ?? "";
  const initials = email.slice(0, 2).toUpperCase();
  const row =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2";
  return (
    <div ref={box} className="relative">
      {open ? (
        <div
          id={menuId}
          className="absolute inset-x-0 bottom-full z-20 mb-1 rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          <Link to="/app/account" className={row} onClick={() => setOpen(false)}>
            <Icon name="account" className="size-4 text-muted" />
            Account
          </Link>
          <Link to="/app/websites" className={row} onClick={() => setOpen(false)}>
            <Icon name="websites" className="size-4 text-muted" />
            All websites
          </Link>
          <ThemeToggle className={row}>
            <Icon name="theme" className="size-4 text-muted" />
          </ThemeToggle>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            className={row}
            onClick={() =>
              logout.mutate(undefined, { onSuccess: () => void navigate({ to: "/login" }) })
            }
          >
            <Icon name="signout" className="size-4 text-muted" />
            Sign out
          </button>
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu${email ? ` for ${email}` : ""}`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-shell-hover"
      >
        <span className="grid size-[26px] shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted">
          {initials}
        </span>
        <span className="truncate text-[13px]">{email}</span>
        <Icon name="more" className="ml-auto size-4 shrink-0 text-muted" />
      </button>
    </div>
  );
}

export function Sidebar({
  siteId,
  websites,
  onSearch,
}: {
  siteId: string;
  websites: WebsiteSummary[];
  onSearch: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const link = (p: NavItem) => (
    <li key={p.path}>
      <NavLink
        item={p}
        siteId={siteId}
        active={isActive(pathname, siteId, p)}
        badge={p.path === "realtime" ? <LiveBadge siteId={siteId} /> : undefined}
      />
    </li>
  );
  const visible = (g: NavGroup) => SITE_PAGES.filter((p) => p.group === g && !p.hidden);
  return (
    <nav aria-label="Main" className="flex h-full flex-col overflow-y-auto p-3">
      <SiteSwitcher websites={websites} current={siteId} />
      <button
        type="button"
        onClick={onSearch}
        className="mb-2.5 mt-2 flex items-center gap-2 rounded-lg bg-pill px-2.5 py-1.5 text-[13px] text-muted shadow-pill hover:text-text"
      >
        <Icon name="search" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">Search…</span>
        <kbd className="ml-auto shrink-0 whitespace-nowrap rounded border border-line-strong px-1.5 font-mono text-[11px]">
          {isMac() ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>
      <ul className="space-y-px">{visible("Analytics").map(link)}</ul>
      <div className="px-2.5 pb-1 pt-4 text-xs font-medium text-muted">Growth</div>
      <ul className="space-y-px">{visible("Growth").map(link)}</ul>
      <ul className="mt-auto space-y-px pt-6">
        {visible("Integrations").map(link)}
        {COLLAPSIBLE_GROUPS.map((g) => (
          <NavGroupSection key={g} group={g} siteId={siteId} pathname={pathname} />
        ))}
      </ul>
      <div className="mt-2 pt-1">
        <AccountMenu />
      </div>
    </nav>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), select, input, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Phone navigation drawer: a modal dialog holding the sidebar. Focus is trapped inside, Escape
 * and the backdrop close it, and it closes after navigation. Focus returns to the menu button.
 */
export function NavDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        ref={panel}
        id="nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-shell shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

export function AppShell({ websites }: { websites: WebsiteSummary[] }) {
  const { siteId } = useParams({ strict: false }) as { siteId?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const close = useCallback(() => setMenuOpen(false), []);
  const openSearch = useCallback(() => {
    setMenuOpen(false);
    setSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  useCommandShortcut(openSearch);
  // Close the drawer after navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the path changes
  useEffect(() => setMenuOpen(false), [pathname]);
  const current = siteId ?? websites[0]?._id ?? "";
  return (
    <div className="min-h-screen bg-shell md:grid md:grid-cols-[14rem_1fr] lg:grid-cols-[15.5rem_1fr]">
      <aside className="sticky top-0 hidden h-screen md:block">
        <Sidebar siteId={current} websites={websites} onSearch={openSearch} />
      </aside>
      <div className="flex items-center gap-3 border-b border-line bg-shell px-4 py-2 md:hidden">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-controls="nav-drawer"
          onClick={() => setMenuOpen(true)}
          className="rounded-md p-2 hover:bg-shell-hover"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="currentColor">
            <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h14v2H3z" />
          </svg>
        </button>
        <span className="flex items-center gap-2 font-semibold">
          <LogoMark size={24} />
          DataGoat
        </span>
        <button
          type="button"
          aria-label="Search or jump to"
          onClick={openSearch}
          className="ml-auto rounded-md p-2 text-muted hover:bg-shell-hover"
        >
          <Icon name="search" className="size-5" />
        </button>
      </div>
      <NavDrawer open={menuOpen} onClose={close}>
        <Sidebar siteId={current} websites={websites} onSearch={openSearch} />
      </NavDrawer>
      <CommandMenu open={searchOpen} onClose={closeSearch} siteId={current} websites={websites} />
      <div className="min-w-0 md:py-2 md:pr-2">
        <div className="min-h-screen bg-shell-card md:min-h-[calc(100vh-1rem)] md:rounded-2xl md:shadow-card">
          <main className="mx-auto max-w-6xl p-4 md:p-8">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
