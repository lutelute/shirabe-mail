import { useState, useCallback } from 'react';
import type {
  AppSettings,
  MailItem,
  CalendarEvent,
  TaskItem,
  ActionItem,
  FolderItem,
  AccountConfig,
} from '../types';
import { useAbortableRequest } from './useAbortableRequest';

interface EmClientData {
  mails: MailItem[];
  events: CalendarEvent[];
  tasks: TaskItem[];
  actions: ActionItem[];
  folders: FolderItem[];
  accounts: AccountConfig[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useEmClientData(settings: AppSettings): EmClientData {
  const [mails, setMails] = useState<MailItem[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [accounts, setAccounts] = useState<AccountConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useAbortableRequest();

  const refresh = useCallback(async () => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const allAccounts = await window.electronAPI.getAccounts();
      if (signal.aborted) return;
      setAccounts(allAccounts);

      const selected = allAccounts.filter(
        (a) =>
          settings.selectedAccounts.length === 0 ||
          settings.selectedAccounts.includes(a.email)
      );

      const mailResults = await Promise.all(
        selected.map((a) =>
          window.electronAPI.getMails(a.email, settings.mailDaysBack)
        )
      );
      if (signal.aborted) return;
      const allMails = mailResults.flat();
      setMails(allMails);

      const eventResults = await Promise.all(
        selected.map((a) =>
          window.electronAPI.getEvents(a.email, settings.eventDaysForward)
        )
      );
      if (signal.aborted) return;
      setEvents(eventResults.flat());

      const taskResults = await Promise.all(
        selected.map((a) => window.electronAPI.getTasks(a.email))
      );
      if (signal.aborted) return;
      setTasks(taskResults.flat());

      const folderResults = await Promise.all(
        selected.map((a) => window.electronAPI.getFolders(a.email))
      );
      if (signal.aborted) return;
      setFolders(folderResults.flat());

      const extractedActions = await window.electronAPI.extractActions(
        allMails,
        settings.aiEnabled,
        settings.apiKey
      );
      if (signal.aborted) return;
      setActions(extractedActions);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [settings, beginRequest]);

  return { mails, events, tasks, actions, folders, accounts, loading, error, refresh };
}
