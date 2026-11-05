import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PLACEHOLDERS, TEMPLATE_KINDS, templateKindLabel } from './activity';
import { api, errorText } from './api';
import type { Role, Template, TemplateKind } from './types';

interface Draft {
  id: string | null;
  name: string;
  kind: TemplateKind;
  subject: string;
  body: string;
}
const blank: Draft = { id: null, name: '', kind: 'pitch', subject: '', body: '' };

export function Templates({ role }: { role: Role }) {
  const canEdit = role !== 'read_only';
  const [list, setList] = useState<Template[] | null>(null);
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
      setList((await api<{ templates: Template[] }>('GET', '/api/templates')).templates);
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const copy = async (t: Template): Promise<void> => {
    try {
      await navigator.clipboard.writeText(t.subject ? `${t.subject}\n\n${t.body}` : t.body);
      say('Copied. The {placeholders} are still in it.');
    } catch {
      say('Could not copy. Open the template and copy the text.');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>
          Templates<span className="count">{list?.length ?? 0}</span>
        </h1>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setDraft({ ...blank })}>
            New template
          </button>
        )}
      </div>
      <p className="hint tpl-help">
        Reusable wording for pitches, follow-ups and declines. Use {PLACEHOLDERS.join(', ')} and they fill in when you start an email or text from a template.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {list && list.length === 0 && (
        <p className="empty">{canEdit ? 'No templates yet. Add your usual pitch or decline with New template.' : 'No templates yet.'}</p>
      )}
      <div className="tpl-grid">
        {list?.map((t) => (
          <article key={t.id} className="tpl">
            <div className="tpl-top">
              <h2>{t.name}</h2>
              <span className="chip">{templateKindLabel(t.kind)}</span>
            </div>
            {t.subject && <p className="tpl-subject">{t.subject}</p>}
            <p className="tpl-body">{t.body}</p>
            <div className="tpl-actions">
              <button className="btn btn-secondary" onClick={() => void copy(t)}>
                Copy
              </button>
              {canEdit && (
                <button className="btn btn-secondary" onClick={() => setDraft({ id: t.id, name: t.name, kind: t.kind, subject: t.subject ?? '', body: t.body })}>
                  Edit
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      {draft && (
        <TemplateDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onDone={(message) => {
            setDraft(null);
            say(message);
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

function TemplateDialog({ draft, onClose, onDone }: { draft: Draft; onClose: () => void; onDone: (message: string) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onDone(message);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const body = { name: d.name, kind: d.kind, subject: d.subject, body: d.body };
    void send(
      () => (d.id ? api('PATCH', `/api/templates/${d.id}`, body) : api('POST', '/api/templates', body)),
      d.id ? 'Template saved' : `Added ${d.name}`,
    );
  };

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onSubmit={submit}>
        <div className="sheet-head">
          <h2 id="tpl-title">{d.id ? 'Edit template' : 'New template'}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="sheet-body">
          <div className="section" style={{ borderTop: 0 }}>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="t-name">Name</label>
                <input id="t-name" required autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="For example, Wedding pitch" />
              </div>
              <div className="field">
                <label htmlFor="t-kind">Used for</label>
                <select id="t-kind" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as TemplateKind })}>
                  {TEMPLATE_KINDS.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="t-subject">Email subject</label>
              <input id="t-subject" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="t-body">Message</label>
              <textarea id="t-body" required rows={10} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
              <span className="hint">Placeholders: {PLACEHOLDERS.join(', ')}</span>
            </div>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="sheet-foot">
          {d.id &&
            (confirm ? (
              <>
                <span style={{ alignSelf: 'center' }}>Archive this template?</span>
                <button type="button" className="btn btn-secondary" onClick={() => setConfirm(false)}>
                  Keep it
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void send(() => api('PATCH', `/api/templates/${d.id}`, { archived: true }), 'Template archived')}>
                  Archive template
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => setConfirm(true)}>
                Archive
              </button>
            ))}
          {!confirm && (
            <button className="btn btn-primary" disabled={busy || !d.name.trim() || !d.body.trim()}>
              {busy ? 'Saving' : d.id ? 'Save changes' : 'Add template'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
