import { useCallback, useEffect, useState } from 'react';
import { memberLine } from './calendar';
import { api, errorText } from './api';

interface State {
  configured: boolean;
  enabled?: boolean;
  timezone?: string;
  event?: { link: string | null; synced_at: string } | null;
  problem?: string | null;
  needs_date?: boolean;
  members?: { user_id: string; name: string; status: 'ok' | 'needs_reconnect' | 'error'; message?: string; busy: { start: string; end: string; all_day: boolean }[] }[];
}

/** On a gig: who is busy at that time, and whether the gig is on the band calendar. */
export function CalendarPanel({ gigId, canEdit, refresh }: { gigId: string; canEdit: boolean; refresh: string }) {
  const [s, setS] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setS(await api<State>('GET', `/api/gigs/${gigId}/calendar`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [gigId]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  const retry = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setS(await api<State>('POST', `/api/gigs/${gigId}/calendar/sync`, {}));
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  if (!s || !s.configured) return null; // the calendar link is off for this server

  const tz = s.timezone ?? 'America/Los_Angeles';
  const sharing = s.members ?? [];
  return (
    <div className="section">
      <h3>Calendar</h3>
      {s.needs_date ? (
        <p className="hint">Add a date to check who is free.</p>
      ) : sharing.length === 0 ? (
        <p className="hint">No one has shared a calendar with this band yet. Use Calendar in the header to share yours.</p>
      ) : (
        <ul className="cal-members">
          {sharing.map((m) => (
            <li key={m.user_id} className={m.status === 'ok' && m.busy.length === 0 ? 'free' : 'busy'}>
              {memberLine(m, tz)}
            </li>
          ))}
        </ul>
      )}
      {s.event && (
        <p style={{ margin: 0 }}>
          On the band calendar.{' '}
          {s.event.link && (
            <a href={s.event.link} target="_blank" rel="noreferrer">
              Open in Google Calendar
            </a>
          )}
        </p>
      )}
      {s.problem && (
        <p className="error-text" role="alert">
          Not on the calendar: {s.problem}{' '}
          {canEdit && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => void retry()}>
              {busy ? 'Trying' : 'Try again'}
            </button>
          )}
        </p>
      )}
      {!s.enabled && <p className="hint">Confirmed gigs are not added to a calendar yet. An admin can turn that on in Calendar.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
