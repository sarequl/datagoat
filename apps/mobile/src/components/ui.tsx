import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { Breakdown, BreakdownRow } from "../lib/api";
import { formatCount, formatMoney } from "../lib/format";
import type { Kpi } from "../lib/kpis";
import { PERIODS, type PeriodKey } from "../lib/periods";
import { useTheme } from "../theme";

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>
      {children}
    </View>
  );
}

export function Loading() {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={t.primary} />
    </View>
  );
}

export function ErrorText({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <Text style={{ color: t.bad, textAlign: "center" }}>{message}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}>
          <Text style={{ color: t.primary, fontWeight: "600" }}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function LiveBadge({ count }: { count: number | undefined }) {
  const t = useTheme();
  return (
    <View style={[styles.live, { backgroundColor: t.surface2 }]}>
      <View style={[styles.dot, { backgroundColor: t.good }]} />
      <Text style={{ color: t.text, fontWeight: "600" }}>
        {count === undefined ? "–" : formatCount(count)} online
      </Text>
    </View>
  );
}

export function PeriodPicker({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (k: PeriodKey) => void;
}) {
  const t = useTheme();
  return (
    <View style={styles.segments}>
      {PERIODS.map((p) => {
        const active = p.key === value;
        return (
          <Pressable
            key={p.key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(p.key)}
            style={[styles.segment, { backgroundColor: active ? t.primary : t.surface2 }]}
          >
            <Text
              style={{ color: active ? t.primaryText : t.text, fontSize: 13, fontWeight: "600" }}
            >
              {p.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function KpiGrid({ kpis }: { kpis: Kpi[] }) {
  const t = useTheme();
  return (
    <View style={styles.grid}>
      {kpis.map((k) => {
        const color = k.delta?.good === true ? t.good : k.delta?.good === false ? t.bad : t.muted;
        return (
          <View
            key={k.key}
            style={[styles.kpi, { backgroundColor: t.surface, borderColor: t.line }]}
          >
            <Text style={{ color: t.muted, fontSize: 12 }}>{k.label}</Text>
            <Text
              style={{
                color: k.key === "revenue" ? t.revenue : k.key === "visitors" ? t.visitors : t.text,
                fontSize: 22,
                fontWeight: "700",
              }}
            >
              {k.value}
            </Text>
            {k.delta ? <Text style={{ color, fontSize: 12 }}>{k.delta.label}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

export const BREAKDOWN_TABS: Array<{ key: Breakdown; label: string }> = [
  { key: "referrers", label: "Referrers" },
  { key: "channels", label: "Channels" },
  { key: "campaigns", label: "Campaigns" },
  { key: "pages", label: "Pages" },
  { key: "countries", label: "Countries" },
  { key: "devices", label: "Devices" },
  { key: "goals", label: "Goals" },
];

export function BreakdownTabs({
  value,
  onChange,
}: {
  value: Breakdown;
  onChange: (b: Breakdown) => void;
}) {
  const t = useTheme();
  return (
    <View style={styles.tabs}>
      {BREAKDOWN_TABS.map((tab) => {
        const active = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tab.key)}
            style={[styles.tab, { borderBottomColor: active ? t.primary : "transparent" }]}
          >
            <Text style={{ color: active ? t.text : t.muted, fontWeight: active ? "700" : "500" }}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function BreakdownList({ rows, currency }: { rows: BreakdownRow[]; currency: string }) {
  const t = useTheme();
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  if (rows.length === 0)
    return <Text style={{ color: t.muted, padding: 12 }}>No data for this period.</Text>;
  return (
    <View>
      {rows.map((r) => (
        <View key={r.label} style={styles.row}>
          <View
            style={[
              styles.bar,
              { backgroundColor: t.surface2, width: `${Math.max(2, (r.visitors / max) * 100)}%` },
            ]}
          />
          <Text numberOfLines={1} style={[styles.rowLabel, { color: t.text }]}>
            {r.label}
          </Text>
          <Text style={{ color: t.visitors, width: 64, textAlign: "right" }}>
            {formatCount(r.visitors)}
          </Text>
          <Text style={{ color: t.revenue, width: 84, textAlign: "right" }}>
            {r.revenue === null ? "" : formatMoney(r.revenue, currency, true)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, marginBottom: 12 },
  center: { padding: 24, alignItems: "center", justifyContent: "center" },
  retry: { marginTop: 12, padding: 8 },
  live: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  segments: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  segment: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  kpi: {
    width: "48.5%",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    gap: 2,
  },
  tabs: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  tab: { paddingVertical: 8, paddingHorizontal: 8, borderBottomWidth: 2 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 6 },
  bar: { position: "absolute", left: 0, top: 2, bottom: 2, borderRadius: 6 },
  rowLabel: { flex: 1, marginRight: 8 },
});
