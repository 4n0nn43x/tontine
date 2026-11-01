import { useEffect, useRef, useState, type ReactNode } from "react";

export type SceneApi = {
  act(step: Record<string, unknown>): void;
  resize(): void;
  setCalmRect(rect: { left: number; right: number; top: number; bottom: number }): void;
  setHorizon(fraction: number): void;
  setExplore(on: boolean): void;
  setPaused(paused: boolean): void;
  dispose(): void;
  /** Live city only (scene/city.js). */
  setFirms(list: { id: number | string; name: string; nav: number; fills: number; status: string; takeovers: number }[], market?: { price?: number }): void;
  pick(clientX: number, clientY: number): { id: number | string; name: string } | null;
  setParallax(v: number): void;
  /** Live city only: the market regime as weather. */
  setWeather(level: "calm" | "alert" | "storm"): void;
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = () => window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;

type Props = {
  mode: "replay" | "live";
  firmNames?: string[] | null;
  className?: string;
  onReady?: (api: SceneApi) => void;
  onLedger?: (e: { text: string; kind: string }) => void;
  onPhase?: (i: number) => void;
  fallback?: ReactNode;
};

/** The pixel-art city where every building is a firm, sized to its container. */
export function SceneView({ mode, firmNames, className = "", onReady, onLedger, onPhase, fallback = null }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const handlers = useRef({ onReady, onLedger, onPhase });
  handlers.current = { onReady, onLedger, onPhase };
  const namesKey = firmNames ? firmNames.join("|") : "";

  useEffect(() => {
    if (failed || !canvas.current || !tags.current) return;
    if (mode === "live" && !firmNames) return; // wait for the firm list
    let api: SceneApi | null = null;
    let ro: ResizeObserver | null = null;
    let disposed = false;
    import("../scene/city.js")
      .then(({ startScene }) => {
        if (disposed || !canvas.current) return;
        api = startScene({
          canvas: canvas.current,
          tagsLayer: tags.current,
          onEvent: (e: { text: string; kind: string }) => handlers.current.onLedger?.(e),
          onPhase: (i: number) => handlers.current.onPhase?.(i),
          reducedMotion: reducedMotion(),
          isMobile: isMobile(),
          mode,
          firmNames: (firmNames ?? null) as any,
          debugQuery: mode === "replay",
        }) as SceneApi;
        ro = new ResizeObserver(() => api?.resize());
        ro.observe(canvas.current);
        canvas.current.classList.add("ready");
        handlers.current.onReady?.(api);
      })
      .catch((e) => {
        console.warn("scene unavailable:", e);
        setFailed(true);
      });
    return () => {
      disposed = true;
      ro?.disconnect();
      api?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, mode, namesKey]);

  if (failed) return <div className={`scene ${className}`}>{fallback}</div>;
  return (
    <div className={`scene ${className}`} aria-hidden="true">
      <canvas ref={canvas} className="scene-canvas" />
      <div ref={tags} className="tags" />
    </div>
  );
}
