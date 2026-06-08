import { useRef, useEffect, useCallback } from 'react';

/**
 * Guards data-fetching hooks against the two classic async hazards:
 *   1. setState after the component has unmounted.
 *   2. an older in-flight request resolving *after* a newer one and clobbering
 *      the fresh state (request race / order reversal).
 *
 * The renderer talks to the main process over IPC (`window.electronAPI.*`),
 * which returns plain Promises that cannot be hardware-cancelled. So instead of
 * truly aborting the call, we use the AbortController purely as a generation
 * token: every new request aborts the previous controller, and each `await` in
 * the hook is followed by a `signal.aborted` check before any setState. A stale
 * (superseded) or post-unmount response therefore short-circuits and never
 * touches React state.
 *
 * Usage inside a fetch hook:
 * ```ts
 * const beginRequest = useAbortableRequest();
 * const fetchX = useCallback(async () => {
 *   const signal = beginRequest();          // aborts any prior request
 *   setLoading(true);
 *   try {
 *     const data = await window.electronAPI.getX();
 *     if (signal.aborted) return;            // stale / unmounted -> drop
 *     setData(data);
 *   } finally {
 *     if (!signal.aborted) setLoading(false);
 *   }
 * }, [beginRequest]);
 * ```
 */
export function useAbortableRequest(): () => AbortSignal {
  const controllerRef = useRef<AbortController | null>(null);

  // Abort whatever is in flight when the component unmounts.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  // Start a new request: cancel the previous generation and hand back a signal.
  return useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  }, []);
}
