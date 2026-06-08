import { useState, useCallback } from 'react';
import type { FolderItem, MailItem } from '../types';
import { useAbortableRequest } from './useAbortableRequest';

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
  const beginRequest = useAbortableRequest();

  const fetchFolders = useCallback(async (accountEmails: string[]) => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getFolders(email)),
      );
      if (signal.aborted) return;
      setFolders(results.flat());
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  const fetchFolderMails = useCallback(async (folderId: number, accountEmail: string, daysBack?: number) => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const mails = await window.electronAPI.getFolderMails(folderId, accountEmail, daysBack);
      if (signal.aborted) return;
      setFolderMails(mails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  return { folders, folderMails, loading, error, fetchFolders, fetchFolderMails };
}
