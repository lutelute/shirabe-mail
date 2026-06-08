import { useState, useCallback } from 'react';
import type { CalendarEvent } from '../types';
import { useAbortableRequest } from './useAbortableRequest';

interface CalendarDataHook {
  events: CalendarEvent[];
  loading: boolean;
  error: string | null;
  fetchEvents: (accountEmails: string[], daysForward: number) => Promise<void>;
}

export function useCalendarData(): CalendarDataHook {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useAbortableRequest();

  const fetchEvents = useCallback(async (accountEmails: string[], daysForward: number) => {
    const signal = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getEvents(email, daysForward)),
      );
      if (signal.aborted) return;
      setEvents(results.flat().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()));
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [beginRequest]);

  return { events, loading, error, fetchEvents };
}
