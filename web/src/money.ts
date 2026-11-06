// Display helpers for money. The database does all the sums; these only format strings it sent.
export type PayState = 'none' | 'unpaid' | 'part_paid' | 'paid' | 'overpaid';

export const dollars = (s: string | null | undefined): string => {
  if (s == null || s === '') return '';
  const n = Number(s);
  if (!Number.isFinite(n)) return '';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const STATE_LABEL: Record<PayState, string> = {
  none: 'No fee',
  unpaid: 'Unpaid',
  part_paid: 'Part paid',
  paid: 'Paid',
  overpaid: 'Overpaid',
};

/** The chip on a pipeline card. Only gigs that are booked or played show one. */
export function payChip(stage: string, state: PayState | null | undefined): { text: string; alert: boolean } | null {
  if ((stage !== 'confirmed' && stage !== 'played') || !state || state === 'none') return null;
  return { text: STATE_LABEL[state], alert: stage === 'played' && state !== 'paid' };
}

/** True for "1250", "1250.5", "1250.50". Matches the server rule. */
export const validAmount = (s: string): boolean => /^\d{1,8}(\.\d{1,2})?$/.test(s.trim()) && Number(s) > 0;
