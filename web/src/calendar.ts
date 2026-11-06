export interface Busy {
  start: string;
  end: string;
  all_day: boolean;
}

const clock = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** "busy 7:00 PM to 9:00 PM", or "busy all day", in the band's time zone. */
export function busyText(b: Busy, tz: string): string {
  if (b.all_day) return 'busy all day';
  return `busy ${clock(b.start, tz)} to ${clock(b.end, tz)}`;
}

/** The line shown for one member: free, busy at times, or why we cannot tell. */
export function memberLine(m: { name: string; status: 'ok' | 'needs_reconnect' | 'error'; message?: string; busy: Busy[] }, tz: string): string {
  if (m.status === 'needs_reconnect') return `${m.name}: needs to connect Google Calendar again`;
  if (m.status === 'error') return `${m.name}: could not be checked. ${m.message ?? ''}`.trim();
  if (m.busy.length === 0) return `${m.name}: free`;
  return `${m.name}: ${m.busy.map((b) => busyText(b, tz)).join(', ')}`;
}
