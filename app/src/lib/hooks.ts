import { useEffect, useMemo, useRef, useState } from "react";
import { getConfig, getEvents, getState, getStats, subscribeEvents, type AppState, type ChainEvent, type Config, type Stats } from "./api";
import { balances, loadWallet, onWallet, type Balances, type Wallet } from "./near";

/** A value shared by every component that subscribes to it, refreshed on an interval while in use. */
function sharedPoll<T>(fetcher: () => Promise<T>, ms: number) {
  let value: T | null = null;
  let error: string | null = null;
  let timer = 0;
  const subs = new Set<() => void>();
  const tick = async () => {
    try {
      value = await fetcher();
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
    subs.forEach((f) => f());
  };
  return function useShared(): { data: T | null; error: string | null; refresh: () => Promise<void> } {
    const [, force] = useState(0);
    useEffect(() => {
      const f = () => force((n) => n + 1);
      subs.add(f);
      if (subs.size === 1) {
        void tick();
        timer = window.setInterval(tick, ms);
      }
      return () => {
        subs.delete(f);
        if (subs.size === 0) clearInterval(timer);
      };
    }, []);
    return { data: value, error, refresh: tick };
  };
}

export const useAppState = sharedPoll<AppState>(getState, 2000);
export const useStats = sharedPoll<Stats>(getStats, 4000);

export function useConfig(): Config | null {
  const [c, setC] = useState<Config | null>(null);
  useEffect(() => {
    getConfig().then(setC, () => setC(null));
  }, []);
  return c;
}

/** Recent chain events plus the live stream, newest last. */
export function useEvents(limit = 80, onLive?: (e: ChainEvent) => void): ChainEvent[] {
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const live = useRef(onLive);
  live.current = onLive;
  useEffect(() => {
    let alive = true;
    const seen = new Set<number>();
    getEvents(limit)
      .then((list) => {
        if (!alive) return;
        list.forEach((e) => seen.add(e.id));
        setEvents((cur) => [...list, ...cur.filter((e) => !seen.has(e.id))].slice(-limit));
      })
      .catch(() => {});
    const off = subscribeEvents((e) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      setEvents((cur) => [...cur, e].slice(-limit));
      live.current?.(e);
    });
    return () => {
      alive = false;
      off();
    };
  }, [limit]);
  return events;
}

export function useWallet(): Wallet | null {
  const [w, setW] = useState<Wallet | null>(loadWallet);
  useEffect(() => {
    const off = onWallet(setW);
    return () => {
      off();
    };
  }, []);
  return w;
}

export function useBalances(accountId: string | undefined, ms = 4000): Balances | null {
  const [b, setB] = useState<Balances | null>(null);
  useEffect(() => {
    if (!accountId) return setB(null);
    let alive = true;
    const load = () => balances(accountId).then((x) => alive && setB(x), () => {});
    void load();
    const t = window.setInterval(load, ms);
    const onTx = () => void load();
    window.addEventListener("tontine:tx", onTx);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("tontine:tx", onTx);
    };
  }, [accountId, ms]);
  return b;
}

/** Tell balance widgets a transaction just landed. */
export function announceTx() {
  window.dispatchEvent(new Event("tontine:tx"));
}

/** Chain clock (ns) estimated from the last state snapshot, ticking every second. */
export function useChainNow(state: AppState | null): bigint {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    if (!state) return 0n;
    return BigInt(state.chainTime) + BigInt(Math.max(0, now - state.updatedAt)) * 1_000_000n;
  }, [state, now]);
}

export function useFirmName(state: AppState | null) {
  return (id: number) => state?.firms.find((f) => f.id === id)?.strategy?.name ?? `Firm #${id}`;
}
