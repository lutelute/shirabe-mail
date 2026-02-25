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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const allAccounts = await window.electronAPI.getAccounts();
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
      const allMails = mailResults.flat();
      setMails(allMails);

      const eventResults = await Promise.all(
        selected.map((a) =>
          window.electronAPI.getEvents(a.email, settings.eventDaysForward)
        )
      );
      setEvents(eventResults.flat());

      const taskResults = await Promise.all(
        selected.map((a) => window.electronAPI.getTasks(a.email))
      );
      setTasks(taskResults.flat());

      const folderResults = await Promise.all(
        selected.map((a) => window.electronAPI.getFolders(a.email))
      );
      setFolders(folderResults.flat());

      const extractedActions = await window.electronAPI.extractActions(
        allMails,
        settings.aiEnabled,
        settings.apiKey
      );
      setActions(extractedActions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [settings]);

  return { mails, events, tasks, actions, folders, accounts, loading, error, refresh };
}
