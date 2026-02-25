import type { MailItem, CalendarEvent, TaskItem, ActionItem, AccountConfig, AppSettings } from '../types';
import ActionPanel from './ActionPanel';
import EmailPanel from './EmailPanel';
import CalendarPanel from './CalendarPanel';

interface DashboardProps {
  mails: MailItem[];
  events: CalendarEvent[];
  tasks: TaskItem[];
  actions: ActionItem[];
  accounts: AccountConfig[];
  settings: AppSettings;
  /** Optional className for embedding within parent flex layouts */
  className?: string;
}

export default function Dashboard({
  mails,
  events,
  tasks,
  actions,
  accounts,
  settings,
  className,
}: DashboardProps) {
  return (
    <div className={`flex h-full min-h-0 ${className ?? ''}`}>
      <div className="w-1/4 border-r border-surface-700 overflow-y-auto">
        <ActionPanel actions={actions} />
      </div>
      <div className="w-1/2 border-r border-surface-700 overflow-y-auto">
        <EmailPanel mails={mails} accounts={accounts} />
      </div>
      <div className="w-1/4 overflow-y-auto">
        <CalendarPanel events={events} daysForward={settings.eventDaysForward} />
      </div>
    </div>
  );
}
