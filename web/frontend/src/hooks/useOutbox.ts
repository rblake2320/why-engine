import { useState, useEffect, useCallback } from "react";
import { api, type WhyCase } from "../api/client.ts";

export function useOutbox(repoPath: string) {
  const [cases, setCases] = useState<WhyCase[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.outbox.list(repoPath);
      setCases(result.cases);
      setTotal(result.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load outbox");
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => { fetch(); }, [fetch]);

  return { cases, total, loading, error, refetch: fetch };
}
