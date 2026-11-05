import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from './api';
import { Combobox } from './Combobox';
import { createContact, createVenue, searchContacts, searchVenues } from './lookups';
import { STAGES } from './stages';
import type { Gig, Pick, StageKey } from './types';

const PLATFORMS = ['Bark', 'GigSalad', 'The Knot', 'Network', 'Repeat client', 'Recommendation', 'Website'];

export function NewGigDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (g: Gig) => void }) {
  const [title, setTitle] = useState('');
  const [stage, setStage] = useState<StageKey>('new');
  const [date, setDate] = useState('');
  const [platform, setPlatform] = useState('');
  const [eventType, setEventType] = useState('');
  const [budget, setBudget] = useState('');
  const [leadUrl, setLeadUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState<Pick | null>(null);
  const [venue, setVenue] = useState<Pick | null>(null);
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
      const gig = await api<Gig>('POST', '/api/gigs', {
        title,
        stage,
        event_date: date,
        platform,
        event_type: eventType,
        budget,
        lead_url: leadUrl,
        notes,
        contact_id: contact?.id ?? null,
        venue_id: venue?.id ?? null,
      });
      onCreated(gig);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="new-title" onSubmit={submit}>
        <div className="sheet-head">
          <h2 id="new-title">New gig</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="sheet-body">
          <div className="section" style={{ borderTop: 0 }}>
            <div className="field">
              <label htmlFor="n-title">Gig name</label>
              <input id="n-title" required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example, Smith wedding or Marin County Fair" />
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="n-stage">Stage</label>
                <select id="n-stage" value={stage} onChange={(e) => setStage(e.target.value as StageKey)}>
                  {STAGES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="n-date">Date</label>
                <input id="n-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>
            <Combobox label="Contact" value={contact} onChange={setContact} search={searchContacts} create={createContact} createLabel="Add contact" placeholder="Search or type a new name" />
            <Combobox label="Venue" value={venue} onChange={setVenue} search={searchVenues} create={createVenue} createLabel="Add venue" placeholder="Search or type a new venue" />
          </div>
          <div className="section">
            <div className="grid-2">
              <div className="field">
                <label htmlFor="n-platform">Where it came from</label>
                <input id="n-platform" list="n-platforms" value={platform} onChange={(e) => setPlatform(e.target.value)} />
                <datalist id="n-platforms">
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="n-type">Event type</label>
                <input id="n-type" value={eventType} onChange={(e) => setEventType(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="n-budget">Their budget ($)</label>
                <input id="n-budget" type="number" min="0" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="n-url">Lead link</label>
                <input id="n-url" type="url" value={leadUrl} onChange={(e) => setLeadUrl(e.target.value)} placeholder="https://" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="n-notes">Notes</label>
              <textarea id="n-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()}>
            {busy ? 'Adding' : 'Add gig'}
          </button>
        </div>
      </form>
    </div>
  );
}
