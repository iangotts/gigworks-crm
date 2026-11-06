import { describe, expect, it } from 'vitest';
import { busyText, memberLine } from './calendar';

const tz = 'America/Los_Angeles';
describe('calendar lines', () => {
  it('shows busy times in the band time zone', () => {
    expect(busyText({ start: '2026-12-06T04:00:00.000Z', end: '2026-12-06T05:30:00.000Z', all_day: false }, tz)).toBe('busy 8:00 PM to 9:30 PM');
    expect(busyText({ start: '2026-12-05', end: '2026-12-06', all_day: true }, tz)).toBe('busy all day');
  });
  it('says free, busy or why it cannot tell', () => {
    expect(memberLine({ name: 'Sam', status: 'ok', busy: [] }, tz)).toBe('Sam: free');
    expect(memberLine({ name: 'Sam', status: 'ok', busy: [{ start: '2026-12-06T04:00:00.000Z', end: '2026-12-06T05:00:00.000Z', all_day: false }] }, tz)).toBe('Sam: busy 8:00 PM to 9:00 PM');
    expect(memberLine({ name: 'Sam', status: 'needs_reconnect', busy: [] }, tz)).toContain('connect Google Calendar again');
    expect(memberLine({ name: 'Sam', status: 'error', message: 'Google did not answer.', busy: [] }, tz)).toBe('Sam: could not be checked. Google did not answer.');
  });
});
