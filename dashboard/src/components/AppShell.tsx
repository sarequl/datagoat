/**
 * Signed-in layout: a top bar (logo, website switcher, Overview, Realtime, Visitors, Settings,
 * "Search or jump to…" (⌘K) and the account menu) over the page. Analytics and Growth pages open
 * from the Overview's cards and ⌘K; Integrations, Developers and Settings pages sit inside
 * Settings, which has its own left menu (SettingsFrame).
 */
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { WebsiteSummary } from "../../../shared/api-types";
import { useRealtimeCount } from "../analytics/hooks";
import { useLogout, useMe } from "../api/hooks";
import { inSettings, type NavItem, pageAt, SETTINGS_MENU, SITE_PAGES, TOP_LINKS } from "../nav";
import { CommandMenu, isMac, useCommandShortcut } from "./CommandMenu";
import { LogoMark } from "./Logo";
import { Icon } from "./NavIcons";
import { ThemeToggle } from "./ThemeToggle";
import { BackLink } from "./ui";

const TILE_COLOURS = ["#6d7cff", "#e16540", "#00a96e", "#00b5ff", "#c05cd6", "#e0a100", "#e2557a"];

/** A coloured letter tile for a website (no favicon request leaves the browser). */
export function SiteTile({ domain, size = 28 }: { domain: string; size?: number }) {
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-[7px] font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        background: TILE_COLOURS[hash % TILE_COLOURS.length],
      }}
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
    <div
      className="relative flex items-center gap-2 rounded-lg px-1.5 py-1 focus-within:outline-2 focus-within:outline-primary hover:bg-shell-hover"
      title={site?.domain}
    >
      <SiteTile domain={site?.domain ?? "?"} size={22} />
      <span className="min-w-0 truncate text-sm font-semibold">
        {site?.name ?? site?.domain ?? "No website"}
      </span>
      <Icon name="updown" className="size-4 shrink-0 text-muted" />
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

/** Whether `pathname` is on `item` (its sub-pages, e.g. a visitor profile, count too). */
export function isActive(pathname: string, siteId: string, item: NavItem): boolean {
  const base = `/app/${siteId}/`;
  return pathname === base + item.path || pathname.startsWith(`${base}${item.path}/`);
}

/** Which top-bar link `pathname` belongs to: Settings for settings pages, else Overview. */
export function topLinkFor(pathname: string, siteId: string): string | null {
  const page = pageAt(pathname, siteId);
  if (!page) return null;
  if (inSettings(page)) return "settings/general";
  for (const path of ["realtime", "visitors"])
    if (isActive(pathname, siteId, byPath(path))) return path;
  return "overview";
}

const byPath = (path: string) => SITE_PAGES.find((p) => p.path === path) as NavItem;

function LiveBadge({ siteId }: { siteId: string }) {
  const live = useRealtimeCount(siteId, Boolean(siteId));
  if (live.data === undefined) return null;
  return (
    <span
      className="flex items-center gap-1 text-xs tabular-nums text-muted"
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

const TOP_LABEL: Record<string, string> = { "settings/general": "Settings" };

function TopLinks({ siteId, pathname }: { siteId: string; pathname: string }) {
  const section = topLinkFor(pathname, siteId);
  return (
    <ul className="-mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1">
      {TOP_LINKS.map((path) => {
        const item = byPath(path);
        const on = section === path;
        // aria-current only on the page itself; a section's sub-pages show it highlighted.
        const here =
          path === "settings/general"
            ? isActive(pathname, siteId, item)
            : on && pageAt(pathname, siteId)?.path === path;
        return (
          <li key={path} className="shrink-0">
            <Link
              to={`/app/$siteId/${path}`}
              params={{ siteId }}
              aria-current={here ? "page" : undefined}
              data-active={on ? "" : undefined}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium ${
                on
                  ? "bg-selected font-medium text-text"
                  : "text-muted hover:bg-shell-hover hover:text-text"
              }`}
            >
              {TOP_LABEL[path] ?? item.navLabel ?? item.label}
              {path === "realtime" ? <LiveBadge siteId={siteId} /> : null}
            </Link>
          </li>
        );
      })}
    </ul>
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
          className="absolute right-0 top-full z-30 mt-1.5 w-60 rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {email ? (
            <div className="truncate px-2.5 pb-1.5 pt-1 text-xs text-muted">{email}</div>
          ) : null}
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
        className="grid size-8 place-items-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted hover:text-text"
      >
        {initials}
      </button>
    </div>
  );
}

/**
 * Settings: the left menu (nav.ts SETTINGS_MENU) next to the page. On phones the menu is a
 * horizontally scrolling row above the page.
 */
export function SettingsFrame({
  siteId,
  pathname,
  children,
}: {
  siteId: string;
  pathname: string;
  children: ReactNode;
}) {
  return (
    <div className="gap-8 md:grid md:grid-cols-[12.5rem_1fr]">
      <nav aria-label="Settings sections" className="mb-5 md:mb-0">
        <p className="mb-3 hidden px-2.5 text-lg font-semibold md:block">Settings</p>
        <div className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:block md:space-y-4 md:px-0">
          {SETTINGS_MENU.map((group) => (
            <div key={group.heading || "end"} className="flex shrink-0 gap-1 md:block">
              {group.heading ? (
                <p className="hidden px-2.5 pb-1 text-xs font-medium text-muted md:block">
                  {group.heading}
                </p>
              ) : null}
              <ul className="flex gap-1 md:block md:space-y-px">
                {group.paths.map((path) => {
                  const item = byPath(path);
                  const on = isActive(pathname, siteId, item);
                  return (
                    <li key={path} className="shrink-0">
                      <Link
                        to={`/app/$siteId/${path}`}
                        params={{ siteId }}
                        aria-current={on ? "page" : undefined}
                        className={`relative flex items-center whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${
                          on
                            ? "bg-selected font-medium text-text before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary"
                            : "text-muted hover:bg-shell-hover hover:text-text"
                        } ${path === "settings/danger" && !on ? "hover:text-error-text" : ""}`}
                      >
                        {item.navLabel ?? item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function AppShell({ websites }: { websites: WebsiteSummary[] }) {
  const { siteId } = useParams({ strict: false }) as { siteId?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  useCommandShortcut(openSearch);
  const current = siteId ?? websites[0]?._id ?? "";
  const page = siteId ? pageAt(pathname, siteId) : undefined;
  // Analytics and Growth pages other than the top-bar ones lead back to the Overview.
  const back =
    page && !inSettings(page) && !page.path.includes("$") && !TOP_LINKS.includes(page.path);
  const content = <Outlet />;
  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--dg-bg)_82%,transparent)]">
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 md:flex-nowrap md:px-6"
        >
          <Link
            to={current ? "/app/$siteId/overview" : "/app"}
            params={{ siteId: current }}
            aria-label="DataGoat"
            className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 font-semibold"
          >
            <LogoMark size={24} />
            <span className="hidden lg:inline">DataGoat</span>
          </Link>
          <span aria-hidden="true" className="text-line-strong">
            /
          </span>
          <div className="min-w-0 max-w-[14rem]">
            <SiteSwitcher websites={websites} current={current} />
          </div>
          <div className="order-last w-full md:order-none md:ml-3 md:w-auto md:min-w-0">
            <TopLinks siteId={current} pathname={pathname} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={openSearch}
              aria-label="Search or jump to"
              className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface p-2 text-[13px] text-muted hover:text-text md:w-52 md:px-2.5 md:py-1.5"
            >
              <Icon name="search" className="size-4 shrink-0" />
              <span className="hidden min-w-0 truncate md:inline">Search…</span>
              <kbd className="ml-auto hidden shrink-0 whitespace-nowrap rounded border border-line-strong px-1.5 font-mono text-[11px] md:inline">
                {isMac() ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
            <AccountMenu />
          </div>
        </nav>
      </header>
      <CommandMenu open={searchOpen} onClose={closeSearch} siteId={current} websites={websites} />
      <main className="mx-auto max-w-6xl px-4 py-5 md:px-6 md:py-7">
        {back ? (
          <BackLink to="/app/$siteId/overview" params={{ siteId: current }}>
            Overview
          </BackLink>
        ) : null}
        {page && inSettings(page) && siteId ? (
          <SettingsFrame siteId={siteId} pathname={pathname}>
            {content}
          </SettingsFrame>
        ) : (
          content
        )}
      </main>
    </div>
  );
}
