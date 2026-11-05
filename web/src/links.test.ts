import { describe, expect, it } from 'vitest';
import { slug, tagUrl } from './links';

describe('link preview', () => {
  it('slugs values the way the server does', () => {
    expect(slug('Smith Wedding 2027!')).toBe('smith-wedding-2027');
  });
  it('tags an address and keeps its other parts', () => {
    expect(tagUrl('https://a.test/p?x=1#top', { source: 'Jane Blonde', medium: 'Email', campaign: 'Smith wedding', content: '' })).toBe(
      'https://a.test/p?x=1&utm_source=jane-blonde&utm_medium=email&utm_campaign=smith-wedding#top',
    );
  });
  it('gives null for something that is not a web address', () => {
    expect(tagUrl('javascript:alert(1)', { source: 's', medium: 'm' })).toBeNull();
    expect(tagUrl('', { source: 's', medium: 'm' })).toBeNull();
  });
});
