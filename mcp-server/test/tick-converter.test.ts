import { describe, it, expect } from 'vitest';
import { ticksToDate, dateToTicks, ticksToISO } from '../src/db/tick-converter.js';

// .NET ticks = 100-ns intervals since 0001-01-01; Unix epoch is this many ticks.
const EPOCH_OFFSET = 621355968000000000n;

describe('tick-converter', () => {
  describe('ticksToDate', () => {
    it('returns null for null/undefined/0 (falsy ticks)', () => {
      expect(ticksToDate(null)).toBeNull();
      expect(ticksToDate(undefined)).toBeNull();
      expect(ticksToDate(0)).toBeNull();
    });

    it('maps the Unix epoch offset to 1970-01-01T00:00:00Z', () => {
      const d = ticksToDate(Number(EPOCH_OFFSET));
      expect(d).not.toBeNull();
      expect(d!.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    });

    it('converts a known modern timestamp correctly', () => {
      // 2024-01-01T00:00:00Z in ticks = epoch offset + ms*10000
      const unixMs = Date.UTC(2024, 0, 1, 0, 0, 0);
      const ticks = Number(BigInt(unixMs) * 10000n + EPOCH_OFFSET);
      const d = ticksToDate(ticks);
      expect(d!.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('dateToTicks', () => {
    it('maps 1970-01-01 back to the epoch offset', () => {
      const ticks = dateToTicks(new Date('1970-01-01T00:00:00.000Z'));
      expect(ticks).toBe(Number(EPOCH_OFFSET));
    });

    it('is the inverse of ticksToDate at second granularity (round-trip)', () => {
      const samples = [
        '1970-01-01T00:00:00.000Z',
        '2000-02-29T12:34:56.000Z', // leap day
        '2024-01-01T00:00:00.000Z',
        '2026-06-08T09:00:00.000Z',
        '2030-12-31T23:59:59.000Z',
      ];
      for (const iso of samples) {
        const original = new Date(iso);
        const roundTripped = ticksToDate(dateToTicks(original));
        expect(roundTripped).not.toBeNull();
        // Allow sub-millisecond drift from the double-precision tick magnitude,
        // but require second-level (and finer, to the ms) fidelity.
        const deltaMs = Math.abs(roundTripped!.getTime() - original.getTime());
        expect(deltaMs).toBeLessThan(1);
      }
    });

    it('produces ticks above MAX_SAFE_INTEGER for modern dates (documents precision limit)', () => {
      const ticks = dateToTicks(new Date('2024-01-01T00:00:00Z'));
      expect(ticks).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('ticksToISO', () => {
    it('returns null for falsy input', () => {
      expect(ticksToISO(null)).toBeNull();
      expect(ticksToISO(0)).toBeNull();
    });

    it('returns an ISO-8601 string for valid ticks', () => {
      const unixMs = Date.UTC(2025, 5, 8, 9, 0, 0);
      const ticks = Number(BigInt(unixMs) * 10000n + EPOCH_OFFSET);
      expect(ticksToISO(ticks)).toBe('2025-06-08T09:00:00.000Z');
    });

    it('round-trips with dateToTicks for a date-only value', () => {
      const iso = ticksToISO(dateToTicks(new Date('2024-04-01T00:00:00.000Z')));
      expect(iso).toBe('2024-04-01T00:00:00.000Z');
    });
  });
});
