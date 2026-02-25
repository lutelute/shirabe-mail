import { useState, useCallback } from 'react';
import type { ProjectContext } from '../types';

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

  const loadContext = useCallback(async (folderPath: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.loadProjectContext(folderPath);
      setContext(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const listFolders = useCallback(async (basePath: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.listProjectFolders(basePath);
      setFolders(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return { context, folders, loading, error, loadContext, listFolders };
}
