import { useState, useCallback } from 'react';
import type { ThreadMessage } from '../types';
import { useAbortableRequest } from './useAbortableRequest';

interface ThreadDataHook {
  messages: ThreadMessage[];
  loading: boolean;
  error: string | null;
  fetchThread: (mailId: number, accountEmail: string) => Promise<void>;
  clearThread: () => void;
}

export function useThreadData(): ThreadDataHook {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useAbortableRequest();

  const fetchThread = useCallback(async (mailId: number, accountEmail: string) => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const msgs = await window.electronAPI.getThreadMessages(mailId, accountEmail);
      if (signal.aborted) return;
      setMessages(msgs);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  const clearThread = useCallback(() => {
    // Cancel any in-flight fetch so a late response can't repopulate the thread.
    beginRequest();
    setMessages([]);
    setError(null);
    setLoading(false);
  }, [beginRequest]);

  return { messages, loading, error, fetchThread, clearThread };
}
