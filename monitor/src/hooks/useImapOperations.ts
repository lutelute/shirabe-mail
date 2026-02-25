import { useState, useCallback } from 'react';
import type { ImapCredentials, MoveToTrashResult } from '../types';

interface ImapOperationsHook {
  testing: boolean;
  testResult: { success: boolean; error?: string } | null;
  folders: string[];
  foldersLoading: boolean;
  testConnection: (credentials: ImapCredentials) => Promise<{ success: boolean; error?: string }>;
  fetchFolders: (credentials: ImapCredentials) => Promise<string[]>;
  moveToTrash: (mailIds: number[], accountEmail: string) => Promise<MoveToTrashResult[]>;
}

export function useImapOperations(): ImapOperationsHook {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);

  const testConnection = useCallback(async (credentials: ImapCredentials) => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testImapConnection(credentials);
      setTestResult(result);
      return result;
    } catch (err) {
      const result = { success: false, error: err instanceof Error ? err.message : String(err) };
      setTestResult(result);
      return result;
    } finally {
      setTesting(false);
    }
  }, []);

  const fetchFolders = useCallback(async (credentials: ImapCredentials) => {
    setFoldersLoading(true);
    try {
      const list = await window.electronAPI.listImapFolders(credentials);
      setFolders(list);
      return list;
    } catch {
      setFolders([]);
      return [];
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  const moveToTrash = useCallback(async (mailIds: number[], accountEmail: string) => {
    return window.electronAPI.moveToTrash(mailIds, accountEmail);
  }, []);

  return { testing, testResult, folders, foldersLoading, testConnection, fetchFolders, moveToTrash };
}
