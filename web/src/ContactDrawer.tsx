import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityLog } from './ActivityLog';
import { ConsentPanel } from './ConsentPanel';
import { LinkBuilder } from './LinkBuilder';
import { contactName } from './activity';
import { api, errorText } from './api';
import { stageLabel } from './stages';
import type { ContactFull, ContactGig, ContactRow } from './types';

type Form = Record<string, string>;
const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'job_title', 'city', 'address', 'source', 'notes'] as const;

const toForm = (c: ContactFull | null): Form => {
  const f: Form = { tags: (c?.tags ?? []).join(', ') };
  const rec = (c ?? {}) as unknown as Record<string, unknown>;
  for (const k of FIELDS) f[k] = rec[k] == null ? '' : String(rec[k]);
  return f;
};
const parseTags = (s: string): string[] => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

/** Only what changed, so saving never overwrites something someone else edited. */
function diff(now: Form, was: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(now)) {
    if (now[k] === was[k]) continue;
    out[k] = k === 'tags' ? parseTags(now[k] ?? '') : now[k];
  }
  return out;
}

const SUB_TEXT: Record<string, string> = {
  subscribed: 'Subscribed to band news',
  unsubscribed: 'Unsubscribed. Do not email.',
  bounced: 'Emails bounce. Do not email.',
  suppressed: 'Suppressed. Do not email.',
};

interface Props {
  /** A contact id, or 'new' to add one. */
  id: string;
  canEdit: boolean;
  onClose: () => void;
  /** After a contact is added or changed. */
  onSaved: (c: ContactRow, created: boolean) => void;
  onArchived: (id: string, name: string) => void;
  /** Open a gig from the contact's list of gigs. */
  onOpenGig?: (id: string) => void;
}

export function ContactDrawer({ id, canEdit, onClose, onSaved, onArchived, onOpenGig }: Props) {
  const isNew = id === 'new';
  const [contact, setContact] = useState<ContactFull | null>(null);
  const [gigs, setGigs] = useState<ContactGig[]>([]);
  const [form, setForm] = useState<Form>(toForm(null));
  const [original, setOriginal] = useState<Form>(toForm(null));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [loaded, setLoaded] = useState(isNew);
  const [logKey, setLogKey] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = async (): Promise<void> => {
    try {
      const r = await api<{ contact: ContactFull; gigs: ContactGig[] }>('GET', `/api/contacts/${id}`);
      setContact(r.contact);
      setGigs(r.gigs);
      const f = toForm(r.contact);
      setForm(f);
      setOriginal(f);
      setLoaded(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    if (!isNew) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [loaded]);

  const set = (k: string, v: string): void => setForm((f) => ({ ...f, [k]: v }));
  const changes = diff(form, original);
  const dirty = isNew ? Object.values(form).some((v) => v.trim()) : Object.keys(changes).length > 0;
  const shownName = isNew ? 'New contact' : contact ? contactName(contact) : 'Loading contact';

  const field = (k: string, label: string, type = 'text', hint?: string): ReactNode => (
    <div className="field">
      <label htmlFor={`c-${k}`}>{label}</label>
      <input id={`c-${k}`} type={type} disabled={!canEdit} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );

  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      if (isNew) {
        const body: Record<string, unknown> = { ...form, tags: parseTags(form.tags ?? '') };
        const created = await api<ContactRow>('POST', '/api/contacts', body);
        setBusy(false);
        onSaved(created, true);
        return;
      }
      const saved = await api<ContactRow>('PATCH', `/api/contacts/${id}`, changes);
      onSaved(saved, false);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const archive = async (): Promise<void> => {
    setBusy(true);
    try {
      await api('PATCH', `/api/contacts/${id}`, { archived: true });
      onArchived(id, shownName);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="contact-title">
        <div className="sheet-head">
          <h2 id="contact-title" tabIndex={-1} ref={heading}>
            {shownName}
          </h2>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {loaded && (
          <div className="sheet-body">
            {!isNew && contact && (
              <div className="quick">
                {contact.phone && <a href={`tel:${contact.phone}`}>Call {contact.phone}</a>}
                {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
                {contact.subscription && (
                  <span className={`chip${contact.subscription === 'subscribed' ? '' : ' alert'}`}>{SUB_TEXT[contact.subscription]}</span>
                )}
              </div>
            )}

            {!isNew && (
              <div className="section">
                <h3>Gigs</h3>
                {gigs.length === 0 ? (
                  <p className="hint" style={{ margin: 0 }}>
                    No gigs for this contact yet.
                  </p>
                ) : (
                  <ul className="mini-list">
                    {gigs.map((g) => (
                      <li key={g.id}>
                        {onOpenGig ? (
                          <button className="link-btn" onClick={() => onOpenGig(g.id)}>
                            {g.title}
                          </button>
                        ) : (
                          <span>{g.title}</span>
                        )}
                        <span className="chip">{stageLabel(g.stage)}</span>
                        {g.event_date && <span className="hint">{g.event_date}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {!isNew && contact && (
              <div className="section">
                <h3>Activity</h3>
                <ActivityLog contactId={contact.id} canEdit={canEdit} contactName={contactName(contact)} refresh={logKey} onChange={() => void load()} />
              </div>
            )}

            {!isNew && contact && (
              <div className="section">
                <h3>Email consent</h3>
                <ConsentPanel
                  contactId={contact.id}
                  email={contact.email}
                  consent={contact.consent}
                  canEdit={canEdit}
                  onChanged={() => {
                    setLogKey((n) => n + 1);
                    void load();
                  }}
                />
              </div>
            )}

            {!isNew && contact && (
              <div className="section">
                <h3>Links</h3>
                <LinkBuilder contactId={contact.id} canEdit={canEdit} onChange={() => setLogKey((n) => n + 1)} />
              </div>
            )}
            <div className="section" style={isNew ? { borderTop: 0 } : undefined}>
              {!isNew && <h3>Details</h3>}
              <div className="grid-2">
                {field('first_name', 'First name')}
                {field('last_name', 'Last name')}
                {field('email', 'Email', 'email')}
                {field('phone', 'Phone', 'tel')}
                {field('company', 'Company')}
                {field('job_title', 'Job title')}
                {field('city', 'City')}
                {field('source', 'Where they came from')}
              </div>
              {field('address', 'Address')}
              {field('tags', 'Tags', 'text', 'Separate with commas, for example wedding, repeat client')}
              <div className="field">
                <label htmlFor="c-notes">Notes</label>
                <textarea id="c-notes" disabled={!canEdit} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
              </div>
            </div>

            {isNew && <p className="hint">Add the contact first, then you can log calls, texts and notes.</p>}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        {!loaded && error && (
          <div className="sheet-body">
            <p className="error-text" role="alert">
              {error}
            </p>
          </div>
        )}

        {loaded && canEdit && (
          <div className="sheet-foot">
            {confirmArchive ? (
              <>
                <span style={{ alignSelf: 'center' }}>Archive this contact?</span>
                <button className="btn btn-secondary" onClick={() => setConfirmArchive(false)}>
                  Keep them
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void archive()}>
                  Archive contact
                </button>
              </>
            ) : (
              <>
                {!isNew && (
                  <button className="btn btn-danger" onClick={() => setConfirmArchive(true)} style={{ marginRight: 'auto' }}>
                    Archive
                  </button>
                )}
                <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
                  {busy ? 'Saving' : isNew ? 'Add contact' : 'Save changes'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
