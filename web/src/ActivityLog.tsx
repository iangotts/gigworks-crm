import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ago, dueText, dueTone, kindLabel, LOG_KINDS, localToIso, renderTemplate } from './activity';
import { useBandName } from './band';
import { api, errorText } from './api';
import type { ActivityKind, LogItem, Template } from './types';

interface Props {
  contactId?: string | null;
  gigId?: string | null;
  canEdit: boolean;
  /** For filling {first_name} and {name} in a template. */
  contactName?: string | null;
  gigTitle?: string | null;
  /** Called after something is logged or changed, so the page around it can refresh. */
  onChange?: () => void;
}

const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const pad = (n: number): string => String(n).padStart(2, '0');
/** Tomorrow at 9am, as a datetime-local value: a sensible default for "follow up". */
function tomorrowNine(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

/** The running log for a contact or a gig: log a call, voicemail, text, email, note or to-do. */
export function ActivityLog({ contactId, gigId, canEdit, contactName, gigTitle, onChange }: Props) {
  const band = useBandName();
  const [items, setItems] = useState<LogItem[] | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<ActivityKind>('note');
  const [body, setBody] = useState('');
  const [due, setDue] = useState(tomorrowNine);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);

  const query = gigId ? `gig_id=${gigId}` : `contact_id=${contactId}`;

  const load = useCallback(async (): Promise<void> => {
    try {
      setItems((await api<{ activity: LogItem[] }>('GET', `/api/activity?${query}`)).activity);
    } catch (err) {
      setError(errorText(err));
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  // Templates are only offered for the kinds of message they are written for.
  const wantsTemplates = kind === 'email' || kind === 'text';
  useEffect(() => {
    if (!wantsTemplates || templates.length > 0 || !canEdit) return;
    api<{ templates: Template[] }>('GET', '/api/templates')
      .then((r) => setTemplates(r.templates))
      .catch(() => undefined);
  }, [wantsTemplates, templates.length, canEdit]);

  const useTemplate = (id: string): void => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const vars = {
      first_name: contactName?.split(' ')[0],
      name: contactName,
      band,
      gig: gigTitle,
    };
    const text = renderTemplate(t.body, vars);
    setBody((cur) => (cur.trim() ? `${cur}\n\n${text}` : text));
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/activity', {
        kind,
        body,
        contact_id: contactId ?? null,
        gig_id: gigId ?? null,
        ...(kind === 'task' ? { due_at: due ? localToIso(due) : null } : {}),
      });
      setBody('');
      await load();
      onChange?.();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const tick = async (item: LogItem): Promise<void> => {
    try {
      const saved = await api<LogItem>('PATCH', `/api/activity/${item.id}`, { completed: !item.completed_at });
      setItems((list) => (list ?? []).map((x) => (x.id === item.id ? saved : x)));
      onChange?.();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="log">
      {canEdit && (
        <form className="composer" onSubmit={(e) => void submit(e)}>
          <div className="kinds" role="radiogroup" aria-label="Type of entry">
            {LOG_KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                role="radio"
                aria-checked={kind === k.key}
                title={k.hint}
                className="kind"
                onClick={() => setKind(k.key)}
              >
                {k.label}
              </button>
            ))}
          </div>
          {wantsTemplates && templates.length > 0 && (
            <div className="field">
              <label htmlFor="log-template">Start from a template</label>
              <select id="log-template" value="" onChange={(e) => useTemplate(e.target.value)}>
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
            <label className="sr-only" htmlFor="log-body">
              {kind === 'task' ? 'What needs doing' : 'What happened'}
            </label>
            <textarea
              id="log-body"
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                kind === 'task'
                  ? 'What needs doing, for example Send the contract'
                  : kind === 'note'
                    ? 'Something worth remembering'
                    : `What was said in the ${kindLabel(kind).toLowerCase()}`
              }
            />
          </div>
          {kind === 'task' && (
            <div className="field">
              <label htmlFor="log-due">Due</label>
              <input id="log-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          )}
          <div className="composer-end">
            <button className="btn btn-primary" disabled={busy || !body.trim()}>
              {busy ? 'Saving' : kind === 'task' ? 'Add to-do' : `Log ${kindLabel(kind).toLowerCase()}`}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {items === null ? (
        <p className="hint">Loading</p>
      ) : items.length === 0 ? (
        <p className="hint">Nothing logged yet. {canEdit ? 'Log the first call, text or note above.' : ''}</p>
      ) : (
        <ul className="history">
          {items.map((a) => {
            const open = a.kind === 'task' && !a.completed_at;
            const tone = open && a.due_at ? dueTone(a.due_at) : null;
            return (
              <li key={a.id} className={a.kind === 'task' ? 'is-task' : undefined}>
                <time dateTime={a.occurred_at}>
                  <strong>{kindLabel(a.kind)}</strong>, {when(a.occurred_at)}
                  {a.by_name ? `, ${a.by_name}` : ''}
                  {!gigId && a.gig_title ? `, about ${a.gig_title}` : ''}
                </time>
                {a.kind === 'task' ? (
                  <label className="task-line">
                    <input type="checkbox" disabled={!canEdit} checked={Boolean(a.completed_at)} onChange={() => void tick(a)} />
                    <span className={a.completed_at ? 'done' : undefined}>{a.body}</span>
                  </label>
                ) : (
                  <span className="log-body">{a.body}</span>
                )}
                {a.kind === 'task' && (
                  <span className={`chip${tone === 'overdue' ? ' alert' : ''}`}>
                    {a.completed_at ? `Done ${ago(a.completed_at).toLowerCase()}` : a.due_at ? dueText(a.due_at) : 'No due date'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
