import { useState, useCallback } from 'react';
import type { ImapCredentials, MoveToTrashResult } from '../types';
import { useAbortableRequest } from './useAbortableRequest';

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
  const beginRequest = useAbortableRequest();

  const testConnection = useCallback(async (credentials: ImapCredentials) => {
    const signal = beginRequest();
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testImapConnection(credentials);
      // Still return the result to the awaiting caller, but only commit it to
      // state if this request hasn't been superseded / the component is mounted.
      if (!signal.aborted) setTestResult(result);
      return result;
    } catch (err) {
      const result = { success: false, error: err instanceof Error ? err.message : String(err) };
      if (!signal.aborted) setTestResult(result);
      return result;
    } finally {
      if (!signal.aborted) setTesting(false);
    }
  }, [beginRequest]);

  const fetchFolders = useCallback(async (credentials: ImapCredentials) => {
    const signal = beginRequest();
    setFoldersLoading(true);
    try {
      const list = await window.electronAPI.listImapFolders(credentials);
      if (!signal.aborted) setFolders(list);
      return list;
    } catch {
      if (!signal.aborted) setFolders([]);
      return [];
    } finally {
      if (!signal.aborted) setFoldersLoading(false);
    }
  }, [beginRequest]);

  const moveToTrash = useCallback(async (mailIds: number[], accountEmail: string) => {
    return window.electronAPI.moveToTrash(mailIds, accountEmail);
  }, []);

  return { testing, testResult, folders, foldersLoading, testConnection, fetchFolders, moveToTrash };
}
