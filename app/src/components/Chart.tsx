import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";

/** Points at unix seconds. */
export type Series = { name: string; color: string; points: { time: number; value: number }[]; dots?: boolean; precision?: number };

/** Time-ordered, one point per second (the last one wins): what lightweight-charts accepts. */
function clean(points: Series["points"]) {
  const bySec = new Map<number, number>();
  for (const p of points) if (Number.isFinite(p.value)) bySec.set(Math.floor(p.time), p.value);
  return [...bySec].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

/** A TradingView lightweight-charts line chart (its attribution logo stays on, as its license asks). */
export function LineChart({ series, height = 260, empty }: { series: Series[]; height?: number; empty?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<{ api: IChartApi; lines: ISeriesApi<"Line">[] } | null>(null);
  const [ready, setReady] = useState(false);
  const key = series.map((s) => s.name).join("|");

  useEffect(() => {
    let disposed = false;
    import("lightweight-charts").then(({ createChart, LineSeries, ColorType }) => {
      if (disposed || !box.current) return;
      const api = createChart(box.current, {
        height,
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8e8e8e", fontFamily: "Inter, system-ui, sans-serif" },
        grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.06)" } },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
        timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      });
      const lines = series.map((s) =>
        api.addSeries(LineSeries, {
          color: s.color,
          lineWidth: 2,
          lineVisible: !s.dots,
          pointMarkersVisible: !!s.dots,
          pointMarkersRadius: 3,
          title: s.name,
          priceFormat: { type: "price", precision: s.precision ?? 4, minMove: 1 / 10 ** (s.precision ?? 4) },
        }),
      );
      chart.current = { api, lines };
      setReady(true);
    });
    return () => {
      disposed = true;
      chart.current?.api.remove();
      chart.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, height]);

  useEffect(() => {
    if (!ready || !chart.current) return;
    series.forEach((s, i) => chart.current!.lines[i]?.setData(clean(s.points)));
    chart.current.api.timeScale().fitContent();
  }, [ready, series]);

  const none = series.every((s) => !s.points.length);
  return (
    <div className="chart" style={{ height }}>
      <div ref={box} className="chart-box" />
      {none && empty && <p className="chart-empty">{empty}</p>}
    </div>
  );
}
