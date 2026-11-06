import { describe, expect, it } from 'vitest';
import { addDays, addHoursLocal, localToInstant, validTimeZone } from '../src/caltime.js';

describe('local gig times', () => {
  it('turns Los Angeles clock times into the right instant in winter and summer', () => {
    expect(localToInstant('2026-12-05', '19:00', 'America/Los_Angeles')).toBe('2026-12-06T03:00:00.000Z'); // UTC-8
    expect(localToInstant('2026-07-04', '19:00', 'America/Los_Angeles')).toBe('2026-07-05T02:00:00.000Z'); // UTC-7
  });
  it('gets the day right across the daylight saving change', () => {
    expect(localToInstant('2026-03-07', '12:00', 'America/Los_Angeles')).toBe('2026-03-07T20:00:00.000Z'); // still UTC-8
    expect(localToInstant('2026-03-08', '12:00', 'America/Los_Angeles')).toBe('2026-03-08T19:00:00.000Z'); // now UTC-7
    expect(localToInstant('2026-11-01', '12:00', 'America/Los_Angeles')).toBe('2026-11-01T20:00:00.000Z'); // back to UTC-8
  });
  it('works for a zone ahead of UTC', () => {
    expect(localToInstant('2026-12-05', '20:00', 'Europe/London')).toBe('2026-12-05T20:00:00.000Z');
    expect(localToInstant('2026-12-05', '20:00', 'Asia/Tokyo')).toBe('2026-12-05T11:00:00.000Z');
  });
  it('adds days and hours across midnight, month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addHoursLocal('2026-12-05', '22:30', 3)).toEqual({ date: '2026-12-06', time: '01:30' });
  });
  it('knows a real time zone from a made-up one', () => {
    expect(validTimeZone('America/Los_Angeles')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
  });
});
