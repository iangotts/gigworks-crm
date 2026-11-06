import type { ActivityKind, ContactRow, TemplateKind } from './types';

export const LOG_KINDS: { key: ActivityKind; label: string; hint: string }[] = [
  { key: 'call', label: 'Call', hint: 'You spoke with them' },
  { key: 'voicemail', label: 'Voicemail', hint: 'You left or received a voicemail' },
  { key: 'text', label: 'Text', hint: 'A text message' },
  { key: 'email', label: 'Email', hint: 'An email' },
  { key: 'note', label: 'Note', hint: 'Something to remember' },
  { key: 'task', label: 'To do', hint: 'Something to do later, with a due date' },
];

export const kindLabel = (k: ActivityKind): string => LOG_KINDS.find((x) => x.key === k)?.label ?? k;

export const TEMPLATE_KINDS: { key: TemplateKind; label: string }[] = [
  { key: 'pitch', label: 'Pitch' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'decline', label: 'Decline' },
  { key: 'other', label: 'Other' },
];
export const templateKindLabel = (k: TemplateKind): string => TEMPLATE_KINDS.find((x) => x.key === k)?.label ?? k;

export const PLACEHOLDERS = ['{first_name}', '{name}', '{band}', '{gig}'] as const;

/** Fill in {first_name}, {name}, {band} and {gig}. A placeholder with no value stays visible so it gets noticed. */
export function renderTemplate(text: string, vars: Partial<Record<'first_name' | 'name' | 'band' | 'gig', string | null | undefined>>): string {
  return text.replace(/\{(first_name|name|band|gig)\}/g, (whole, key: 'first_name' | 'name' | 'band' | 'gig') => vars[key] || whole);
}

/** True while a {first_name}, {name}, {band} or {gig} is still in the text. */
export const hasUnfilled = (text: string): boolean => /\{(first_name|name|band|gig)\}/.test(text);

export function contactName(c: Pick<ContactRow, 'first_name' | 'last_name' | 'email'>): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'No name';
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayNumber = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

/** "Today", "Yesterday", "5 days ago", "3 weeks ago" or "2 months ago", in the viewer's time zone. */
export function ago(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never';
  const days = dayNumber(dayKey(now)) - dayNumber(dayKey(new Date(iso)));
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export type Due = 'overdue' | 'today' | 'later';

/** Whether a due time has passed, is today, or is still ahead. A time earlier today counts as today. */
export function dueTone(iso: string, now: Date = new Date()): Due {
  const diff = dayNumber(dayKey(new Date(iso))) - dayNumber(dayKey(now));
  return diff < 0 ? 'overdue' : diff === 0 ? 'today' : 'later';
}

/** "Overdue by 3 days", "Today", "Tomorrow" or "Fri, Nov 6". */
export function dueText(iso: string, now: Date = new Date()): string {
  const diff = dayNumber(dayKey(new Date(iso))) - dayNumber(dayKey(now));
  if (diff < 0) return diff === -1 ? 'Overdue by 1 day' : `Overdue by ${-diff} days`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** A plain YYYY-MM-DD date (reply owed by) as a due time at the start of that local day. */
export const dateOnlyToIso = (d: string): string => new Date(`${d}T00:00:00`).toISOString();

/** A datetime-local value (viewer's time zone) as an ISO time. */
export const localToIso = (v: string): string => new Date(v).toISOString();
