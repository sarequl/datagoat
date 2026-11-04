/** Push notification payloads (sent by the Worker's ecosystem.push job) and device preferences. */
import type { MobileDevice, RegisterDevice } from "./api";

export interface PushData {
  type: "sale" | "alert";
  websiteId: string;
}

/** The route a tapped notification opens, or null for payloads the app does not know. */
export function routeForNotification(data: unknown): string | null {
  const d = data as Partial<PushData> | null | undefined;
  if (!d || (d.type !== "sale" && d.type !== "alert")) return null;
  if (typeof d.websiteId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(d.websiteId)) return null;
  return `/site/${d.websiteId}`;
}

export interface Preferences {
  notifySales: boolean;
  notifyAlerts: boolean;
  mutedSiteIds: string[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  notifySales: true,
  notifyAlerts: true,
  mutedSiteIds: [],
};

export function preferencesOf(device: MobileDevice | null | undefined): Preferences {
  if (!device) return DEFAULT_PREFERENCES;
  return {
    notifySales: device.notifySales,
    notifyAlerts: device.notifyAlerts,
    mutedSiteIds: device.mutedSiteIds,
  };
}

export function toggleMuted(prefs: Preferences, siteId: string): Preferences {
  const muted = prefs.mutedSiteIds.includes(siteId)
    ? prefs.mutedSiteIds.filter((id) => id !== siteId)
    : [...prefs.mutedSiteIds, siteId];
  return { ...prefs, mutedSiteIds: muted };
}

export function registrationBody(
  pushToken: string,
  platform: "ios" | "android",
  name: string | null,
  prefs: Preferences,
): RegisterDevice {
  return { pushToken, platform, name, ...prefs };
}
