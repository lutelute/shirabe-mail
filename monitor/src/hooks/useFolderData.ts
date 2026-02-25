import { useState, useCallback } from 'react';
import type { FolderItem, MailItem } from '../types';

interface FolderDataHook {
  folders: FolderItem[];
  folderMails: MailItem[];
  loading: boolean;
  error: string | null;
  fetchFolders: (accountEmails: string[]) => Promise<void>;
  fetchFolderMails: (folderId: number, accountEmail: string, daysBack?: number) => Promise<void>;
}

export function useFolderData(): FolderDataHook {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [folderMails, setFolderMails] = useState<MailItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFolders = useCallback(async (accountEmails: string[]) => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getFolders(email)),
      );
      setFolders(results.flat());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchFolderMails = useCallback(async (folderId: number, accountEmail: string, daysBack?: number) => {
    setLoading(true);
    setError(null);
    try {
      const mails = await window.electronAPI.getFolderMails(folderId, accountEmail, daysBack);
      setFolderMails(mails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return { folders, folderMails, loading, error, fetchFolders, fetchFolderMails };
}
