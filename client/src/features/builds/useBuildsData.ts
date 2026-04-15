import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<BuildsPageData>('/pipeline/builds')
      .then(d => {
        if (!cancelled) setData(d);
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
  }, []);

  return { data, loading, error };
}
