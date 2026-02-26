import { useAppContext } from '../context/AppContext';
import type { ViewType } from '../types';
import EmptyState from '../components/shared/EmptyState';

/**
 * Normalize a Google Calendar URL to an embeddable format.
 * Accepts:
 *   - Plain email address → embed URL
 *   - Regular URL → convert to embed if possible
 *   - Embed URL → use as-is
 */
function toEmbedUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Plain email → embed URL
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(trimmed)}&ctz=Asia/Tokyo`;
  }

  // Already an embed URL
  if (trimmed.includes('/calendar/embed')) {
    return trimmed;
  }

  // Regular Google Calendar URL → convert to embed
  if (trimmed.includes('calendar.google.com')) {
    // Extract email from URL if possible
    const srcMatch = trimmed.match(/[?&]src=([^&]+)/);
    if (srcMatch) {
      return `https://calendar.google.com/calendar/embed?src=${srcMatch[1]}&ctz=Asia/Tokyo`;
    }
    // Try to convert /r URL to embed
    return `https://calendar.google.com/calendar/embed?ctz=Asia/Tokyo`;
  }

  // Other URL — try as-is
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return '';
  }
}

export default function CalendarView({ onNavigate }: { onNavigate?: (view: ViewType) => void }) {
  const { settings } = useAppContext();

  const calendarUrl = toEmbedUrl(settings.googleCalendarUrl ?? '');

  if (!settings.googleCalendarUrl?.trim()) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-3 border-b border-surface-700">
          <h2 className="text-base font-semibold">カレンダー</h2>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            title="Google Calendar未設定"
            description="設定画面でGoogleアカウントのメールアドレスまたはURLを入力してください"
          >
            {onNavigate && (
              <button
                onClick={() => onNavigate('settings')}
                className="mt-3 px-4 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors"
              >
                設定を開く
              </button>
            )}
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-surface-700 flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold">カレンダー</h2>
        <span className="text-[10px] text-surface-500">Google Calendar</span>
      </div>
      <div className="flex-1 relative">
        <iframe
          src={calendarUrl}
          className="absolute inset-0 w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer-when-downgrade"
          title="Google Calendar"
        />
      </div>
    </div>
  );
}
