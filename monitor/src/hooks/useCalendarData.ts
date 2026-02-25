import { useState, useCallback } from 'react';
import type { CalendarEvent } from '../types';

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

  const fetchEvents = useCallback(async (accountEmails: string[], daysForward: number) => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        accountEmails.map((email) => window.electronAPI.getEvents(email, daysForward)),
      );
      setEvents(results.flat().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return { events, loading, error, fetchEvents };
}
