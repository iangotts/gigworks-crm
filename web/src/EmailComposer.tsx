import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { contactName, hasUnfilled, renderTemplate } from './activity';
import { useBandName } from './band';
import { api, errorText } from './api';
import type { Consent, EmailSettings, Template } from './types';

interface ContactInfo {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  consent: Consent | null;
}
interface SettingsReply {
  settings: EmailSettings | null;
  can_send: boolean;
}

interface Props {
  contactId: string;
  gigId?: string | null;
  gigTitle?: string | null;
  onClose: () => void;
  /** Called after the email went out, so the log around it can refresh. */
  onSent: () => void;
}

/** Write and send one email to one person. A person presses Send every time. */
export function EmailComposer({ contactId, gigId, gigTitle, onClose, onSent }: Props) {
  const band = useBandName();
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const [cfg, setCfg] = useState<SettingsReply | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [confirmUnsub, setConfirmUnsub] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  // One id per attempt. A double click or a retry of the same attempt can never send twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    api<{ contact: ContactInfo }>('GET', `/api/contacts/${contactId}`).then((r) => setContact(r.contact)).catch((e) => setError(errorText(e)));
    api<SettingsReply>('GET', '/api/email/settings').then(setCfg).catch((e) => setError(errorText(e)));
    api<{ templates: Template[] }>('GET', '/api/templates').then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, [contactId]);

  const name = contact ? contactName(contact) : '';
  const vars = useMemo(
    () => ({ first_name: contact?.first_name, name: contact ? name : null, band, gig: gigTitle }),
    [contact, name, band, gigTitle],
  );

  const pick = (id: string): void => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (t.subject) setSubject(renderTemplate(t.subject, vars));
    setBody(renderTemplate(t.body, vars));
  };

  const unsubscribed = contact?.consent?.status === 'unsubscribed';
  const blocked = contact?.consent?.status === 'bounced' || contact?.consent?.status === 'suppressed';
  const unfilled = hasUnfilled(subject) || hasUnfilled(body);
  const ready =
    Boolean(contact?.email) && Boolean(cfg?.can_send) && !blocked && (!unsubscribed || confirmUnsub) && subject.trim() !== '' && body.trim() !== '' && !unfilled;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/email/send', {
        contact_id: contactId,
        gig_id: gigId ?? null,
        subject,
        body,
        request_id: requestId,
        confirm_unsubscribed: unsubscribed ? confirmUnsub : undefined,
      });
      setDone(true);
      onSent();
    } catch (err) {
      setError(errorText(err));
      setRequestId(crypto.randomUUID()); // a failed attempt may be tried again as a new one
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="em-title">
          <div className="sheet-head">
            <h2 id="em-title">Email sent</h2>
          </div>
          <div className="sheet-body">
            <p role="status">
              Sent to {contact?.email}. It is saved in {name}&rsquo;s activity. Replies go to {cfg?.settings?.reply_to}.
            </p>
          </div>
          <div className="sheet-foot">
            <button className="btn btn-primary" autoFocus onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="em-title" onSubmit={(e) => void submit(e)}>
        <div className="sheet-head">
          <h2 id="em-title">Email {name || 'contact'}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="sheet-body">
          <div className="section" style={{ borderTop: 0 }}>
            {cfg && !cfg.settings && <p className="error-text" role="alert">Set up who the email comes from first. An admin can do this on the Templates page.</p>}
            {cfg?.settings && (
              <p className="hint" style={{ margin: 0 }}>
                From {cfg.settings.from_name} ({cfg.settings.from_email}). Replies go to {cfg.settings.reply_to}.
              </p>
            )}
            {contact && !contact.email && <p className="error-text" role="alert">This contact has no email address. Add one first.</p>}
            {blocked && <p className="error-text" role="alert">This address bounced or is blocked, so it cannot be emailed.</p>}
            <div className="field">
              <label htmlFor="em-to">To</label>
              <input id="em-to" readOnly value={contact?.email ?? ''} />
            </div>
            {unsubscribed && (
              <label className="check">
                <input type="checkbox" checked={confirmUnsub} onChange={(e) => setConfirmUnsub(e.target.checked)} />
                <span>They unsubscribed from band news. Send this one-to-one email anyway.</span>
              </label>
            )}
            {templates.length > 0 && (
              <div className="field">
                <label htmlFor="em-template">Start from a template</label>
                <select id="em-template" value="" onChange={(e) => pick(e.target.value)}>
                  <option value="">Choose a template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="em-subject">Subject</label>
              <input id="em-subject" required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="em-body">Message</label>
              <textarea id="em-body" required rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
              {cfg?.settings?.signature && <span className="hint">Your signature is added when it is sent.</span>}
            </div>
            {unfilled && <p className="error-text" role="alert">Fill in the {'{placeholders}'} before you send.</p>}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="sheet-foot">
          <button className="btn btn-primary" disabled={!ready || busy}>
            {busy ? 'Sending' : 'Send email'}
          </button>
        </div>
      </form>
    </div>
  );
}
