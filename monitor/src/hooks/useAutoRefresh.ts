import { useEffect, useRef } from 'react';

export function useAutoRefresh(
  refreshIntervalMinutes: number,
  callback: () => void
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (refreshIntervalMinutes <= 0) return;

    const intervalMs = refreshIntervalMinutes * 60 * 1000;
    const id = setInterval(() => callbackRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [refreshIntervalMinutes]);
}
