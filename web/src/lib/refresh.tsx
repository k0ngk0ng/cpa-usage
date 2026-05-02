import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// REFRESH_INTERVALS lists the auto-refresh choices shown in the header.
// `0` means off (manual refresh only).
export const REFRESH_INTERVALS = [0, 5, 15, 30, 60] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

interface RefreshContextValue {
  // Monotonically increasing — pages put it in their useEffect deps to refetch.
  tick: number;
  intervalSeconds: RefreshInterval;
  setIntervalSeconds: (n: RefreshInterval) => void;
  refreshNow: () => void;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

const STORAGE_KEY = "cpa-usage:refresh-interval";

function readStored(): RefreshInterval {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const n = raw == null ? 0 : Number(raw);
    return (REFRESH_INTERVALS as readonly number[]).includes(n) ? (n as RefreshInterval) : 0;
  } catch {
    return 0;
  }
}

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [intervalSeconds, setIntervalSecondsState] = useState<RefreshInterval>(() => readStored());
  const timerRef = useRef<number | null>(null);

  const refreshNow = useCallback(() => setTick((t) => t + 1), []);

  const setIntervalSeconds = useCallback((n: RefreshInterval) => {
    setIntervalSecondsState(n);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(n));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (intervalSeconds > 0) {
      timerRef.current = window.setInterval(refreshNow, intervalSeconds * 1000);
    }
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [intervalSeconds, refreshNow]);

  const value = useMemo(
    () => ({ tick, intervalSeconds, setIntervalSeconds, refreshNow }),
    [tick, intervalSeconds, setIntervalSeconds, refreshNow],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside RefreshProvider");
  return ctx;
}

// useRefreshTick returns just the monotonic counter — convenient for pages
// that only need to plug it into a useEffect dependency list.
export function useRefreshTick(): number {
  return useRefresh().tick;
}
