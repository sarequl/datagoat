# Mobile companion app (W8)

The DataGoat app for iOS and Android: your analytics on your phone, like DataFast's mobile app
("Visitors & sessions, revenue, traffic sources, geography, devices, goals, pages", sign-in, iOS
home-screen widgets). It lives in [`apps/mobile`](../../apps/mobile) and is built with Expo (React
Native, TypeScript). It talks only to the public `/api/v1` API of the operator's own DataGoat
instance, with a token, like any other API client.

## What DataFast's app does, and what ours does

| DataFast app                                      | DataGoat app                                                                                                     | Status                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Sign in with email and a 6-digit code             | Sign in with the instance URL, email and password (DataGoat has no email requirement; see "Sign-in" below)        | built                     |
| List of websites                                  | Sites screen with today's visitors and the live count per site                                                    | built                     |
| Overview KPIs                                     | Visitors, revenue, conversion rate, revenue per visitor, bounce rate, session duration, with change vs the previous period | built                     |
| Chart                                             | Visitors and revenue over the period (hourly for today/yesterday, daily for 7/30 days, monthly for 12 months)    | built                     |
| Real-time visitors                                | Live visitors (active in the last 10 minutes, as the API defines it), refreshed every 30 s while the screen is open | built                     |
| Traffic sources, campaigns, geography, devices, goals, pages | Breakdown tabs: referrers, channels, campaigns, countries, devices, pages, goals                         | built                     |
| Push notifications for sales                      | New-sale and renewal pushes, per device and per site                                                             | built (server + app)      |
| Push notifications for alerts                     | Goal alert pushes (alerts configured in the dashboard)                                                           | built (server + app)      |
| iOS home-screen widgets                           | Widget data snapshot is built and stored by the app; the native widget extensions are not built (see "Widgets")  | **native part not built** |

## Architecture

```
apps/mobile
├─ app/                       Expo Router screens
│  ├─ _layout.tsx             providers (React Query, session), notification routing
│  ├─ index.tsx               redirect: signed in → /sites, else /sign-in
│  ├─ sign-in.tsx             instance URL + email + password
│  ├─ sites.tsx               websites with today's numbers
│  ├─ site/[id].tsx           overview: period picker, KPIs, chart, live count, breakdown tabs
│  └─ settings.tsx            notifications (sales, alerts, muted sites), sign out
└─ src/
   ├─ lib/                    pure TypeScript, unit-tested from the repo root (no React Native)
   │  ├─ api.ts               typed /api/v1 client (envelopes, errors, 401 handling)
   │  ├─ periods.ts           period presets → startAt/endAt/interval + previous period, in the site timezone
   │  ├─ format.ts            numbers, money, percentages, durations, deltas
   │  ├─ kpis.ts              KPI tiles from two overview rows
   │  ├─ chart.ts             timeseries → chart geometry
   │  ├─ notifications.ts     push payload → route; device registration body
   │  └─ widget.ts            widget snapshot
   ├─ session.tsx             secure storage of instance URL + token, sign-in/out
   ├─ push.ts                 expo-notifications: permission, Expo push token, registration
   └─ components/             KpiGrid, LineChart (react-native-svg), Breakdown, PeriodPicker
```

### Sign-in

`POST /api/v1/mobile/session {email, password, deviceName}` on the instance the user typed in
(`https://analytics.example.com`). It answers a read-only `dft_` token (`is_mobile = 1`;
`analytics:read, websites:read, settings:read, goals:read, payments:read, alerts:read`, no PII, one
year) plus the user's websites. The token is kept in the device keychain (`expo-secure-store`) and
sent as `Authorization: Bearer`. It shows up in the dashboard's access-token list, so a lost phone is
revoked there. Sign-out calls `DELETE /api/v1/mobile/session`, which also forgets the phone's push
device. The same login throttling as the dashboard applies. DataFast signs in with an emailed code;
DataGoat installs often have no email provider, so the app uses the password.

### Data

| Screen part        | Endpoint                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Sites              | `GET /api/v1/admin/websites`; per site `GET /analytics/overview?fields=visitors` (today) and `/analytics/realtime` |
| KPIs               | `GET /api/v1/analytics/overview` for the period and the previous period                                |
| Chart              | `GET /api/v1/analytics/timeseries?fields=visitors,revenue&interval=…`                                  |
| Live               | `GET /api/v1/analytics/realtime` every 30 s                                                            |
| Breakdowns         | `GET /api/v1/analytics/{referrers,channels,campaigns,countries,devices,pages,goals}?limit=10`          |
| Notifications      | `GET/POST /api/v1/mobile/devices`, `DELETE /api/v1/mobile/devices/:id`                                 |

Every call passes `?websiteId=` and the site's timezone, so "today" is the site's today. The API
limits a token to 60 requests a minute; an overview load is about seven requests and the live count
one every 30 s, well inside it.

### Push notifications

The app asks for permission, gets an Expo push token (`expo-notifications`, which needs the EAS
project id in `app.json` → `extra.eas.projectId`) and registers it with
`POST /api/v1/mobile/devices`. The Worker's `ecosystem.push` cron job sends new sales and goal
alerts through Expo's push service to every device of every member of the site, minus muted sites
and switched-off kinds. Tapping a notification opens that site. Delivery through Expo needs no
credentials on the DataGoat side; for production builds the app's APNs key and FCM credentials are
uploaded to Expo once (`eas credentials`). If the Expo project enables "Enhanced push security",
set the `EXPO_ACCESS_TOKEN` secret on the Worker.

### Widgets

Home-screen widgets are native code that Expo's JavaScript runtime cannot provide:

- **iOS** needs a WidgetKit extension written in Swift/SwiftUI, an App Group shared with the app,
  and a native module to write into the group's `UserDefaults` and call
  `WidgetCenter.reloadAllTimelines()`. With Expo this is added through a config plugin and a
  development build (for example the community `@bacons/apple-targets` plugin).
- **Android** needs an `AppWidgetProvider` (the community `react-native-android-widget` library can
  render one from React components) and a development build.

What the app does today: after each refresh of the sites screen it computes a
**widget snapshot** (`src/lib/widget.ts`: for up to six sites the name, visitors today, revenue today, live
count, and the update time) and keeps it in secure storage under `datagoat.widget.v1`. A native widget only has to
read that JSON (after it is mirrored into the App Group or Android shared preferences) and draw it.
Neither native extension is in this repository, and nothing here claims widgets work.

## Building and running

```sh
cd apps/mobile
npm ci
npx expo start            # Expo Go or a simulator
npm run check             # tsc + expo-doctor-free checks (see package.json)
npx expo export --platform ios --platform android   # bundles the JS, catches import errors
eas build -p ios|android  # store builds (needs an Expo account)
```

The app is not an npm workspace of the repository: it needs React 19 and React Native, while the
dashboard uses React 18, and Metro must not resolve two Reacts. Its data layer (`src/lib`) has no
React Native imports and is tested by `npm run test:ecosystem` at the repository root.
