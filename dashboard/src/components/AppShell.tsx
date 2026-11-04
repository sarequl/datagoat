/** Signed-in layout: sidebar with site switcher and navigation, top bar, page outlet. */
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import type { WebsiteSummary } from "../../../shared/api-types";
import { useLogout, useMe } from "../api/hooks";
import { NAV_GROUPS, SITE_PAGES } from "../nav";
import { ThemeToggle } from "./ThemeToggle";
import { cx } from "./ui";

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
        <span className="flex size-7 items-center justify-center rounded-md bg-accent text-sm text-accent-fg">
          D
        </span>
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
                  activeProps={{ className: "bg-surface-2 font-medium", "aria-current": "page" }}
                >
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="mt-auto space-y-1">
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
      <span className="text-muted">{me.data?.user.email}</span>
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

export function AppShell({ websites }: { websites: WebsiteSummary[] }) {
  const { siteId } = useParams({ strict: false }) as { siteId?: string };
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[15rem_1fr]">
      <aside className={cx("border-b border-line bg-surface md:border-r md:border-b-0")}>
        <Sidebar siteId={siteId ?? websites[0]?._id ?? ""} websites={websites} />
      </aside>
      <div className="min-w-0">
        <TopBar />
        <main className="mx-auto max-w-6xl p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
