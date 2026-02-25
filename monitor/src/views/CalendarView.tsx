import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import type { ViewType } from '../types';
import EmptyState from '../components/shared/EmptyState';

/**
 * Normalize a Google Calendar URL.
 * Accepts:
 *   - Regular URL: https://calendar.google.com/calendar/u/0/r
 *   - Embed URL: https://calendar.google.com/calendar/embed?src=...
 *   - Plain email address
 * Returns the URL as-is (BrowserView can handle any URL).
 */
function normalizeCalendarUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Plain email → embed URL
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(trimmed)}&ctz=Asia/Tokyo`;
  }

  // Already a URL — use as-is (BrowserView can load any URL)
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return '';
  }
}

export default function CalendarView({ onNavigate }: { onNavigate?: (view: ViewType) => void }) {
  const { settings } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  const calendarUrl = normalizeCalendarUrl(settings.googleCalendarUrl ?? '');

  // Track the bounds of the container and send to main process
  const updateBounds = useCallback(() => {
    if (!containerRef.current || !calendarUrl) return;
    const rect = containerRef.current.getBoundingClientRect();
    // BrowserView bounds are relative to the window, not the viewport
    // In Electron, the window content area starts at (0, 0) of the viewport
    const bounds = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    if (bounds.width > 0 && bounds.height > 0) {
      window.electronAPI.calendarSetBounds(bounds);
    }
  }, [calendarUrl]);

  // Show BrowserView on mount, hide on unmount
  useEffect(() => {
    if (!calendarUrl || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const bounds = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };

    window.electronAPI.calendarShow(calendarUrl, bounds).then(() => {
      setReady(true);
      // Recalculate bounds after layout settles
      setTimeout(() => {
        if (containerRef.current) {
          const r = containerRef.current.getBoundingClientRect();
          window.electronAPI.calendarSetBounds({
            x: r.left, y: r.top, width: r.width, height: r.height,
          });
        }
      }, 200);
    });

    return () => {
      window.electronAPI.calendarHide();
      setReady(false);
    };
  }, [calendarUrl]);

  // Update bounds on resize
  useEffect(() => {
    if (!ready || !containerRef.current) return;

    const observer = new ResizeObserver(() => {
      updateBounds();
    });
    observer.observe(containerRef.current);

    // Also listen to window resize
    window.addEventListener('resize', updateBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, [ready, updateBounds]);

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
        <span className="text-[10px] text-surface-500">{calendarUrl ? 'Google Calendar' : ''}</span>
      </div>
      {/* Placeholder div — BrowserView is positioned over this area */}
      <div ref={containerRef} className="flex-1 relative">
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-surface-500 animate-pulse">読み込み中...</p>
          </div>
        )}
      </div>
    </div>
  );
}
