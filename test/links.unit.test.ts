import { describe, expect, it } from 'vitest';
import { slug, tagUrl } from '../src/links.js';

describe('slug', () => {
  it('makes a readable, link-safe value', () => {
    expect(slug('  Smith Wedding 2027! ')).toBe('smith-wedding-2027');
    expect(slug('Café & Bar')).toBe('cafe-bar');
    expect(slug('---')).toBe('');
    expect(slug('x'.repeat(300))).toHaveLength(100);
  });
});

describe('tagUrl', () => {
  const utm = { source: 'janeblonde', medium: 'email', campaign: 'smith-wedding', content: 'promo-video' };
  it('adds the four parameters', () => {
    expect(tagUrl('https://janeblonde.com/video', utm)).toBe(
      'https://janeblonde.com/video?utm_source=janeblonde&utm_medium=email&utm_campaign=smith-wedding&utm_content=promo-video',
    );
  });
  it('keeps other parameters and the fragment, and replaces old utm values', () => {
    const out = tagUrl('https://x.test/p?a=1&utm_source=old&utm_term=t#top', { source: 's', medium: 'm' }) as string;
    expect(out).toBe('https://x.test/p?a=1&utm_source=s&utm_medium=m#top');
  });
  it('leaves out an empty campaign or content', () => {
    expect(tagUrl('https://x.test', { source: 's', medium: 'm', campaign: null, content: '' })).toBe('https://x.test/?utm_source=s&utm_medium=m');
  });
  it('refuses anything that is not a web address', () => {
    for (const bad of ['javascript:alert(1)', 'mailto:a@b.c', 'not a url', 'ftp://x.test', '']) expect(tagUrl(bad, utm)).toBeNull();
  });
});
