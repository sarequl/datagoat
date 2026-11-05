/** Line icons for the sidebar and command menu (24×24 grid, drawn with `currentColor`). */
import type { ReactNode } from "react";

const PATHS = {
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  realtime: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  visitors: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" />
      <path d="M16 4.8a3.4 3.4 0 0 1 0 6.4M18 14.8c1.8.8 3 2.6 3.5 5.2" />
    </>
  ),
  revenue: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9v.01M18 15v.01" />
    </>
  ),
  goals: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r=".8" />
    </>
  ),
  funnels: <path d="M3.5 5h17l-6.5 7.5V19l-4 1.8v-8.3z" />,
  mentions: (
    <>
      <path d="M4 5.5h16v10H9l-5 4z" />
      <path d="M8.5 10.5h7" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  ads: (
    <>
      <path d="M4 10v4l11 4.5V5.5z" />
      <path d="M15 9.5a3 3 0 0 1 0 5M7 14.5l1 5h3l-1-4" />
    </>
  ),
  bot: (
    <>
      <rect x="4.5" y="8" width="15" height="11" rx="3" />
      <path d="M12 4.5V8M9.5 13v.5M14.5 13v.5" />
      <circle cx="12" cy="3.8" r=".9" />
    </>
  ),
  integrations: (
    <>
      <path d="M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.5v4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  code: <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" />,
  websites: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 9h18M6.5 6.8v.01M9 6.8v.01" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20c1-3.8 4-5.8 7.5-5.8s6.5 2 7.5 5.8" />
    </>
  ),
  theme: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  signout: (
    <>
      <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" />
      <path d="m16 8 4 4-4 4M20 12H10" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  updown: <path d="m8 10 4-4 4 4M8 14l4 4 4-4" />,
  down: <path d="m7 10 5 5 5-5" />,
  right: <path d="m10 7 5 5-5 5" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r=".9" />
      <circle cx="12" cy="12" r=".9" />
      <circle cx="18.5" cy="12" r=".9" />
    </>
  ),
  page: (
    <>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13.5 3.5v4h4" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-4 shrink-0"}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Icon for a sidebar page (by its path under /app/$siteId/) or group. */
export const PAGE_ICONS: Record<string, IconName> = {
  overview: "overview",
  realtime: "realtime",
  visitors: "visitors",
  revenue: "revenue",
  goals: "goals",
  funnels: "funnels",
  mentions: "mentions",
  "search-console": "search",
  ads: "ads",
  "bot-traffic": "bot",
  integrations: "integrations",
  Developers: "code",
  Settings: "settings",
};
