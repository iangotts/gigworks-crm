import { useState } from 'react';
import { api, errorText } from './api';
import type { Consent } from './types';

const LABEL: Record<string, string> = {
  subscribed: 'Subscribed',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  suppressed: 'Suppressed',
};
const DETAIL: Record<string, string> = {
  subscribed: 'They agreed to hear from the band, so they can be emailed.',
  unsubscribed: 'They asked to be removed. Do not email them.',
  bounced: 'Emails to this address do not arrive. Do not email.',
  suppressed: 'Never email this address.',
};
const day = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '');

interface Props {
  contactId: string;
  email: string | null;
  consent: Consent | null;
  canEdit: boolean;
  onChanged: () => void;
}

/** Whether this person has said yes to band emails, who said so and where, and a way to change it. */
export function ConsentPanel({ contactId, email, consent, canEdit, onChanged }: Props) {
  const [status, setStatus] = useState<string>(consent && consent.status !== 'subscribed' ? 'subscribed' : 'unsubscribed');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const current = consent?.status ?? null;
  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api('PUT', `/api/contacts/${contactId}/subscription`, { status, consent_source: status === 'subscribed' ? source : undefined });
      setSource('');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  return (
    <div className="consent-panel">
      <p className="consent-state">
        <span className={`chip${current === 'subscribed' ? ' money' : current ? ' alert' : ''}`}>{current ? LABEL[current] : 'No consent recorded'}</span>{' '}
        {current ? DETAIL[current] : 'Not on the email list. They have not said they want band emails.'}
      </p>
      {consent?.consented_at && current === 'subscribed' && (
        <p className="hint" style={{ margin: 0 }}>
          Agreed {day(consent.consented_at)}. {consent.consent_source ?? ''}
        </p>
      )}
      {consent?.unsubscribed_at && current === 'unsubscribed' && (
        <p className="hint" style={{ margin: 0 }}>
          Unsubscribed {day(consent.unsubscribed_at)}.
        </p>
      )}
      {canEdit && !email && <p className="hint">Add an email address to this contact before recording consent.</p>}
      {canEdit && email && (
        <div className="consent-edit">
          <div className="field">
            <label htmlFor="consent-status">Change to</label>
            <select id="consent-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="subscribed">Subscribed</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="bounced">Bounced</option>
              <option value="suppressed">Suppressed, never email</option>
            </select>
          </div>
          {status === 'subscribed' && (
            <div className="field">
              <label htmlFor="consent-source">Where did they agree?</label>
              <input id="consent-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="For example, gave me their email at the 1 Nov gig" />
              {current === 'unsubscribed' && <span className="hint">They asked to be removed. Only subscribe them again if they asked to hear from you again.</span>}
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-secondary" disabled={busy || status === current || (status === 'subscribed' && !source.trim())} onClick={() => void save()}>
            {busy ? 'Saving' : 'Save consent'}
          </button>
        </div>
      )}
    </div>
  );
}
