import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/csv.js';
import { checkFormToken, formToken, readUnsubToken, unsubToken } from '../src/tokens.js';

const secret = 'test-secret';
const id = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';

describe('form token', () => {
  const t0 = 1_700_000_000_000;
  it('needs a few seconds before it is accepted, and expires', () => {
    const t = formToken(secret, 'janeblonde', t0);
    expect(checkFormToken(secret, 'janeblonde', t, t0 + 500)).toBe('too_fast');
    expect(checkFormToken(secret, 'janeblonde', t, t0 + 10_000)).toBe('ok');
    expect(checkFormToken(secret, 'janeblonde', t, t0 + 3 * 3600_000)).toBe('expired');
  });
  it('is tied to the band and the secret, and cannot be edited', () => {
    const t = formToken(secret, 'janeblonde', t0);
    expect(checkFormToken(secret, 'rocksolid', t, t0 + 10_000)).toBe('invalid');
    expect(checkFormToken('other', 'janeblonde', t, t0 + 10_000)).toBe('invalid');
    expect(checkFormToken(secret, 'janeblonde', t.replace(String(t0), String(t0 - 100_000)), t0 + 10_000)).toBe('invalid');
    expect(checkFormToken(secret, 'janeblonde', 'garbage', t0)).toBe('invalid');
    expect(checkFormToken(secret, 'janeblonde', '', t0)).toBe('invalid');
  });
});

describe('unsubscribe token', () => {
  it('round trips and rejects tampering', () => {
    const t = unsubToken(secret, id);
    expect(readUnsubToken(secret, t)).toBe(id);
    expect(readUnsubToken('other', t)).toBeNull();
    expect(readUnsubToken(secret, `${id.replace('3f', '3e')}.${t.split('.')[1]}`)).toBeNull();
    expect(readUnsubToken(secret, 'nope')).toBeNull();
    expect(readUnsubToken(secret, `x.${t.split('.')[1]}`)).toBeNull();
  });
});

describe('csv', () => {
  it('quotes and escapes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(5)).toBe('5');
  });
  it('defuses spreadsheet formulas', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx']) expect(csvCell(bad).startsWith("'")).toBe(true);
    expect(csvCell('a=b')).toBe('a=b');
  });
  it('builds rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});
