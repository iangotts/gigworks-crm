/** Building a tagged link. Pure, so it can be tested without a database. */

/** A value that is safe in a link and easy to read in a report: lower case, letters, digits and dashes. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_.~]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export interface Utm {
  source: string;
  medium: string;
  campaign?: string | null;
  content?: string | null;
}

/**
 * Adds utm_source, utm_medium, utm_campaign and utm_content to an address. Other parameters and
 * the #fragment are kept. A utm_ value already on the address is replaced, so a link is never
 * tagged twice. Returns null when the address is not a web address.
 */
export function tagUrl(raw: string, utm: Utm): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
  u.searchParams.set('utm_source', utm.source);
  u.searchParams.set('utm_medium', utm.medium);
  if (utm.campaign) u.searchParams.set('utm_campaign', utm.campaign);
  if (utm.content) u.searchParams.set('utm_content', utm.content);
  return u.toString();
}
