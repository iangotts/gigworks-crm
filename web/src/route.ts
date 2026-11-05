import { useEffect, useState } from 'react';

export type Page = 'pipeline' | 'contacts' | 'followups' | 'templates';
export const PAGES: { key: Page; label: string }[] = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'followups', label: 'Follow-ups' },
  { key: 'templates', label: 'Templates' },
];

const read = (): Page => {
  const key = window.location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.key === key) ? (key as Page) : 'pipeline';
};

/** The page comes from the address (#/contacts), so back, forward and bookmarks work. */
export function usePage(): Page {
  const [page, setPage] = useState<Page>(read);
  useEffect(() => {
    const on = (): void => setPage(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return page;
}
