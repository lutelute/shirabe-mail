import { useState, useCallback } from 'react';
import type { ProjectContext } from '../types';
import { useAbortableRequest } from './useAbortableRequest';

interface ProjectContextHook {
  context: ProjectContext | null;
  folders: string[];
  loading: boolean;
  error: string | null;
  loadContext: (folderPath: string) => Promise<void>;
  listFolders: (basePath: string) => Promise<void>;
}

export function useProjectContext(): ProjectContextHook {
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useAbortableRequest();

  const loadContext = useCallback(async (folderPath: string): Promise<void> => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.loadProjectContext(folderPath);
      if (signal.aborted) return;
      setContext(result);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  const listFolders = useCallback(async (basePath: string): Promise<void> => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.listProjectFolders(basePath);
      if (signal.aborted) return;
      setFolders(result);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  return { context, folders, loading, error, loadContext, listFolders };
}
