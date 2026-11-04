# The DataGoat mobile app

Your analytics on iOS and Android: websites, today's numbers, KPIs with comparisons, the chart,
live visitors, top sources and other breakdowns, and push notifications for sales and goal
alerts. The app is in [`apps/mobile`](../../apps/mobile); its design is in
[architecture/mobile.md](../architecture/mobile.md).

## Getting the app

DataGoat is self-hosted, so there is no shared store listing to download: build the app from this
repository (Expo, React Native) with your own Apple and Google developer accounts, or run it on
your phone with Expo Go during development:

```sh
cd apps/mobile
npm ci
npx expo start          # scan the QR code with Expo Go
eas build -p ios        # or -p android, for an installable build (needs an Expo account)
```

Push notifications need an installable build (`eas build`) with your EAS project id in
`app.json` → `expo.extra.eas.projectId` and push credentials uploaded with `eas credentials`;
Expo Go does not receive push notifications for your own project.

## Signing in

Open the app and enter:

- your DataGoat address, e.g. `analytics.example.com` (https);
- your dashboard email and password.

The app receives a read-only token (it can read analytics but never change settings) that is kept
in the phone's keychain. It appears in the dashboard's list of access tokens (your account page) as
"Mobile app (<device name>)": delete it there to sign a lost phone out. Signing out in the app
deletes it too.

## Notifications

In the app's **Settings**, turn on push notifications, then choose **New sales** and/or
**Goal alerts** and the websites you want them for. Your DataGoat sends them within about a minute
of the sale (or of the alert firing) through Expo's push service. Goal alerts are the alerts
configured in the dashboard under **Alerts**. Nothing needs configuring on the server unless your
Expo project requires an access token, in which case set the `EXPO_ACCESS_TOKEN` secret on the
Worker (`npx wrangler secret put EXPO_ACCESS_TOKEN`).

## Widgets

DataFast's iOS app has home-screen widgets. DataGoat's app prepares the widget data (today's
visitors, revenue and live count for up to six sites) but the native widget extensions for iOS
(WidgetKit) and Android are not built yet; see
[architecture/mobile.md](../architecture/mobile.md#widgets).
