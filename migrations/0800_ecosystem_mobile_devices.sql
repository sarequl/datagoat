-- W8 ecosystem: push notification devices of the mobile companion app.
--
-- One row per device push token (Expo push token). A device belongs to the user who signed in on
-- it and to the mobile dft_ token minted for that sign-in (api_keys.id): revoking the token in the
-- dashboard stops pushes to the device. Not site-scoped: per-site preferences live in
-- muted_site_ids. Never written on an ingest path.
CREATE TABLE mobile_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,                     -- api_keys.id of the app's mobile dft_ token
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  push_token TEXT NOT NULL UNIQUE,            -- ExponentPushToken[...]
  name TEXT,                                  -- device name shown in lists
  notify_sales INTEGER NOT NULL DEFAULT 1,
  notify_alerts INTEGER NOT NULL DEFAULT 1,
  muted_site_ids TEXT NOT NULL DEFAULT '[]',  -- JSON string[] of sites.id with pushes off
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mobile_devices_user ON mobile_devices (user_id);
