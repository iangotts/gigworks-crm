import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorText } from './api';
import type { LinkTarget, Role } from './types';

interface Draft {
  id: string | null;
  name: string;
  url: string;
  active: boolean;
}

export function Links({ role }: { role: Role }) {
  const canEdit = role !== 'read_only';
  const [list, setList] = useState<LinkTarget[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const say = (t: string): void => {
    clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  };
  const load = async (): Promise<void> => {
    try {
      setList((await api<{ targets: LinkTarget[] }>('GET', '/api/link-targets')).targets);
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>
          Links<span className="count">{list?.length ?? 0}</span>
        </h1>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setDraft({ id: null, name: '', url: '', active: true })}>
            New link
          </button>
        )}
      </div>
      <p className="hint tpl-help">
        The pages you send people to: your website, promo video, setlist, testimonials. From a contact or a gig you build a tagged copy of one, so you can see which links bring visits.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {list && list.length === 0 && <p className="empty">{canEdit ? 'No links yet. Add your website with New link.' : 'No links yet.'}</p>}
      <div className="tpl-grid">
        {list?.map((t) => (
          <article key={t.id} className={`tpl${t.active ? '' : ' off'}`}>
            <div className="tpl-top">
              <h2>{t.name}</h2>
              {!t.active && <span className="chip">Not in use</span>}
            </div>
            <p className="tpl-subject link-url">{t.url}</p>
            <p className="hint" style={{ margin: 0 }}>
              {t.sent === 0 ? 'Not sent yet' : t.sent === 1 ? 'Sent once' : `Sent ${t.sent} times`}
              {t.clicks > 0 ? `, ${t.clicks === 1 ? '1 click' : `${t.clicks} clicks`} recorded` : ''}
            </p>
            {canEdit && (
              <div className="tpl-actions">
                <button className="btn btn-secondary" onClick={() => setDraft({ id: t.id, name: t.name, url: t.url, active: t.active })}>
                  Edit
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {draft && (
        <TargetDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onDone={(m) => {
            setDraft(null);
            say(m);
            void load();
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

function TargetDialog({ draft, onClose, onDone }: { draft: Draft; onClose: () => void; onDone: (m: string) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name: d.name, url: d.url, active: d.active };
      if (d.id) await api('PATCH', `/api/link-targets/${d.id}`, body);
      else await api('POST', '/api/link-targets', body);
      onDone(d.id ? 'Link saved' : `Added ${d.name}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="lt-title" onSubmit={(e) => void submit(e)}>
        <div className="sheet-head">
          <h2 id="lt-title">{d.id ? 'Edit link' : 'New link'}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="sheet-body">
          <div className="section" style={{ borderTop: 0 }}>
            <div className="field">
              <label htmlFor="lt-name">Name</label>
              <input id="lt-name" required autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="For example, Promo video" />
            </div>
            <div className="field">
              <label htmlFor="lt-url">Web address</label>
              <input id="lt-url" type="url" required value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://" />
            </div>
            <label className="check">
              <input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />
              In use. Untick to hide it from the link builder.
            </label>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="sheet-foot">
          <button className="btn btn-primary" disabled={busy || !d.name.trim() || !d.url.trim()}>
            {busy ? 'Saving' : d.id ? 'Save changes' : 'Add link'}
          </button>
        </div>
      </form>
    </div>
  );
}
