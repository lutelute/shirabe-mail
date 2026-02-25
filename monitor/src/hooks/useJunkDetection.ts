import { useState, useCallback } from 'react';
import type { MailItem, JunkClassification } from '../types';

interface JunkDetectionHook {
  results: JunkClassification[];
  loading: boolean;
  error: string | null;
  detectJunk: (mails: MailItem[]) => Promise<JunkClassification[]>;
  clear: () => void;
}

export function useJunkDetection(apiKey: string): JunkDetectionHook {
  const [results, setResults] = useState<JunkClassification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectJunk = useCallback(
    async (mails: MailItem[]): Promise<JunkClassification[]> => {
      setLoading(true);
      setError(null);
      try {
        const classifications = await window.electronAPI.detectJunkEmails(mails, apiKey);
        setResults(classifications);
        return classifications;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return [];
      } finally {
        setLoading(false);
      }
    },
    [apiKey],
  );

  const clear = useCallback(() => {
    setResults([]);
    setError(null);
  }, []);

  return { results, loading, error, detectJunk, clear };
}
