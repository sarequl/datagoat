/** Signed-in layout: sidebar with site switcher and navigation, top bar, page outlet. */
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { WebsiteSummary } from "../../../shared/api-types";
import { useLogout, useMe } from "../api/hooks";
import { NAV_GROUPS, SITE_PAGES } from "../nav";
import { LogoMark } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

export function SiteSwitcher({
  websites,
  current,
}: {
  websites: WebsiteSummary[];
  current: string;
}) {
  const navigate = useNavigate();
  return (
    <label className="block">
      <span className="sr-only">Website</span>
      <select
        aria-label="Website"
        value={current}
        onChange={(e) => {
          if (e.target.value === "__new") void navigate({ to: "/app/new-site" });
          else void navigate({ to: "/app/$siteId/overview", params: { siteId: e.target.value } });
        }}
        className="w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
      >
        {websites.map((w) => (
          <option key={w._id} value={w._id}>
            {w.name ?? w.domain}
          </option>
        ))}
        <option value="__new">+ Add website</option>
      </select>
    </label>
  );
}

export function Sidebar({ siteId, websites }: { siteId: string; websites: WebsiteSummary[] }) {
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <div className="flex items-center gap-2 px-1 font-semibold">
        <LogoMark size={28} />
        DataGoat
      </div>
      <SiteSwitcher websites={websites} current={siteId} />
      {NAV_GROUPS.map((group) => (
        <div key={group} className="space-y-1">
          <div className="px-2 text-xs font-medium uppercase tracking-wide text-muted">{group}</div>
          <ul className="space-y-0.5">
            {SITE_PAGES.filter((p) => p.group === group && !p.hidden).map((p) => (
              <li key={p.path}>
                <Link
                  to={`/app/$siteId/${p.path}`}
                  params={{ siteId }}
                  className="block rounded-md px-2 py-1.5 text-sm hover:bg-surface-2"
                  activeProps={{
                    className: "bg-surface-2 font-medium text-primary-text",
                    "aria-current": "page",
                  }}
                >
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="mt-auto space-y-1">
        <Link
          to="/app/websites"
          className="block rounded-md px-2 py-1.5 text-sm hover:bg-surface-2"
          activeProps={{
            className: "bg-surface-2 font-medium text-primary-text",
            "aria-current": "page",
          }}
        >
          All websites
        </Link>
        <Link to="/app/account" className="block rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
          Account
        </Link>
      </div>
    </nav>
  );
}

export function TopBar() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <header className="flex items-center justify-end gap-3 border-b border-line px-6 py-3 text-sm">
      <ThemeToggle />
      <span className="hidden truncate text-muted sm:inline">{me.data?.user.email}</span>
      <button
        type="button"
        className="rounded-md px-2 py-1 hover:bg-surface-2"
        onClick={() =>
          logout.mutate(undefined, { onSuccess: () => void navigate({ to: "/login" }) })
        }
      >
        Sign out
      </button>
    </header>
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
        className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-surface shadow-xl"
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
  const close = useCallback(() => setMenuOpen(false), []);
  // Close the drawer after navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the path changes
  useEffect(() => setMenuOpen(false), [pathname]);
  const current = siteId ?? websites[0]?._id ?? "";
  return (
    <div className="min-h-screen md:grid md:grid-cols-[13rem_1fr] lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-line bg-surface md:block">
        <Sidebar siteId={current} websites={websites} />
      </aside>
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 md:hidden">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-controls="nav-drawer"
          onClick={() => setMenuOpen(true)}
          className="rounded-md p-2 hover:bg-surface-2"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="currentColor">
            <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h14v2H3z" />
          </svg>
        </button>
        <span className="flex items-center gap-2 font-semibold">
          <LogoMark size={24} />
          DataGoat
        </span>
      </div>
      <NavDrawer open={menuOpen} onClose={close}>
        <Sidebar siteId={current} websites={websites} />
      </NavDrawer>
      <div className="min-w-0">
        <TopBar />
        <main className="mx-auto max-w-6xl p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
