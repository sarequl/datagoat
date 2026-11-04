/**
 * Push notifications: permission, Expo push token, Android channels, and registration with
 * POST /api/v1/mobile/devices. The Worker's ecosystem.push job sends the notifications.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { Api, MobileDevice } from "./lib/api";
import { type Preferences, registrationBody } from "./lib/notifications";
import { KEY_DEVICE } from "./session";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushResult =
  | { ok: true; device: MobileDevice }
  | { ok: false; reason: "simulator" | "denied" | "no-project" | "error"; message: string };

async function ensureChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  // The Worker addresses these channel ids (channelId "sales" / "alerts").
  await Notifications.setNotificationChannelAsync("sales", {
    name: "Sales",
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync("alerts", {
    name: "Alerts",
    importance: Notifications.AndroidImportance.HIGH,
  });
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId || Constants.easConfig?.projectId || undefined;
}

/** Ask for permission (once), get the Expo push token and save the device with `prefs`. */
export async function registerForPush(api: Api, prefs: Preferences): Promise<PushResult> {
  if (!Device.isDevice) {
    return { ok: false, reason: "simulator", message: "Push notifications need a real device." };
  }
  await ensureChannels();
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted && current.canAskAgain)
    granted = (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) {
    return {
      ok: false,
      reason: "denied",
      message: "Notifications are turned off in system settings.",
    };
  }
  const id = projectId();
  if (!id) {
    return {
      ok: false,
      reason: "no-project",
      message: "This build has no EAS project id (app.json → extra.eas.projectId).",
    };
  }
  try {
    const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const device = await api.registerDevice(
      registrationBody(
        token.data,
        Platform.OS === "ios" ? "ios" : "android",
        Device.deviceName ?? Device.modelName ?? null,
        prefs,
      ),
    );
    await SecureStore.setItemAsync(KEY_DEVICE, device.id);
    return { ok: true, device };
  } catch (err) {
    return { ok: false, reason: "error", message: (err as Error).message };
  }
}

/** This phone's registered device, if any. */
export async function currentDevice(api: Api): Promise<MobileDevice | null> {
  const id = await SecureStore.getItemAsync(KEY_DEVICE);
  if (!id) return null;
  const devices = await api.devices();
  return devices.find((d) => d.id === id) ?? null;
}

export async function unregisterPush(api: Api): Promise<void> {
  const id = await SecureStore.getItemAsync(KEY_DEVICE);
  if (id) await api.deleteDevice(id).catch(() => undefined);
  await SecureStore.deleteItemAsync(KEY_DEVICE);
}
