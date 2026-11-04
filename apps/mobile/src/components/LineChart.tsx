import { useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import type { TimeseriesPoint } from "../lib/api";
import { buildChart } from "../lib/chart";
import { formatCount } from "../lib/format";
import type { Interval } from "../lib/periods";
import { useTheme } from "../theme";

const HEIGHT = 160;

/** Visitors as a line with an area fill, revenue as bars behind it. */
export function LineChart({ points, interval }: { points: TimeseriesPoint[]; interval: Interval }) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width));
  const g = width > 0 ? buildChart(points, interval, width, HEIGHT) : null;
  return (
    <View onLayout={onLayout} accessibilityLabel="Visitors and revenue chart">
      <View style={styles.legend}>
        <Text style={{ color: t.visitors, fontSize: 12 }}>
          ● Visitors (max {formatCount(g?.maxVisitors ?? 0)})
        </Text>
        <Text style={{ color: t.revenue, fontSize: 12 }}>▮ Revenue</Text>
      </View>
      {g ? (
        <Svg width={g.width} height={g.height}>
          {g.bars.map((b, i) => (
            <Rect
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
              key={i}
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              fill={t.revenue}
              opacity={0.45}
              rx={2}
            />
          ))}
          {g.areaPath ? <Path d={g.areaPath} fill={t.visitors} opacity={0.15} /> : null}
          {g.linePath ? (
            <Path d={g.linePath} stroke={t.visitors} strokeWidth={2} fill="none" />
          ) : null}
        </Svg>
      ) : (
        <View style={{ height: HEIGHT }} />
      )}
      <View style={[styles.axis, { width }]}>
        {g?.labels.map((l) => (
          <Text
            key={`${l.x}-${l.text}`}
            style={[styles.label, { color: t.muted, left: Math.max(0, l.x - 20) }]}
          >
            {l.text}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: "row", gap: 14, marginBottom: 6 },
  axis: { height: 18, marginTop: 4 },
  label: { position: "absolute", fontSize: 11, width: 40, textAlign: "center" },
});
