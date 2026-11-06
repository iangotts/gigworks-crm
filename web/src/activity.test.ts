import { describe, expect, it } from 'vitest';
import { ago, hasUnfilled, contactName, dueText, dueTone, renderTemplate } from './activity';

const now = new Date(2026, 10, 5, 15, 0); // Nov 5 2026, 3pm local

describe('renderTemplate', () => {
  it('fills the known placeholders', () => {
    expect(renderTemplate('Hi {first_name}, {band} would love {gig}.', { first_name: 'Priya', band: 'Jane Blonde', gig: 'your wedding' })).toBe(
      'Hi Priya, Jane Blonde would love your wedding.',
    );
  });
  it('leaves a placeholder visible when it has no value, and ignores unknown ones', () => {
    expect(renderTemplate('Hi {first_name} {other}', { first_name: null })).toBe('Hi {first_name} {other}');
  });
  it('fills every copy', () => {
    expect(renderTemplate('{name}/{name}', { name: 'A B' })).toBe('A B/A B');
  });
});

describe('ago', () => {
  it('reads naturally', () => {
    expect(ago(null, now)).toBe('Never');
    expect(ago(new Date(2026, 10, 5, 1, 0).toISOString(), now)).toBe('Today');
    expect(ago(new Date(2026, 10, 4, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(ago(new Date(2026, 10, 1, 9, 0).toISOString(), now)).toBe('4 days ago');
    expect(ago(new Date(2026, 9, 10, 9, 0).toISOString(), now)).toBe('3 weeks ago');
    expect(ago(new Date(2026, 6, 1, 9, 0).toISOString(), now)).toBe('4 months ago');
  });
});

describe('due dates', () => {
  it('treats earlier today as today, not overdue', () => {
    expect(dueTone(new Date(2026, 10, 5, 8, 0).toISOString(), now)).toBe('today');
    expect(dueTone(new Date(2026, 10, 4, 23, 59).toISOString(), now)).toBe('overdue');
    expect(dueTone(new Date(2026, 10, 6, 0, 1).toISOString(), now)).toBe('later');
  });
  it('words them', () => {
    expect(dueText(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe('Overdue by 3 days');
    expect(dueText(new Date(2026, 10, 4, 9, 0).toISOString(), now)).toBe('Overdue by 1 day');
    expect(dueText(new Date(2026, 10, 5, 9, 0).toISOString(), now)).toBe('Today');
    expect(dueText(new Date(2026, 10, 6, 9, 0).toISOString(), now)).toBe('Tomorrow');
    expect(dueText(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toMatch(/Mon, Nov 9/);
  });
});

describe('contactName', () => {
  it('falls back to the email', () => {
    expect(contactName({ first_name: 'A', last_name: 'B', email: null })).toBe('A B');
    expect(contactName({ first_name: null, last_name: null, email: 'x@y.z' })).toBe('x@y.z');
    expect(contactName({ first_name: null, last_name: null, email: null })).toBe('No name');
  });
});

describe('hasUnfilled', () => {
  it('spots a merge field left in the text', () => {
    expect(hasUnfilled('Hi {first_name}')).toBe(true);
    expect(hasUnfilled('Hi Priya, {unknown} stays')).toBe(false);
    expect(hasUnfilled('Hi Priya')).toBe(false);
  });
});
