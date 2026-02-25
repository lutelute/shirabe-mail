import { useState, useCallback } from 'react';
import type { ThreadMessage } from '../types';

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

  const fetchThread = useCallback(async (mailId: number, accountEmail: string) => {
    setLoading(true);
    setError(null);
    try {
      const msgs = await window.electronAPI.getThreadMessages(mailId, accountEmail);
      setMessages(msgs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearThread = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return { messages, loading, error, fetchThread, clearThread };
}
