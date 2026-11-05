/** Preview of a tagged link. The server builds the real one with the same rules. */

export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_.~]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function tagUrl(raw: string, utm: { source: string; medium: string; campaign?: string; content?: string }): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
  u.searchParams.set('utm_source', slug(utm.source));
  u.searchParams.set('utm_medium', slug(utm.medium));
  if (utm.campaign && slug(utm.campaign)) u.searchParams.set('utm_campaign', slug(utm.campaign));
  if (utm.content && slug(utm.content)) u.searchParams.set('utm_content', slug(utm.content));
  return u.toString();
}

export const MEDIA = ['email', 'text', 'social', 'in-person', 'other'];
