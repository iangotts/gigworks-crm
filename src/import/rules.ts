// Small, pure rules for turning GW-GIG values into GW-CRM values. No database in here.
import { localToInstant } from '../caltime.js';

export const BUBBLE_TZ = 'America/Los_Angeles';

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number): string => String(n).padStart(2, '0');

export interface BubbleDate {
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM, null when the export gave only a date
}

/** "Dec 9, 2022 12:00 am", "Jun 8, 2024 3:13 pm" and "May 27, 2024". */
export function bubbleDate(s: string): BubbleDate | null {
  const m = /^\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([ap]m))?\s*$/i.exec(s);
  if (!m) return null;
  const month = MONTHS[(m[1] as string).toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (m[4] === undefined) return { date, time: null };
  let h = Number(m[4]) % 12;
  if ((m[6] as string).toLowerCase() === 'pm') h += 12;
  return { date, time: `${pad(h)}:${m[5]}` };
}

/** A moment in time. The exports do not say which zone they use, so the band's own zone is assumed. */
export function bubbleInstant(s: string): string | null {
  const d = bubbleDate(s);
  return d ? localToInstant(d.date, d.time ?? '12:00', BUBBLE_TZ) : null;
}

/** "12:00", "2:30pm", "5:30 PM" to "HH:MM:00". Anything else is not a time. */
export function timeOfDay(s: string): string | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  } else if (h > 23) return null;
  return `${pad(h)}:${pad(min)}:00`;
}

/** A plain amount ($, commas allowed) goes to the number. Everything else is kept as typed. */
export function parseFee(raw: string): { amount: string | null; text: string | null } {
  const s = raw.trim();
  if (!s) return { amount: null, text: null };
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/.exec(s);
  if (m) return { amount: `${(m[1] as string).replace(/,/g, '')}${m[2] ?? ''}`, text: null };
  return { amount: null, text: s };
}

/** US numbers as (415) 555-1234. A number with a plus and another country code is kept as +digits. Anything else is flagged. */
export function normalizePhone(raw: string): { phone: string | null; flag: boolean; junk?: string } {
  const s = raw.trim();
  if (!s) return { phone: null, flag: false };
  // No digits at all ("not provided", "doesn't work") or an email typed into the phone box: not a phone number.
  if (!/\d/.test(s) || s.includes('@')) return { phone: null, flag: true, junk: s };
  const ext = /\b(?:x|ext\.?)\s*(\d{1,6})\s*$/i.exec(s);
  const body = ext ? s.slice(0, ext.index) : s;
  let digits = body.replace(/\D/g, '');
  const plus = body.trim().startsWith('+');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) {
    return { phone: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}${ext ? ` x${ext[1]}` : ''}`, flag: false };
  }
  if (plus && digits.length >= 8 && digits.length <= 15) return { phone: `+${digits}${ext ? ` x${ext[1]}` : ''}`, flag: false };
  return { phone: s, flag: true };
}

export function normalizeEmail(raw: string): { email: string | null; bad: boolean } {
  const s = raw.trim().toLowerCase();
  if (!s) return { email: null, bad: false };
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s) ? { email: s, bad: false } : { email: null, bad: true };
}

export const yes = (s: string | undefined): boolean => (s ?? '').trim().toLowerCase() === 'yes';

/** GW-GIG role text to the contact_role kind. The text itself is kept as the label. */
export function roleKind(text: string): 'booking_manager' | 'organizer' | 'client' | 'sound' | 'venue_staff' | 'other' {
  const t = text.trim().toLowerCase();
  if (/booking|^manager/.test(t)) return 'booking_manager';
  if (/organi[sz]er/.test(t)) return 'organizer';
  if (/client|bride|groom|host/.test(t)) return 'client';
  if (/sound|engineer/.test(t)) return 'sound';
  if (/venue/.test(t)) return 'venue_staff';
  return 'other';
}

/** Everything in capitals becomes Title Case (NAPA to Napa). Mixed case is left alone. */
export function tidyCase(s: string): string {
  const t = s.trim();
  return t && t === t.toUpperCase() && /[A-Z]/.test(t) ? t.toLowerCase().replace(/(^|[\s\-/'])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : t;
}

export const venueKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
