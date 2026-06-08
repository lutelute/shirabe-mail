import { useState, useCallback } from 'react';
import type { TaskItem } from '../types';
import { useAbortableRequest } from './useAbortableRequest';

interface TaskDataHook {
  tasks: TaskItem[];
  loading: boolean;
  error: string | null;
  fetchTasks: (accountEmails: string[]) => Promise<void>;
}

export function useTaskData(): TaskDataHook {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useAbortableRequest();

  const fetchTasks = useCallback(async (accountEmails: string[]) => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getTasks(email)),
      );
      if (signal.aborted) return;
      setTasks(results.flat());
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  return { tasks, loading, error, fetchTasks };
}
