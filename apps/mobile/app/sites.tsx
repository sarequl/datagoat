import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, Stack, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Card, ErrorText, LiveBadge, Loading } from "../src/components/ui";
import type { WebsiteSummary } from "../src/lib/api";
import { formatCount, formatMoney } from "../src/lib/format";
import { periodFor } from "../src/lib/periods";
import { buildWidgetSnapshot, WIDGET_STORAGE_KEY } from "../src/lib/widget";
import { useApi, useSession } from "../src/session";
import { useTheme } from "../src/theme";

export default function Sites() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const { handleAuthError } = useSession();
  const sites = useQuery({ queryKey: ["websites"], queryFn: () => api.websites() });
  const list = sites.data ?? [];

  const today = useQueries({
    queries: list.map((w) => ({
      queryKey: ["overview", w._id, "today"],
      queryFn: () => api.overview(w._id, periodFor("today", w.timezone).range),
      refetchInterval: 60_000,
    })),
  });
  const live = useQueries({
    queries: list.map((w) => ({
      queryKey: ["realtime", w._id],
      queryFn: () => api.realtime(w._id),
      refetchInterval: 30_000,
    })),
  });

  useEffect(() => {
    if (sites.error && handleAuthError(sites.error)) router.replace("/sign-in");
  }, [sites.error, handleAuthError, router]);

  // Widget snapshot (read by a native widget extension, see docs/architecture/mobile.md).
  const ready = list.length > 0 && today.every((q) => q.data);
  const snapshotKey = ready
    ? today.map((q) => `${q.data?.visitors}:${q.data?.revenue}`).join("|")
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the numbers that change
  useEffect(() => {
    if (!ready) return;
    const snapshot = buildWidgetSnapshot(
      list.map((w, i) => ({
        id: w._id,
        name: w.name || w.domain,
        visitorsToday: today[i]?.data?.visitors ?? 0,
        revenueToday: today[i]?.data?.revenue ?? 0,
        currency: today[i]?.data?.currency ?? w.currency,
        live: live[i]?.data ?? 0,
      })),
    );
    void SecureStore.setItemAsync(WIDGET_STORAGE_KEY, JSON.stringify(snapshot)).catch(
      () => undefined,
    );
  }, [snapshotKey]);

  if (sites.isPending) return <Loading />;
  if (sites.error)
    return <ErrorText message={(sites.error as Error).message} onRetry={() => sites.refetch()} />;

  const refreshing = sites.isRefetching;
  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" asChild>
              <Pressable accessibilityRole="button" hitSlop={8}>
                <Text style={{ color: t.primary, fontWeight: "600" }}>Settings</Text>
              </Pressable>
            </Link>
          ),
        }}
      />
      <FlatList
        data={list}
        keyExtractor={(w: WebsiteSummary) => w._id}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void sites.refetch();
              for (const q of [...today, ...live]) void q.refetch();
            }}
          />
        }
        ListEmptyComponent={
          <Text style={{ color: t.muted, textAlign: "center", marginTop: 40 }}>
            No websites yet. Add one in the DataGoat dashboard.
          </Text>
        }
        renderItem={({ item, index }) => {
          const o = today[index]?.data;
          return (
            <Pressable accessibilityRole="button" onPress={() => router.push(`/site/${item._id}`)}>
              <Card>
                <View style={styles.head}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>
                      {item.name || item.domain}
                    </Text>
                    <Text style={{ color: t.muted }} numberOfLines={1}>
                      {item.domain}
                    </Text>
                  </View>
                  <LiveBadge count={live[index]?.data} />
                </View>
                <View style={styles.stats}>
                  <View>
                    <Text style={{ color: t.muted, fontSize: 12 }}>Visitors today</Text>
                    <Text style={[styles.stat, { color: t.visitors }]}>
                      {o ? formatCount(o.visitors) : "–"}
                    </Text>
                  </View>
                  <View>
                    <Text style={{ color: t.muted, fontSize: 12 }}>Revenue today</Text>
                    <Text style={[styles.stat, { color: t.revenue }]}>
                      {o ? formatMoney(o.revenue, o.currency || item.currency, true) : "–"}
                    </Text>
                  </View>
                </View>
              </Card>
            </Pressable>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 17, fontWeight: "700" },
  stats: { flexDirection: "row", gap: 32, marginTop: 12 },
  stat: { fontSize: 22, fontWeight: "700" },
});
