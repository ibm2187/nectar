import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/client';
import { useWsStore } from '../../stores/wsStore';
import type { BuildsPageData } from './types';

export interface UseBuildsDataResult {
  data: BuildsPageData | null;
  loading: boolean;
  error: Error | null;
}

export function useBuildsData(): UseBuildsDataResult {
  const [data, setData] = useState<BuildsPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const pipelineSyncTick = useWsStore(s => s.pipelineSyncTick);
  const hasDataRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Only show the full-page loading state on the initial fetch; background
    // refreshes triggered by pipeline:sync-completed update silently.
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    apiFetch<BuildsPageData>('/pipeline/builds')
      .then(d => {
        if (cancelled) return;
        setData(d);
        hasDataRef.current = true;
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineSyncTick]);

  return { data, loading, error };
}
