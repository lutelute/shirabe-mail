import { useState, useCallback } from 'react';
import type { MailItem } from '../types';

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

  const search = useCallback(async (keyword: string, accountEmail: string, daysBack: number) => {
    if (!keyword.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const mails = await window.electronAPI.searchMails(keyword, accountEmail, daysBack);
      setResults(mails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearResults = useCallback(() => {
    setResults([]);
    setError(null);
  }, []);

  return { results, loading, error, search, clearResults };
}
