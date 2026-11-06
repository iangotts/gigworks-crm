import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/import/csv.js';
import { bubbleDate, bubbleInstant, normalizeEmail, normalizePhone, parseFee, roleKind, tidyCase, timeOfDay, venueKey } from '../src/import/rules.js';

describe('csv', () => {
  it('reads quotes, doubled quotes, line breaks inside a field and a byte-order mark', () => {
    const rows = parseCsv('﻿name,notes\r\n"Smith, J","said ""hi""\nthen left"\r\nPlain,\r\n');
    expect(rows).toEqual([
      { name: 'Smith, J', notes: 'said "hi"\nthen left' },
      { name: 'Plain', notes: '' },
    ]);
  });
  it('gives an empty list for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('dates and times', () => {
  it('reads Bubble dates with and without a time', () => {
    expect(bubbleDate('Dec 9, 2022 12:00 am')).toEqual({ date: '2022-12-09', time: '00:00' });
    expect(bubbleDate('Jun 8, 2024 3:13 pm')).toEqual({ date: '2024-06-08', time: '15:13' });
    expect(bubbleDate('Aug 12, 2022 12:30 pm')).toEqual({ date: '2022-08-12', time: '12:30' });
    expect(bubbleDate('May 27, 2024')).toEqual({ date: '2024-05-27', time: null });
  });
  it('refuses what is not a date', () => {
    for (const bad of ['', '5/06/24', 'Feb 30, 2024', 'Smarch 3, 2024']) expect(bubbleDate(bad)).toBeNull();
  });
  it('reads a moment in the band zone, including daylight saving', () => {
    expect(bubbleInstant('Jan 15, 2025 10:00 am')).toBe('2025-01-15T18:00:00.000Z');
    expect(bubbleInstant('Jul 15, 2025 10:00 am')).toBe('2025-07-15T17:00:00.000Z');
  });
  it('reads times of day', () => {
    expect(timeOfDay('12:00')).toBe('12:00:00');
    expect(timeOfDay('2:30pm')).toBe('14:30:00');
    expect(timeOfDay('5:30 PM')).toBe('17:30:00');
    expect(timeOfDay('12:15am')).toBe('00:15:00');
    expect(timeOfDay('7pm')).toBe('19:00:00');
    for (const bad of ['', 'late', '25:00', '13pm']) expect(timeOfDay(bad)).toBeNull();
  });
});

describe('fees', () => {
  it('turns a plain number into the amount', () => {
    expect(parseFee('2755')).toEqual({ amount: '2755', text: null });
    expect(parseFee('$3,200')).toEqual({ amount: '3200', text: null });
    expect(parseFee(' $1,250.50 ')).toEqual({ amount: '1250.50', text: null });
    expect(parseFee('0')).toEqual({ amount: '0', text: null });
  });
  it('keeps everything else as typed', () => {
    for (const t of ['FREE', '1800 + 300 + travel expenses', '$3200 + $128 GS fee', '$1600, cheque on day', 'Expenses only', '$2500 via GS']) {
      expect(parseFee(t)).toEqual({ amount: null, text: t });
    }
  });
  it('treats blank as nothing', () => {
    expect(parseFee('  ')).toEqual({ amount: null, text: null });
  });
});

describe('people', () => {
  it('writes phone numbers one way', () => {
    expect(normalizePhone('415-999-2428').phone).toBe('(415) 999-2428');
    expect(normalizePhone('+1 415-994-1908').phone).toBe('(415) 994-1908');
    expect(normalizePhone('4158451927').phone).toBe('(415) 845-1927');
    expect(normalizePhone('415.717.5224').phone).toBe('(415) 717-5224');
    expect(normalizePhone('(415) 474 – 0365 x 10').phone).toBe('(415) 474-0365 x10');
    expect(normalizePhone('+44 20 7946 0958').phone).toBe('+442079460958');
  });
  it('moves what is not a number out of the phone field', () => {
    expect(normalizePhone('not provided')).toMatchObject({ phone: null, junk: 'not provided' });
    expect(normalizePhone('tkernan2@comcast.net')).toMatchObject({ phone: null });
    expect(normalizePhone('707 462-3755 x1 (general)').flag).toBe(true);
    expect(normalizePhone('')).toEqual({ phone: null, flag: false });
  });
  it('lowercases emails and spots bad ones', () => {
    expect(normalizeEmail(' Lisa@Yahoo.COM ')).toEqual({ email: 'lisa@yahoo.com', bad: false });
    expect(normalizeEmail('not an email').bad).toBe(true);
    expect(normalizeEmail('a@b')).toEqual({ email: null, bad: true });
    expect(normalizeEmail('')).toEqual({ email: null, bad: false });
  });
  it('maps role words to kinds', () => {
    expect(roleKind('Booking manager')).toBe('booking_manager');
    expect(roleKind('Organiser')).toBe('organizer');
    expect(roleKind('Bride?')).toBe('client');
    expect(roleKind('Sound engineer')).toBe('sound');
    expect(roleKind('')).toBe('other');
  });
});

describe('names', () => {
  it('title-cases shouting but leaves mixed case alone', () => {
    expect(tidyCase('NAPA')).toBe('Napa');
    expect(tidyCase('SAN CARLOS')).toBe('San Carlos');
    expect(tidyCase('Walnut Creek')).toBe('Walnut Creek');
  });
  it('matches the same venue typed two ways', () => {
    expect(venueKey("Mac's at 19 Broadway")).toBe(venueKey('Macs at 19  Broadway'));
    expect(venueKey('The Fairmont Hotel')).toBe(venueKey('Fairmont hotel'));
    expect(venueKey('Bars & Grill')).toBe(venueKey('Bars and Grill'));
    expect(venueKey('Rose Hall')).not.toBe(venueKey('Rose Garden'));
  });
});
