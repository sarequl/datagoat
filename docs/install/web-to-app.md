# Web-to-app funnels

Follow one person from your landing page to your mobile app in a single dashboard.

1. Someone visits your site: the tracker gives them a visitor id (cookie).
2. They sign up on the site: you call `identify` with their `user_id`.
3. They open your app: the [React Native SDK](react-native.md) gives the install its own
   visitor id.
4. They sign in to the app: you call `identify` with the **same** `user_id`.
5. DataGoat links both visitor profiles through that `user_id`, so the visitor profile and
   journeys show the web visits and the app screens together.

## Requirements

- The website and the app use the **same website id** and `domain`.
- The same `user_id` on both sides (a stable account id, or the email).
- Call identify every time a signed-in session starts, on both sides.

## Website

```html
<script>
  window.datafast = window.datafast || function () { (window.datafast.q = window.datafast.q || []).push(arguments); };
</script>
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="https://a.example.com/js/script.js"></script>
<script>
  // after sign-up or sign-in:
  window.datafast("identify", { user_id: "user_123", name: "Ada" });
</script>
```

## App

```tsx
import { useDataGoatIdentify, useDataGoatScreen } from "@datagoat/react-native";

function Home({ user }) {
  useDataGoatScreen("HomeScreen");
  useDataGoatIdentify(user?.id, { name: user?.name }); // same id as on the website
  return null;
}
```

## A cross-platform funnel

In the dashboard's **Funnels**, steps can mix web and app:

1. Pageview `/` (landing page)
2. Pageview `/pricing`
3. Goal `signup` (website)
4. Pageview, URL contains `datafast://ios/HomeScreen` (app)
5. Goal `upgrade_click` (app)

App screens are pages starting with `datafast://<platform>/`, so `contains datafast://` filters
all app traffic.

The app keeps working offline: events are queued and delivered when the phone is back online.
