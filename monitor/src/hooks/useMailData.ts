import { useState, useCallback } from 'react';
import type { MailItem } from '../types';
import { shouldExcludeAsSpam } from '../utils/spamFilter';
import { useAbortableRequest } from './useAbortableRequest';

// Re-export from the unified spam module so existing importers keep working.
export { isJunkFolder, isProtectedFolder, isSpamFolder } from '../utils/spamFilter';

interface MailDataHook {
  mails: MailItem[];
  loading: boolean;
  error: string | null;
  fetchMails: (accountEmails: string[], daysBack: number, excludeSpam?: boolean) => Promise<void>;
}

export function useMailData(): MailDataHook {
  const [mails, setMails] = useState<MailItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useAbortableRequest();

  const fetchMails = useCallback(async (accountEmails: string[], daysBack: number, excludeSpam = true) => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getMails(email, daysBack)),
      );
      if (signal.aborted) return;
      let allMails = results.flat().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      if (excludeSpam) {
        // Only drop mail in genuine junk/spam folders; Drafts / Trash / Sent
        // are protected and always kept.
        allMails = allMails.filter((m) => !shouldExcludeAsSpam(m));
      }

      setMails(allMails);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  return { mails, loading, error, fetchMails };
}
