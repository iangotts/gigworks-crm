import { useCallback, useEffect, useRef, useState } from 'react';
import { ago, contactName } from './activity';
import { api, errorText } from './api';
import { Subscribers } from './Subscribers';
import { ContactDrawer } from './ContactDrawer';
import { GigDrawer } from './GigDrawer';
import type { ContactRow, Role } from './types';

const PAGE = 100;

export function Contacts({ role }: { role: Role }) {
  const canEdit = role !== 'read_only';
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [more, setMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<'name' | 'recent'>('name');
  const [tags, setTags] = useState<{ tag: string; n: number }[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [gigId, setGigId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const say = (t: string): void => {
    clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  };

  const fetchPage = useCallback(
    async (offset: number): Promise<ContactRow[]> => {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort });
      if (query) p.set('q', query);
      if (tag) p.set('tag', tag);
      return (await api<{ contacts: ContactRow[] }>('GET', `/api/contacts?${p}`)).contacts;
    },
    [query, tag, sort],
  );

  const reload = useCallback(async (): Promise<void> => {
    try {
      const first = await fetchPage(0);
      setRows(first);
      setMore(first.length === PAGE);
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
    setLoaded(true);
    api<{ tags: { tag: string; n: number }[] }>('GET', '/api/contacts/tags')
      .then((r) => setTags(r.tags))
      .catch(() => undefined);
  }, [fetchPage]);

  useEffect(() => {
    const t = setTimeout(() => void reload(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [reload, query]);

  const showMore = async (): Promise<void> => {
    try {
      const next = await fetchPage(rows.length);
      setRows((r) => [...r, ...next]);
      setMore(next.length === PAGE);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>
          Contacts<span className="count">{rows.length}{more ? '+' : ''}</span>
        </h1>
        <label className="sr-only" htmlFor="contact-search">
          Search contacts
        </label>
        <input
          id="contact-search"
          className="search"
          type="search"
          placeholder="Search contacts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="sr-only" htmlFor="contact-sort">
          Sort by
        </label>
        <select id="contact-sort" className="sort" value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'recent')}>
          <option value="name">Sort by name</option>
          <option value="recent">Sort by last contact</option>
        </select>
        <button className="btn btn-secondary" onClick={() => setListOpen(true)}>
          Email list
        </button>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setOpenId('new')}>
            New contact
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div className="tag-row" role="group" aria-label="Filter by tag">
          <button className="tag-btn" aria-pressed={tag === ''} onClick={() => setTag('')}>
            All
          </button>
          {tags.slice(0, 12).map((t) => (
            <button key={t.tag} className="tag-btn" aria-pressed={tag === t.tag} onClick={() => setTag(tag === t.tag ? '' : t.tag)}>
              {t.tag} <small>{t.n}</small>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <ul className="people">
        {rows.map((c) => (
          <li key={c.id}>
            <button className="person" onClick={() => setOpenId(c.id)}>
              <span className="person-main">
                <strong>{contactName(c)}</strong>
                <span className="card-sub">{[c.job_title, c.company].filter(Boolean).join(', ') || c.city || ''}</span>
              </span>
              <span className="person-reach">
                {c.email && <span>{c.email}</span>}
                {c.phone && <span>{c.phone}</span>}
              </span>
              <span className="chips">
                {c.tags.slice(0, 3).map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
                {c.subscription && c.subscription !== 'subscribed' && <span className="chip alert">Do not email</span>}
                {c.open_gigs > 0 && <span className="chip money">{c.open_gigs === 1 ? '1 open gig' : `${c.open_gigs} open gigs`}</span>}
              </span>
              <span className="person-last">{c.last_contact_at ? `Last contact ${ago(c.last_contact_at).toLowerCase()}` : 'Not contacted yet'}</span>
            </button>
          </li>
        ))}
      </ul>
      {loaded && rows.length === 0 && !error && (
        <p className="empty">
          {query || tag ? 'No contacts match.' : canEdit ? 'No contacts yet. Add one with New contact.' : 'No contacts yet.'}
        </p>
      )}
      {more && (
        <button className="btn btn-secondary" onClick={() => void showMore()}>
          Show more
        </button>
      )}
      {canEdit && (
        <button className="btn btn-primary fab" onClick={() => setOpenId('new')}>
          New contact
        </button>
      )}

      {listOpen && <Subscribers canExport={canEdit} tags={tags.map((t) => t.tag)} onClose={() => setListOpen(false)} />}
      {openId && (
        <ContactDrawer
          key={openId}
          id={openId}
          canEdit={canEdit}
          onClose={() => {
            setOpenId(null);
            void reload();
          }}
          onSaved={(c, created) => {
            if (created) {
              say(`Added ${contactName(c)}`);
              setOpenId(c.id);
            } else {
              say('Changes saved');
            }
            void reload();
          }}
          onArchived={(_id, name) => {
            setOpenId(null);
            say(`Archived ${name}`);
            void reload();
          }}
          onOpenGig={(g) => setGigId(g)}
        />
      )}
      {gigId && (
        <GigDrawer
          id={gigId}
          canEdit={canEdit}
          onClose={() => setGigId(null)}
          onSaved={() => say('Changes saved')}
          onArchived={() => {
            setGigId(null);
            say('Gig archived');
            void reload();
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
