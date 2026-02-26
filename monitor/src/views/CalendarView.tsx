import { useRef, useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import type { ViewType } from '../types';
import EmptyState from '../components/shared/EmptyState';

/**
 * Normalize a Google Calendar URL.
 * Accepts:
 *   - Plain email address → full calendar URL
 *   - Regular URL → use as-is
 */
function normalizeCalendarUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Plain email → full calendar URL (not embed — webview can handle full UI)
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return `https://calendar.google.com/calendar/u/0/r`;
  }

  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return '';
  }
}


export default function CalendarView({ onNavigate }: { onNavigate?: (view: ViewType) => void }) {
  const { settings } = useAppContext();
  const webviewRef = useRef<HTMLElement>(null);
  const [loading, setLoading] = useState(true);

  const calendarUrl = normalizeCalendarUrl(settings.googleCalendarUrl ?? '');

  useEffect(() => {
    const wv = webviewRef.current as any;
    if (!wv) return;

    const onDidFinish = () => setLoading(false);
    const onDidStart = () => setLoading(true);

    wv.addEventListener('did-finish-load', onDidFinish);
    wv.addEventListener('did-start-loading', onDidStart);

    return () => {
      wv.removeEventListener('did-finish-load', onDidFinish);
      wv.removeEventListener('did-start-loading', onDidStart);
    };
  }, [calendarUrl]);

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
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <p className="text-xs text-surface-500 animate-pulse">読み込み中...</p>
          </div>
        )}
        <webview
          ref={webviewRef as any}
          src={calendarUrl}
          partition="persist:calendar"
          allowpopups={true}
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>
    </div>
  );
}
