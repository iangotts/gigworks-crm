import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api';
import type { Role } from './types';

interface Status {
  configured: boolean;
  connection: { google_email: string; status: 'ok' | 'needs_reconnect' } | null;
  share: { calendar_id: string } | null;
  settings: { calendar_id: string; timezone: string; add_members: boolean; mine: boolean } | null;
  sharing: string[];
  redirect_uri?: string;
}
interface Cal {
  id: string;
  name: string;
  primary: boolean;
}

/** Connect your Google Calendar, choose what the band can see, and (admin) where confirmed gigs go. */
export function CalendarDialog({ role, bandName, notice, onClose }: { role: Role; bandName: string; notice?: string; onClose: () => void }) {
  const admin = role === 'admin';
  const [st, setSt] = useState<Status | null>(null);
  const [cals, setCals] = useState<Cal[]>([]);
  const [note, setNote] = useState(notice ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tz, setTz] = useState('America/Los_Angeles');
  const [dest, setDest] = useState('primary');
  const [members, setMembers] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await api<Status>('GET', '/api/calendar/status');
      setSt(s);
      if (s.settings) {
        setTz(s.settings.timezone);
        setDest(s.settings.calendar_id);
        setMembers(s.settings.add_members);
      }
      if (s.configured && s.connection?.status === 'ok') {
        const r = await api<{ calendars: Cal[] }>('GET', '/api/calendar/calendars').catch(() => ({ calendars: [] as Cal[] }));
        setCals(r.calendars);
      }
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>, ok?: string): Promise<void> => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
      if (ok) setNote(ok);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const connect = (): Promise<void> =>
    run(async () => {
      const r = await api<{ url: string }>('GET', '/api/calendar/connect');
      window.location.assign(r.url); // Google asks for permission, then sends the browser back here
    });

  const shared = st?.share?.calendar_id ?? '';
  const needsReconnect = st?.connection?.status === 'needs_reconnect';

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="cal-title">
        <div className="sheet-head">
          <h2 id="cal-title">Calendar</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          {note && <p role="status">{note}</p>}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {st && !st.configured && (
            <div className="section" style={{ borderTop: 0 }}>
              <p>The calendar link is not turned on for this server yet.</p>
              <p className="hint">It needs a Google sign-in set up by whoever runs the server. Nothing else changes until then.</p>
            </div>
          )}
          {st?.configured && !st.connection && (
            <div className="section" style={{ borderTop: 0 }}>
              <p>Connect your Google Calendar so {bandName} can see when you are busy on a gig date.</p>
              <p className="hint">The band sees only the times you are busy, never the event names. You choose which calendar to share, and you can disconnect at any time.</p>
              <button className="btn btn-primary" disabled={busy} onClick={() => void connect()}>
                Connect Google Calendar
              </button>
            </div>
          )}
          {st?.configured && st.connection && (
            <>
              <div className="section" style={{ borderTop: 0 }}>
                <p style={{ margin: 0 }}>
                  Connected as <strong>{st.connection.google_email}</strong>
                </p>
                {needsReconnect && (
                  <p className="error-text" role="alert">
                    Google no longer accepts this sign-in.{' '}
                    <button className="btn btn-secondary" disabled={busy} onClick={() => void connect()}>
                      Connect again
                    </button>
                  </p>
                )}
              </div>
              {!needsReconnect && (
                <div className="section">
                  <h3>Share with {bandName}</h3>
                  <div className="field">
                    <label htmlFor="cal-share">Calendar to check for conflicts</label>
                    <select id="cal-share" value={shared} disabled={busy} onChange={(e) => void run(async () => void (await api('PUT', '/api/calendar/share', { calendar_id: e.target.value || null })), e.target.value ? 'Shared. The band can now see when you are busy.' : 'No longer shared.')}>
                      <option value="">Not shared</option>
                      {cals.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.primary ? ' (main)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="hint" style={{ margin: 0 }}>
                    {st.sharing.length > 0 ? `Sharing with this band: ${st.sharing.join(', ')}.` : 'No one is sharing a calendar with this band yet.'}
                  </p>
                </div>
              )}
              {admin && !needsReconnect && (
                <div className="section">
                  <h3>Confirmed gigs</h3>
                  {st.settings && !st.settings.mine && <p className="hint">Another admin set this up. Saving here moves it to your calendar.</p>}
                  <div className="field">
                    <label htmlFor="cal-dest">Add confirmed gigs to</label>
                    <select id="cal-dest" value={dest} onChange={(e) => setDest(e.target.value)}>
                      {cals.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.primary ? ' (main)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="cal-tz">Time zone for gig times</label>
                    <input id="cal-tz" value={tz} onChange={(e) => setTz(e.target.value)} />
                    <span className="hint">For example America/Los_Angeles.</span>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={members} onChange={(e) => setMembers(e.target.checked)} />
                    <span>Also put it on the calendars of members who share one. No invitation email is sent.</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => void (await api('PUT', '/api/calendar/settings', { calendar_id: dest, timezone: tz, add_members: members })), 'Saved. Gigs are added when they are Confirmed.')}>
                      {st.settings ? 'Save' : 'Turn on'}
                    </button>
                    {st.settings && (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => void run(async () => void (await api('DELETE', '/api/calendar/settings')), 'Turned off. Events already on the calendar stay there.')}>
                        Turn off
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="section">
                <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => void (await api('DELETE', '/api/calendar/connection')), 'Disconnected. Events already on your calendar stay there.')}>
                  Disconnect Google Calendar
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
