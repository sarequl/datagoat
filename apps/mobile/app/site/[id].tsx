import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { LineChart } from "../../src/components/LineChart";
import {
  BreakdownList,
  BreakdownTabs,
  Card,
  ErrorText,
  KpiGrid,
  LiveBadge,
  Loading,
  PeriodPicker,
} from "../../src/components/ui";
import type { Breakdown } from "../../src/lib/api";
import { buildKpis } from "../../src/lib/kpis";
import { type PeriodKey, periodFor } from "../../src/lib/periods";
import { useApi } from "../../src/session";
import { useTheme } from "../../src/theme";

export default function SiteOverview() {
  const t = useTheme();
  const api = useApi();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [periodKey, setPeriodKey] = useState<PeriodKey>("today");
  const [tab, setTab] = useState<Breakdown>("referrers");

  const sites = useQuery({ queryKey: ["websites"], queryFn: () => api.websites() });
  const site = sites.data?.find((w) => w._id === id || w.trackingId === id);
  const timezone = site?.timezone ?? "UTC";
  const period = useMemo(() => periodFor(periodKey, timezone), [periodKey, timezone]);
  const enabled = !!site;

  const overview = useQuery({
    queryKey: ["overview", id, periodKey, period.range.startAt],
    queryFn: () => api.overview(id, period.range),
    enabled,
  });
  const previous = useQuery({
    queryKey: ["overview", id, `${periodKey}:previous`, period.previous.startAt],
    queryFn: () => api.overview(id, period.previous),
    enabled,
  });
  const series = useQuery({
    queryKey: ["timeseries", id, periodKey, period.range.startAt],
    queryFn: () => api.timeseries(id, period.range, period.interval),
    enabled,
  });
  const live = useQuery({
    queryKey: ["realtime", id],
    queryFn: () => api.realtime(id),
    refetchInterval: 30_000,
    enabled,
  });
  const breakdown = useQuery({
    queryKey: ["breakdown", id, tab, periodKey, period.range.startAt],
    queryFn: () => api.breakdown(id, tab, period.range),
    enabled,
  });

  if (sites.isPending) return <Loading />;
  if (!site) return <ErrorText message="Website not found." onRetry={() => sites.refetch()} />;

  const refreshing = overview.isRefetching || series.isRefetching;
  const currency = overview.data?.currency || site.currency;
  return (
    <>
      <Stack.Screen options={{ title: site.name || site.domain }} />
      <ScrollView
        contentContainerStyle={{ padding: 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              for (const q of [overview, previous, series, live, breakdown]) void q.refetch();
            }}
          />
        }
      >
        <View style={styles.top}>
          <Text style={{ color: t.muted, flex: 1 }} numberOfLines={1}>
            {site.domain}
          </Text>
          <LiveBadge count={live.data} />
        </View>
        <PeriodPicker value={periodKey} onChange={setPeriodKey} />
        {overview.error ? (
          <ErrorText
            message={(overview.error as Error).message}
            onRetry={() => overview.refetch()}
          />
        ) : overview.data ? (
          <KpiGrid kpis={buildKpis(overview.data, previous.data ?? null)} />
        ) : (
          <Loading />
        )}
        <Card>
          {series.data ? (
            <LineChart points={series.data} interval={period.interval} />
          ) : (
            <Loading />
          )}
        </Card>
        <Card>
          <BreakdownTabs value={tab} onChange={setTab} />
          {breakdown.error ? (
            <ErrorText
              message={(breakdown.error as Error).message}
              onRetry={() => breakdown.refetch()}
            />
          ) : breakdown.data ? (
            <BreakdownList rows={breakdown.data} currency={currency} />
          ) : (
            <Loading />
          )}
        </Card>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", marginBottom: 12, gap: 8 },
});
