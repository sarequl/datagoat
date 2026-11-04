/**
 * Route tree. Pages load lazily (one chunk per page) from pages/**; the website pages come from
 * nav.ts so the sidebar and the routes never drift.
 *
 *   /                         → /app
 *   /login /setup /invite/$token /reset-password/$token
 *   /share/$token             public read-only dashboard (W4)
 *   /oauth/consent            MCP OAuth consent (W7; the Worker serves this SPA for /oauth/*)
 *   /app                      signed-in area → first website or /app/new-site
 *   /app/new-site /app/account
 *   /app/$siteId/<page>       every entry of SITE_PAGES
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  Outlet,
  type RouteComponent,
  redirect,
  useParams,
} from "@tanstack/react-router";
import { useMe } from "./api/hooks";
import { AppShell } from "./components/AppShell";
import { PagePlaceholder } from "./components/PagePlaceholder";
import { Spinner } from "./components/ui";
import { SITE_PAGES } from "./nav";

const pages = import.meta.glob<{ default: RouteComponent }>("./pages/**/*.tsx");

function page(name: string) {
  const loader = pages[`./pages/${name}.tsx`];
  if (!loader) throw new Error(`Missing page module pages/${name}.tsx`);
  return lazyRouteComponent(loader);
}

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <PagePlaceholder title="Page not found" owner="F0" description="This page does not exist." />
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/app" });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: page("auth/LoginPage"),
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: page("auth/SetupPage"),
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: page("auth/InvitePage"),
});
const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password/$token",
  component: page("auth/ResetPasswordPage"),
});
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share/$token",
  component: page("public/SharedDashboardPage"),
});
const consentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/consent",
  component: page("oauth/OAuthConsentPage"),
});

/** Signed-in area: redirects to /login when there is no session. */
function SignedIn() {
  const me = useMe();
  if (me.isPending) return <Spinner />;
  if (!me.data) return <Navigate to="/login" />;
  return <Outlet />;
}

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: SignedIn,
});

function AppIndex() {
  const me = useMe();
  const first = me.data?.websites[0];
  if (!first) return <Navigate to="/app/new-site" />;
  return <Navigate to="/app/$siteId/overview" params={{ siteId: first._id }} />;
}

const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: AppIndex,
});

function PlainLayout() {
  const me = useMe();
  return <AppShell websites={me.data?.websites ?? []} />;
}

const plainRoute = createRoute({
  getParentRoute: () => appRoute,
  id: "plain",
  component: PlainLayout,
});
const newSiteRoute = createRoute({
  getParentRoute: () => plainRoute,
  path: "/new-site",
  component: page("account/NewSitePage"),
});
const accountRoute = createRoute({
  getParentRoute: () => plainRoute,
  path: "/account",
  component: page("account/AccountPage"),
});

function SiteLayout() {
  const me = useMe();
  const { siteId } = useParams({ strict: false }) as { siteId: string };
  const websites = me.data?.websites ?? [];
  if (!websites.some((w) => w._id === siteId)) {
    return (
      <PagePlaceholder
        title="Website not found"
        owner="F0"
        description="You do not have access to this website."
      />
    );
  }
  return <AppShell websites={websites} />;
}

const siteRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "$siteId",
  component: SiteLayout,
});

const siteIndexRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/app/$siteId/overview", params });
  },
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "settings",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/app/$siteId/settings/general", params });
  },
});

const sitePageRoutes = SITE_PAGES.map((item) =>
  createRoute({ getParentRoute: () => siteRoute, path: item.path, component: page(item.page) }),
);

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  setupRoute,
  inviteRoute,
  resetRoute,
  shareRoute,
  consentRoute,
  appRoute.addChildren([
    appIndexRoute,
    plainRoute.addChildren([newSiteRoute, accountRoute]),
    siteRoute.addChildren([siteIndexRoute, settingsIndexRoute, ...sitePageRoutes]),
  ]),
]);

export function createAppRouter(
  queryClient: QueryClient,
  history?: Parameters<typeof createRouter>[0]["history"],
) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPendingComponent: () => <Spinner />,
    ...(history ? { history } : {}),
  });
}
