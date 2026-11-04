import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { Card } from "../src/components/ui";
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  preferencesOf,
  toggleMuted,
} from "../src/lib/notifications";
import { currentDevice, registerForPush, unregisterPush } from "../src/push";
import { useApi, useSession } from "../src/session";
import { useTheme } from "../src/theme";

export default function Settings() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { state, signOut } = useSession();
  const sites = useQuery({ queryKey: ["websites"], queryFn: () => api.websites() });
  const device = useQuery({ queryKey: ["device"], queryFn: () => currentDevice(api) });
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = !!device.data;

  useEffect(() => {
    if (device.data) setPrefs(preferencesOf(device.data));
  }, [device.data]);

  async function save(next: Preferences) {
    setPrefs(next);
    setBusy(true);
    const result = await registerForPush(api, next);
    setBusy(false);
    setMessage(result.ok ? null : result.message);
    await queryClient.invalidateQueries({ queryKey: ["device"] });
  }

  async function turnOff() {
    setBusy(true);
    await unregisterPush(api);
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: ["device"] });
  }

  function confirmSignOut() {
    Alert.alert("Sign out?", "This phone stops receiving notifications.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await signOut();
          queryClient.clear();
          router.replace("/sign-in");
        },
      },
    ]);
  }

  const row = [styles.row, { borderBottomColor: t.line }];
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Card>
        <Text style={[styles.h, { color: t.text }]}>Notifications</Text>
        <View style={row}>
          <Text style={{ color: t.text, flex: 1 }}>Push notifications on this phone</Text>
          <Switch
            value={enabled}
            disabled={busy}
            onValueChange={(on) => void (on ? save(prefs) : turnOff())}
          />
        </View>
        {enabled ? (
          <>
            <View style={row}>
              <Text style={{ color: t.text, flex: 1 }}>New sales</Text>
              <Switch
                value={prefs.notifySales}
                disabled={busy}
                onValueChange={(v) => void save({ ...prefs, notifySales: v })}
              />
            </View>
            <View style={row}>
              <Text style={{ color: t.text, flex: 1 }}>Goal alerts</Text>
              <Switch
                value={prefs.notifyAlerts}
                disabled={busy}
                onValueChange={(v) => void save({ ...prefs, notifyAlerts: v })}
              />
            </View>
            <Text style={{ color: t.muted, marginTop: 12, marginBottom: 4 }}>Websites</Text>
            {(sites.data ?? []).map((w) => (
              <View key={w._id} style={row}>
                <Text style={{ color: t.text, flex: 1 }} numberOfLines={1}>
                  {w.name || w.domain}
                </Text>
                <Switch
                  value={!prefs.mutedSiteIds.includes(w._id)}
                  disabled={busy}
                  onValueChange={() => void save(toggleMuted(prefs, w._id))}
                />
              </View>
            ))}
          </>
        ) : null}
        {message ? <Text style={{ color: t.bad, marginTop: 8 }}>{message}</Text> : null}
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 10 }}>
          Goal alerts are the alerts set up in the dashboard under Alerts.
        </Text>
      </Card>
      <Card>
        <Text style={[styles.h, { color: t.text }]}>Account</Text>
        {state.status === "signedIn" ? (
          <Text style={{ color: t.muted, marginBottom: 12 }}>
            {state.user?.email ?? ""} on {state.instanceUrl}
          </Text>
        ) : null}
        <Pressable accessibilityRole="button" onPress={confirmSignOut} style={styles.danger}>
          <Text style={{ color: t.bad, fontWeight: "700" }}>Sign out</Text>
        </Pressable>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  h: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  danger: { paddingVertical: 10 },
});
