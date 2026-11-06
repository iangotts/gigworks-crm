import { describe, expect, it } from 'vitest';
import { dollars, payChip, validAmount } from './money';

describe('money display', () => {
  it('formats dollars and cents', () => {
    expect(dollars('1666.67')).toBe('$1,666.67');
    expect(dollars('0')).toBe('$0.00');
    expect(dollars('-50.00')).toBe('-$50.00');
    expect(dollars(null)).toBe('');
  });
  it('validates amounts like the server', () => {
    for (const ok of ['1', '1250.5', '1250.50']) expect(validAmount(ok)).toBe(true);
    for (const bad of ['0', '', '-1', '1.234', 'abc', '1e3']) expect(validAmount(bad)).toBe(false);
  });
  it('shows a chip only on booked or played gigs, and alerts when a played gig is not paid up', () => {
    expect(payChip('lead', 'unpaid')).toBeNull();
    expect(payChip('confirmed', 'none')).toBeNull();
    expect(payChip('confirmed', 'unpaid')).toEqual({ text: 'Unpaid', alert: false });
    expect(payChip('played', 'part_paid')).toEqual({ text: 'Part paid', alert: true });
    expect(payChip('played', 'paid')).toEqual({ text: 'Paid', alert: false });
  });
});
