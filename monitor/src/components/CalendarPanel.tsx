import type { CalendarEvent } from '../types';

interface CalendarPanelProps {
  events: CalendarEvent[];
  daysForward: number;
}

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function formatTime(date: Date): string {
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateHeader(date: Date): string {
  const d = new Date(date);
  return `${d.getMonth() + 1}月${d.getDate()}日(${DAY_NAMES[d.getDay()]})`;
}

function getDateKey(date: Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isToday(dateKey: string): boolean {
  const today = new Date();
  return getDateKey(today) === dateKey;
}

export default function CalendarPanel({ events, daysForward }: CalendarPanelProps) {
  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of sortedEvents) {
    const key = getDateKey(event.start);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(event);
  }

  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + daysForward);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-surface-700">
        <h2 className="text-base font-semibold">カレンダー</h2>
        <p className="text-xs text-surface-400 mt-0.5">
          {today.getMonth() + 1}/{today.getDate()} - {endDate.getMonth() + 1}/{endDate.getDate()}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {grouped.size === 0 ? (
          <div className="p-4 text-surface-400 text-center text-sm">
            予定はありません
          </div>
        ) : (
          Array.from(grouped.entries()).map(([dateKey, dayEvents]) => (
            <div key={dateKey}>
              <div
                className={`px-3 py-1.5 text-xs font-semibold sticky top-0 ${
                  isToday(dateKey)
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-surface-800 text-surface-400'
                }`}
              >
                {formatDateHeader(new Date(dateKey + 'T00:00:00'))}
              </div>
              {dayEvents.map((event) => (
                <div
                  key={`${event.accountEmail}-${event.id}`}
                  className={`px-3 py-2 border-b border-surface-700 ${
                    isToday(dateKey) ? 'border-l-2 border-l-blue-500' : ''
                  }`}
                >
                  <div className="text-xs text-surface-400 mb-0.5">
                    {event.isAllDay
                      ? '終日'
                      : `${formatTime(event.start)} - ${formatTime(event.end)}`}
                  </div>
                  <div className="text-sm text-white">{event.summary}</div>
                  {event.location && (
                    <div className="text-xs text-surface-500 mt-0.5">
                      {event.location}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
