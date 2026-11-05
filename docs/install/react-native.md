# React Native and Expo: `@datagoat/react-native`

Screens, goals and identify from your app, with an offline queue. Events go to the same
collector and website as your site, so you see web and app in one dashboard. Source:
[`packages/react-native`](../../packages/react-native).

## 1. Install

```bash
npx expo install @datagoat/react-native @react-native-async-storage/async-storage @react-native-community/netinfo
# bare React Native: npm install ... then cd ios && pod install
```

AsyncStorage keeps the visitor id and the event queue across restarts. NetInfo is optional: with
it, sending pauses while offline and resumes on reconnect; without it, failed sends are retried on
the next flush.

## 2. Configure your website

The app sends events with `domain` set to your website's domain. Screen views arrive as pages
named `datafast://ios/<Screen>` or `datafast://android/<Screen>` (DataFast's format), so they are
easy to filter: page filter `contains datafast://`.

## 3. Wrap your app

```tsx
// app/_layout.tsx (Expo Router) or App.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { DataGoatProvider } from "@datagoat/react-native";

export default function RootLayout() {
  return (
    <DataGoatProvider
      config={{
        websiteId: process.env.EXPO_PUBLIC_DATAGOAT_WEBSITE_ID!, // same id as your website
        domain: "example.com",
        host: "https://a.example.com",                          // your collector
        debug: __DEV__,
      }}
      storage={AsyncStorage}
      netInfo={NetInfo}
    >
      <Stack />
    </DataGoatProvider>
  );
}
```

## 4. Track screens, goals and users

```tsx
import { useDataGoatIdentify, useDataGoatScreen, useDataGoatTrack } from "@datagoat/react-native";

export default function HomeScreen() {
  useDataGoatScreen("HomeScreen");
  const track = useDataGoatTrack();
  return <Button title="Upgrade" onPress={() => track("upgrade_click", { source: "home" })} />;
}

function Session({ user }) {
  useDataGoatIdentify(user?.email, { name: user?.name }); // call while signed in, on every start
  return null;
}
```

Expo Router: track every route in the root layout instead of per screen:

```tsx
import { usePathname } from "expo-router";
function ScreenTracker() {
  useDataGoatScreen(usePathname());
  return null;
}
```

React Navigation: `trackNavigation(client, navigationRef)` in the container's `onReady`
(`client` from `useDataGoat()`).

| Client method                 | Does                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| `trackScreen(name)`           | pageview at `datafast://<platform>/<name>`; the same screen reported twice in a row within 60 s counts once |
| `track(goal, params?)`        | custom goal, same rules as the web API (lowercase `a-z 0-9 _ - :`, up to 10 params) |
| `identify(userId, profile?)`  | links this app visitor to your user (see [web-to-app.md](web-to-app.md)) |
| `flush()`                     | send now (also every 5 s, at 10 queued events, and when the app goes to the background) |
| `reset()`                     | forget the visitor and session (sign-out)                                |
| `setEnabled(false)`           | hold events (for example until consent); queued events wait              |
| `getVisitorId()`              | this install's visitor id                                                |

Config: `flushInterval` (ms, default 5000), `flushAt` (default 10), `maxStoredEvents` (default
500, oldest dropped first), `screenScheme` (default `datafast`), `apiUrl`, `disabled`, `debug`.

## How it behaves

- Visitor: a UUID v4 created on first launch and kept in storage. Session: `s` + UUID, renewed
  after 30 minutes without events; the session number counts up like the web cookie.
- Requests: `POST <host>/api/events`, one event per request, `text/plain` JSON with the same
  fields as the web tracker. The `User-Agent` names the OS and device model so the collector
  reports device, OS and version correctly.
- Offline: events are queued in storage and sent in order later. Network errors, `429` and `5xx`
  keep the event; other `4xx` answers drop it (it would never be accepted).
- Timing: the collector records events when they arrive. Events sent after a long offline period
  are counted at delivery time.

## Without React

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createNativeClient } from "@datagoat/react-native";

const { client, dispose } = createNativeClient(
  { websiteId: "dgid_XXXXXXXXXXXXXXXX", domain: "example.com", host: "https://a.example.com" },
  { storage: AsyncStorage },
);
await client.trackScreen("Onboarding");
```
