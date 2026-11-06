// Local date and time math for gigs. A gig has a date and a clock time in the band's time zone,
// never a UTC instant, so these helpers turn them into instants only for the Google calls.

/** True when the name is a time zone this server knows, such as America/Los_Angeles. */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/** The instant (ISO, UTC) when the wall clock in `tz` reads this date and time. */
export function localToInstant(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset, including across a daylight saving change.
  let ms = guess - offsetMinutes(guess, tz) * 60000;
  ms = guess - offsetMinutes(ms, tz) * 60000;
  return new Date(ms).toISOString();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Adds hours to a local date and time, returning a local date and time. */
export function addHoursLocal(date: string, time: string, hours: number): { date: string; time: string } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1, d, hh + hours, mm));
  return { date: t.toISOString().slice(0, 10), time: t.toISOString().slice(11, 16) };
}

export const hhmm = (t: string): string => t.slice(0, 5);
