import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getConfig, getDecisions, getEvents, getState, getStats, marketBySymbol, marketOf, nameOf, SYMBOLS, subscribeEvents, type AppState, type ChainEvent, type Config, type Decision, type MarketSymbol, type Stats } from "./api";
import { ASSETS } from "./format";
import { balances, loadWallet, onWallet, type Balances, type Wallet } from "./near";

type Entry<T> = { value: T | null; error: string | null; timer: number; subs: Set<() => void>; tick: () => Promise<void> };

/** Values by key, each shared by every component that subscribes to it and refreshed on an interval while in use. */
function keyedPoll<T>(fetcher: (key: string) => Promise<T>, ms: number) {
  const entries = new Map<string, Entry<T>>();
  const entry = (key: string): Entry<T> => {
    let e = entries.get(key);
    if (!e) {
      const x: Entry<T> = {
        value: null,
        error: null,
        timer: 0,
        subs: new Set(),
        tick: async () => {
          try {
            x.value = await fetcher(key);
            x.error = null;
          } catch (err) {
            x.error = (err as Error).message;
          }
          x.subs.forEach((f) => f());
        },
      };
      entries.set(key, (e = x));
    }
    return e;
  };
  return function useShared(keys: string[]): Entry<T>[] {
    const [, force] = useState(0);
    const k = keys.join(",");
    useEffect(() => {
      const f = () => force((n) => n + 1);
      const list = keys.map(entry);
      for (const e of list) {
        e.subs.add(f);
        if (e.subs.size === 1) {
          void e.tick();
          e.timer = window.setInterval(e.tick, ms);
        }
      }
      return () => {
        for (const e of list) {
          e.subs.delete(f);
          if (e.subs.size === 0) clearInterval(e.timer);
        }
      };
    }, [k]);
    return keys.map(entry);
  };
}

/** One value shared by every component that subscribes to it. */
function sharedPoll<T>(fetcher: () => Promise<T>, ms: number) {
  const poll = keyedPoll<T>(fetcher, ms);
  return function useShared(): { data: T | null; error: string | null; refresh: () => Promise<void> } {
    const [e] = poll([""]);
    return { data: e.value, error: e.error, refresh: e.tick };
  };
}

const statePoll = keyedPoll<AppState>(getState, 2000);
/** One market's state, NEAR by default. */
export function useAppState(market: string = "NEAR"): { data: AppState | null; error: string | null; refresh: () => Promise<void> } {
  const [e] = statePoll([market]);
  return { data: e.value, error: e.error, refresh: e.tick };
}
/** Every market's state, by symbol (null until loaded). */
export function useStates(on = true): Record<MarketSymbol, AppState | null> {
  const list = statePoll(on ? SYMBOLS : []);
  return Object.fromEntries(SYMBOLS.map((s, i) => [s, list[i]?.value ?? null])) as Record<MarketSymbol, AppState | null>;
}
export const useStats = sharedPoll<Stats>(getStats, 4000);
export const useDecisions = sharedPoll<Decision[]>(getDecisions, 10000);

export function useConfig(): Config | null {
  const [c, setC] = useState<Config | null>(null);
  useEffect(() => {
    getConfig().then(setC, () => setC(null));
  }, []);
  return c;
}

/** The market of the page, from `?market=` (NEAR when absent), and a way to switch it. */
export function useMarket() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("market")?.toUpperCase();
  const symbol: MarketSymbol = SYMBOLS.includes(raw as MarketSymbol) ? (raw as MarketSymbol) : "NEAR";
  const config = useConfig();
  const select = (s: MarketSymbol) =>
    setParams(
      (p) => {
        if (s === "NEAR") p.delete("market");
        else p.set("market", s);
        return p;
      },
      { replace: true },
    );
  return { symbol, asset: ASSETS[symbol], market: config ? marketBySymbol(config, symbol) : undefined, config, select };
}

/** A path in a market: NEAR links stay as they were. */
export const inMarket = (path: string, symbol: string | undefined) => (!symbol || symbol === "NEAR" ? path : `${path}?market=${symbol}`);

/** A firm's name by id on the tender (or firm account) that emitted an event, in the given states. */
export const firmNameIn = (states: Partial<Record<MarketSymbol, AppState | null>>, config: Config | null) => (id: number, contract: string) =>
  nameOf(states[(marketOf(config, contract)?.symbol ?? "NEAR") as MarketSymbol]?.firms.find((f) => f.id === id), id);

/** A firm's name by id on the tender (or firm account) that emitted an event, across every market. */
export function useFirmNames(): (id: number, contract: string) => string {
  return firmNameIn(useStates(), useConfig());
}

/** Whether an event comes from a market's tender or one of its firm accounts. */
export const inTender = (e: ChainEvent, tender: string | undefined) => !!tender && (e.contract === tender || e.contract.endsWith(`.${tender}`));
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

// Shared by every widget: one account's balances in every market are 16 view calls.
const balancePoll = keyedPoll<Balances>(balances, 4000);

export function useBalances(accountId: string | undefined): Balances | null {
  const [e] = balancePoll(accountId ? [accountId] : []);
  useEffect(() => {
    if (!e) return;
    const onTx = () => void e.tick();
    window.addEventListener("tontine:tx", onTx);
    return () => window.removeEventListener("tontine:tx", onTx);
  }, [e]);
  return e?.value ?? null;
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
  return (id: number) => nameOf(state?.firms.find((x) => x.id === id), id);
}
