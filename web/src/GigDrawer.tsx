import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from './api';
import { ActivityLog } from './ActivityLog';
import { STAGES } from './stages';
import type { Gig, GigDetail } from './types';

type Form = Record<string, string | boolean>;

const TEXT = ['title', 'event_type', 'platform', 'lead_url', 'band_pitched', 'decline_reason', 'fee_note', 'lost_reason', 'notes'] as const;
const DATE = ['event_date', 'reply_owed_by'] as const;
const TIME = ['load_in_time', 'start_time', 'end_time'] as const;
const NUM = ['hours', 'budget', 'drive_miles', 'fee_quoted', 'credits_spent'] as const;
const SELECT = ['stage', 'indoor_outdoor', 'decision'] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

/** An ISO timestamp as the value of a datetime-local input, in the viewer's time zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toForm(g: GigDetail): Form {
  const f: Form = { postponed: g.postponed, verified_phone: g.verified_phone, next_action_at: toLocalInput(g.next_action_at) };
  const rec = g as unknown as Record<string, unknown>;
  for (const k of [...TEXT, ...DATE, ...NUM, ...SELECT]) f[k] = rec[k] === null || rec[k] === undefined ? '' : String(rec[k]);
  for (const k of TIME) f[k] = typeof rec[k] === 'string' ? (rec[k] as string).slice(0, 5) : '';
  return f;
}

/** Only the fields that changed, so saving never overwrites something someone else edited. */
function diff(now: Form, was: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(now)) {
    if (now[k] === was[k]) continue;
    out[k] = k === 'next_action_at' && now[k] ? new Date(String(now[k])).toISOString() : now[k];
  }
  return out;
}

interface Props {
  id: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (g: Gig) => void;
  onArchived: (id: string, title: string) => void;
}

export function GigDrawer({ id, canEdit, onClose, onSaved, onArchived }: Props) {
  const [detail, setDetail] = useState<GigDetail | null>(null);
  const [form, setForm] = useState<Form>({});
  const [original, setOriginal] = useState<Form>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = async (): Promise<void> => {
    try {
      const r = await api<{ gig: GigDetail }>('GET', `/api/gigs/${id}`);
      setDetail(r.gig);
      const f = toForm(r.gig);
      setForm(f);
      setOriginal(f);
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    void load();
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
    if (detail) heading.current?.focus();
  }, [detail]);

  const set = (k: string, v: string | boolean): void => setForm((f) => ({ ...f, [k]: v }));
  const changes = diff(form, original);
  const dirty = Object.keys(changes).length > 0;
  const stage = String(form.stage);

  const text = (k: string, label: string, type = 'text', extra?: { step?: string; hint?: string }): ReactNode => (
    <div className="field">
      <label htmlFor={`f-${k}`}>{label}</label>
      <input
        id={`f-${k}`}
        type={type}
        step={extra?.step}
        disabled={!canEdit}
        value={String(form[k] ?? '')}
        onChange={(e) => set(k, e.target.value)}
      />
      {extra?.hint && <span className="hint">{extra.hint}</span>}
    </div>
  );

  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const saved = await api<Gig>('PATCH', `/api/gigs/${id}`, changes);
      onSaved(saved);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const archive = async (): Promise<void> => {
    setBusy(true);
    try {
      await api('PATCH', `/api/gigs/${id}`, { archived: true });
      onArchived(id, detail?.title ?? 'gig');
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div className="sheet-head">
          <h2 id="drawer-title" tabIndex={-1} ref={heading}>
            {detail?.title ?? 'Loading gig'}
          </h2>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {detail && (
          <div className="sheet-body">
            <div className="section" style={{ borderTop: 0 }}>
              {text('title', 'Gig name')}
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="f-stage">Stage</label>
                  <select id="f-stage" disabled={!canEdit} value={stage} onChange={(e) => set('stage', e.target.value)}>
                    {STAGES.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                {text('event_date', 'Date', 'date')}
              </div>
              {stage === 'confirmed' && (
                <label className="check">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(form.postponed)} onChange={(e) => set('postponed', e.target.checked)} />
                  Postponed
                </label>
              )}
              {stage === 'lost' && text('lost_reason', 'Why was it lost?')}
              <div className="grid-3">
                {text('load_in_time', 'Load-in', 'time')}
                {text('start_time', 'Start', 'time')}
                {text('end_time', 'End', 'time')}
              </div>
            </div>

            <div className="section">
              <h3>People and place</h3>
              <div className="contact-box">
                <strong>{detail.contact_name ?? 'No contact yet'}</strong>
                {detail.contact_email && <a href={`mailto:${detail.contact_email}`}>{detail.contact_email}</a>}
                {detail.contact_phone && <a href={`tel:${detail.contact_phone}`}>{detail.contact_phone}</a>}
              </div>
              <div className="contact-box">
                <strong>{detail.venue_name ?? 'No venue yet'}</strong>
                {detail.venue_city && <span className="hint">{detail.venue_city}</span>}
              </div>
            </div>

            <div className="section">
              <h3>Money and follow-up</h3>
              <div className="grid-2">
                {text('fee_quoted', 'Fee quoted ($)', 'number', { step: '0.01' })}
                {text('fee_note', 'Fee note', 'text', { hint: 'For example + travel, or 50% of door' })}
                {text('reply_owed_by', 'Reply owed by', 'date')}
                {text('next_action_at', 'Follow up on', 'datetime-local')}
              </div>
            </div>

            <div className="section">
              <h3>Lead details</h3>
              <div className="grid-2">
                {text('platform', 'Where it came from')}
                {text('event_type', 'Event type')}
                {text('lead_url', 'Lead link', 'url')}
                <div className="field">
                  <label htmlFor="f-indoor_outdoor">Indoor or outdoor</label>
                  <select id="f-indoor_outdoor" disabled={!canEdit} value={String(form.indoor_outdoor)} onChange={(e) => set('indoor_outdoor', e.target.value)}>
                    <option value="">Not set</option>
                    <option value="indoor">Indoor</option>
                    <option value="outdoor">Outdoor</option>
                    <option value="both">Both</option>
                  </select>
                </div>
                {text('hours', 'Hours of music', 'number', { step: '0.5' })}
                {text('budget', 'Their budget ($)', 'number', { step: '0.01' })}
                {text('drive_miles', 'Drive (miles)', 'number', { step: '0.1' })}
                {text('credits_spent', 'Credits spent', 'number')}
                {text('band_pitched', 'Band pitched')}
                <div className="field">
                  <label htmlFor="f-decision">Decision</label>
                  <select id="f-decision" disabled={!canEdit} value={String(form.decision)} onChange={(e) => set('decision', e.target.value)}>
                    <option value="">Not decided</option>
                    <option value="pursue">Pursue</option>
                    <option value="decline">Decline</option>
                  </select>
                </div>
              </div>
              {form.decision === 'decline' && text('decline_reason', 'Why decline?')}
              <label className="check">
                <input type="checkbox" disabled={!canEdit} checked={Boolean(form.verified_phone)} onChange={(e) => set('verified_phone', e.target.checked)} />
                Phone number verified
              </label>
            </div>

            <div className="section">
              <h3>Notes</h3>
              <div className="field">
                <label className="sr-only" htmlFor="f-notes">
                  Notes
                </label>
                <textarea id="f-notes" disabled={!canEdit} value={String(form.notes)} onChange={(e) => set('notes', e.target.value)} />
              </div>
            </div>

            <div className="section">
              <h3>Activity</h3>
              <ActivityLog gigId={id} canEdit={canEdit} contactName={detail.contact_name} gigTitle={detail.title} />
            </div>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        {!detail && error && (
          <div className="sheet-body">
            <p className="error-text" role="alert">
              {error}
            </p>
          </div>
        )}

        {detail && canEdit && (
          <div className="sheet-foot">
            {confirmArchive ? (
              <>
                <span style={{ alignSelf: 'center' }}>Archive this gig?</span>
                <button className="btn btn-secondary" onClick={() => setConfirmArchive(false)}>
                  Keep it
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void archive()}>
                  Archive gig
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-danger" onClick={() => setConfirmArchive(true)} style={{ marginRight: 'auto' }}>
                  Archive
                </button>
                <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
                  {busy ? 'Saving' : 'Save changes'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
