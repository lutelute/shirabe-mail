import { useState, useCallback } from 'react';
import type { MailItem } from '../types';
import { useAbortableRequest } from './useAbortableRequest';

interface SearchDataHook {
  results: MailItem[];
  loading: boolean;
  error: string | null;
  search: (keyword: string, accountEmail: string, daysBack: number) => Promise<void>;
  clearResults: () => void;
}

export function useSearchData(): SearchDataHook {
  const [results, setResults] = useState<MailItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useAbortableRequest();

  const search = useCallback(async (keyword: string, accountEmail: string, daysBack: number) => {
    if (!keyword.trim()) return;
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const mails = await window.electronAPI.searchMails(keyword, accountEmail, daysBack);
      if (signal.aborted) return;
      setResults(mails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  const clearResults = useCallback(() => {
    // Cancel any in-flight search so a late response can't repopulate results.
    beginRequest();
    setResults([]);
    setError(null);
    setLoading(false);
  }, [beginRequest]);

  return { results, loading, error, search, clearResults };
}
