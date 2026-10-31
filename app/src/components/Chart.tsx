import { useEffect, useRef, useState } from "react";
import type { DeepPartial, IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, Time, TimeChartOptions, UTCTimestamp } from "lightweight-charts";
import type { Candle, Side } from "../lib/api";

/** Points at unix seconds. */
export type Series = { name: string; color: string; points: { time: number; value: number }[]; dots?: boolean; precision?: number };

type Lib = typeof import("lightweight-charts");


function options(lib: Lib, height: number): DeepPartial<TimeChartOptions> {
  return {
    height,
    autoSize: true,
    layout: { background: { type: lib.ColorType.Solid, color: "transparent" }, textColor: "#8e8e8e", fontFamily: "Inter, system-ui, sans-serif", attributionLogo: false },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.06)" } },
    rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
    timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
  };
}

/** Time-ordered, one point per second (the last one wins): what lightweight-charts accepts. */
function clean(points: Series["points"]) {
  const bySec = new Map<number, number>();
  for (const p of points) if (Number.isFinite(p.value)) bySec.set(Math.floor(p.time), p.value);
  return [...bySec].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

/** A TradingView lightweight-charts line chart. */
export function LineChart({ series, height = 260, empty }: { series: Series[]; height?: number; empty?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<{ api: IChartApi; lines: ISeriesApi<"Line">[] } | null>(null);
  const [ready, setReady] = useState(false);
  const key = series.map((s) => s.name).join("|");

  useEffect(() => {
    let disposed = false;
    import("lightweight-charts").then((lib) => {
      if (disposed || !box.current) return;
      const api = lib.createChart(box.current, options(lib, height));
      const lines = series.map((s) =>
        api.addSeries(lib.LineSeries, {
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

/** A fill to mark on the candles: unix seconds and the client's side. */
export type Fill = { time: number; side: Side };

/**
 * Candlesticks with fills as markers (green arrow under the bar for a buy, red over it for a sell) and a
 * dashed price line. `step` is the candle length in seconds; `fitKey` changing re-frames the last bars.
 */
export function CandleChart({ candles, step, fills, line, fitKey, empty }: { candles: Candle[]; step: number; fills: Fill[]; line?: { price: number; title: string }; fitKey: string; empty?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<{ api: IChartApi; bars: ISeriesApi<"Candlestick">; marks: ISeriesMarkersPluginApi<Time>; line: IPriceLine | null } | null>(null);
  const framed = useRef("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    import("lightweight-charts").then((lib) => {
      if (disposed || !box.current) return;
      const api = lib.createChart(box.current, options(lib, 420));
      const bars = api.addSeries(lib.CandlestickSeries, {
        upColor: "#8ef0b3",
        downColor: "#ff8f8f",
        borderVisible: false,
        wickUpColor: "#8ef0b3",
        wickDownColor: "#ff8f8f",
        priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      });
      chart.current = { api, bars, marks: lib.createSeriesMarkers(bars, []), line: null };
      setReady(true);
    });
    return () => {
      disposed = true;
      chart.current?.api.remove();
      chart.current = null;
      framed.current = "";
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    c.bars.setData(candles.map((k) => ({ ...k, time: k.time as UTCTimestamp })));
    if (candles.length && framed.current !== fitKey) {
      framed.current = fitKey;
      c.api.timeScale().setVisibleLogicalRange({ from: candles.length - 120, to: candles.length + 2 });
    }
  }, [ready, candles, fitKey]);

  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    // A marker sits on a bar: each fill goes on the candle it happened in, none outside the candles shown.
    const times = candles.map((k) => k.time);
    const marks = fills
      .filter((f) => times.length && f.time >= times[0] && f.time < times[times.length - 1] + step)
      .map((f) => {
        let i = times.length - 1;
        while (times[i] > f.time) i--;
        return { time: times[i] as UTCTimestamp, side: f.side };
      })
      .sort((a, b) => a.time - b.time)
      .map(({ time, side }) =>
        side === "Buy"
          ? { time, position: "belowBar" as const, shape: "arrowUp" as const, color: "#8ef0b3" }
          : { time, position: "aboveBar" as const, shape: "arrowDown" as const, color: "#ff8f8f" },
      );
    c.marks.setMarkers(marks);
  }, [ready, candles, fills, step]);

  useEffect(() => {
    const c = chart.current;
    if (!ready || !c || !line) return;
    if (c.line) c.line.applyOptions({ price: line.price, title: line.title });
    else c.line = c.bars.createPriceLine({ price: line.price, title: line.title, color: "#d7bcff", lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
  }, [ready, line?.price, line?.title]);

  return (
    <div className="chart">
      <div ref={box} className="chart-box" />
      {!candles.length && empty && <p className="chart-empty">{empty}</p>}
    </div>
  );
}
