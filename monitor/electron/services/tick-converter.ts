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

export function dateToTicks(date: Date): number {
  const unixMs = BigInt(date.getTime());
  const ticks = unixMs * 10000n + EPOCH_OFFSET;
  return Number(ticks);
}
