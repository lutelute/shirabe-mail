import { useState, useCallback } from 'react';
import type { MailItem } from '../types';

const SPAM_FOLDER_NAMES = new Set([
  'spam', 'junk', 'junk e-mail', 'junk email',
  '迷惑メール', 'スパム',
  'trash', 'deleted items', 'deleted', 'ゴミ箱', '削除済みアイテム',
  'bulk mail', 'bulk',
  'drafts', '下書き',
]);

export function isSpamFolder(folderName?: string): boolean {
  if (!folderName) return false;
  return SPAM_FOLDER_NAMES.has(folderName.toLowerCase());
}

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

  const fetchMails = useCallback(async (accountEmails: string[], daysBack: number, excludeSpam = true) => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getMails(email, daysBack)),
      );
      let allMails = results.flat().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      if (excludeSpam) {
        allMails = allMails.filter((m) => !isSpamFolder(m.folderName));
      }

      setMails(allMails);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return { mails, loading, error, fetchMails };
}
