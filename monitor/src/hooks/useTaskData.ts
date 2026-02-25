import { useState, useCallback } from 'react';
import type { TaskItem } from '../types';

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

  const fetchTasks = useCallback(async (accountEmails: string[]) => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getTasks(email)),
      );
      setTasks(results.flat());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return { tasks, loading, error, fetchTasks };
}
