import { useCallback, useState } from "react";
import type { Filter, RangeKey, ResultFilter } from "../api/types";

export const defaultFilter: Filter = {
  range: "24h",
  models: [],
  sources: [],
  apiKey: [],
  authIndex: "",
  result: "",
};

interface UseFilterResult {
  filter: Filter;
  setFilter: (next: Filter) => void;
  setRange: (r: RangeKey) => void;
  setModels: (m: string[]) => void;
  setSources: (s: string[]) => void;
  setAuthIndex: (a: string) => void;
  setResult: (r: ResultFilter) => void;
  setCustomRange: (start: string, end: string) => void;
  reset: () => void;
}

export function useFilter(initial: Filter = defaultFilter): UseFilterResult {
  const [filter, setFilter] = useState<Filter>(initial);

  const setRange = useCallback((r: RangeKey) => {
    setFilter((prev) => ({ ...prev, range: r }));
  }, []);
  const setModels = useCallback((models: string[]) => {
    setFilter((prev) => ({ ...prev, models }));
  }, []);
  const setSources = useCallback((sources: string[]) => {
    setFilter((prev) => ({ ...prev, sources }));
  }, []);
  const setAuthIndex = useCallback((authIndex: string) => {
    setFilter((prev) => ({ ...prev, authIndex }));
  }, []);
  const setResult = useCallback((result: ResultFilter) => {
    setFilter((prev) => ({ ...prev, result }));
  }, []);
  const setCustomRange = useCallback((start: string, end: string) => {
    setFilter((prev) => ({ ...prev, range: "custom", start, end }));
  }, []);
  const reset = useCallback(() => setFilter(defaultFilter), []);

  return { filter, setFilter, setRange, setModels, setSources, setAuthIndex, setResult, setCustomRange, reset };
}
