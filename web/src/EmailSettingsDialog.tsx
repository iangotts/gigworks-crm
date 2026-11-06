import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from './api';
import type { EmailSettings } from './types';

interface Reply {
  settings: EmailSettings | null;
  provider: 'sendgrid' | 'log' | 'none';
  can_send: boolean;
}

/** Who the band's email comes from and where replies go. Admins change it; everyone else can read it. */
export function EmailSettingsDialog({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Reply | null>(null);
  const [d, setD] = useState<EmailSettings>({ from_name: '', from_email: '', reply_to: '', signature: '' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<Reply>('GET', '/api/email/settings')
      .then((r) => {
        setLoaded(r);
        if (r.settings) setD({ ...r.settings, signature: r.settings.signature ?? '' });
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNote('');
    try {
      await api('PUT', '/api/email/settings', d);
      setLoaded((l) => (l ? { ...l, settings: d, can_send: l.provider !== 'none' } : l));
      setNote('Saved');
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const test = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await api<{ sent_to: string }>('POST', '/api/email/test', {});
      setNote(`Test sent to ${r.sent_to}. Check that inbox, and that a reply reaches ${d.reply_to}.`);
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const set = (k: keyof EmailSettings) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="es-title" onSubmit={(e) => void save(e)}>
        <div className="sheet-head">
          <h2 id="es-title">Email settings</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          <div className="section" style={{ borderTop: 0 }}>
            {loaded?.provider === 'none' && <p className="error-text" role="alert">Email sending is not turned on for this server yet. Settings can be saved, but nothing will send.</p>}
            {loaded?.provider === 'log' && <p className="hint">Test mode: emails are kept on the server and not delivered.</p>}
            <div className="field">
              <label htmlFor="es-name">From name</label>
              <input id="es-name" required readOnly={!canEdit} value={d.from_name} onChange={set('from_name')} placeholder="For example, Jane Blonde and the Goldfingers" />
            </div>
            <div className="field">
              <label htmlFor="es-from">From address</label>
              <input id="es-from" type="email" required readOnly={!canEdit} value={d.from_email} onChange={set('from_email')} />
              <span className="hint">Must be an address or domain you have verified with the email service, or messages will be refused.</span>
            </div>
            <div className="field">
              <label htmlFor="es-reply">Replies go to</label>
              <input id="es-reply" type="email" required readOnly={!canEdit} value={d.reply_to} onChange={set('reply_to')} />
              <span className="hint">The inbox someone reads. A reply to a sent email lands here.</span>
            </div>
            <div className="field">
              <label htmlFor="es-sig">Signature</label>
              <textarea id="es-sig" rows={3} readOnly={!canEdit} value={d.signature ?? ''} onChange={set('signature')} />
            </div>
            {!canEdit && <p className="hint">Only an admin can change these.</p>}
            {error && <p className="error-text" role="alert">{error}</p>}
            {note && <p role="status">{note}</p>}
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn btn-secondary" disabled={busy || !loaded?.settings} onClick={() => void test()}>
            Send me a test
          </button>
          {canEdit && (
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving' : 'Save settings'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
