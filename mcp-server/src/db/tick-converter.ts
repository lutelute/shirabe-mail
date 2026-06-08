// .NET Tick <-> JS Date conversion
// .NET Ticks = 100-nanosecond intervals since 0001-01-01
// Unix epoch offset in .NET ticks
const EPOCH_OFFSET = 621355968000000000n;

export function ticksToDate(ticks: number | null | undefined): Date | null {
  if (!ticks) return null;
  const bigTicks = BigInt(ticks);
  const unixMs = Number((bigTicks - EPOCH_OFFSET) / 10000n);
  return new Date(unixMs);
}

/**
 * Convert a JS Date to .NET ticks for use as a SQLite query bound.
 *
 * NOTE ON PRECISION: ticks for any modern date are ~6.4e17, which exceeds
 * Number.MAX_SAFE_INTEGER (~9.0e15). The returned `number` is therefore a
 * double with ~64-tick (6.4µs) granularity. This is intentionally kept as
 * `number` rather than `bigint` because:
 *   1. better-sqlite3 returns the `date` column itself as a JS `number`
 *      (double), so the stored values live on the same quantized grid — a
 *      `bigint` bound would just be compared against double column values.
 *   2. Every caller uses this only for coarse cutoff comparisons
 *      (`date >= cutoff`, year boundaries) where the finest granularity is one
 *      second = 10,000,000 ticks, dwarfing the ~64-tick rounding error.
 *   3. Returning `bigint` would ripple through ~10 call sites (which type these
 *      as `number` and mix them into `(number | string)[]` bind arrays) for no
 *      observable behavioral gain.
 * If exact tick identity is ever needed, prefer reading the raw column value
 * back rather than reconstructing it through this function.
 */
export function dateToTicks(date: Date): number {
  const unixMs = BigInt(date.getTime());
  const ticks = unixMs * 10000n + EPOCH_OFFSET;
  return Number(ticks);
}

export function ticksToISO(ticks: number | null | undefined): string | null {
  const date = ticksToDate(ticks);
  return date ? date.toISOString() : null;
}
