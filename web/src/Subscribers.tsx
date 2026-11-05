import { useEffect, useState } from 'react';
import { api, errorText } from './api';

interface Summary {
  subscribed: number;
  unsubscribed: number;
  bounced: number;
  suppressed: number;
  no_consent: number;
  subscribe_url: string;
}

interface Preview {
  count: number;
}

/** The email list: who can be emailed, the public sign-up link, and the file for the bulk email tool. */
export function Subscribers({ canExport, tags, onClose }: { canExport: boolean; tags: string[]; onClose: () => void }) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('subscribed');
  const [local, setLocal] = useState('');
  const [tag, setTag] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    api<Summary>('GET', '/api/subscribers/summary').then(setSum).catch((e) => setError(errorText(e)));
  }, []);

  const qs = (format: string): string => {
    const p = new URLSearchParams({ status, format });
    if (local) p.set('local', local);
    if (tag) p.set('tag', tag);
    return p.toString();
  };

  useEffect(() => {
    if (!canExport) return;
    let live = true;
    setCount(null);
    api<Preview>('GET', `/api/export/subscribers?${qs('json')}`)
      .then((r) => live && setCount(r.count))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, local, tag, canExport]);

  const copy = async (): Promise<void> => {
    if (!sum) return;
    try {
      await navigator.clipboard.writeText(sum.subscribe_url);
      setCopied('Copied');
    } catch {
      setCopied('Could not copy. Select the address and copy it yourself.');
    }
  };

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="sub-title">
        <div className="sheet-head">
          <h2 id="sub-title">Email list</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {sum && (
            <>
              <div className="section" style={{ borderTop: 0 }}>
                <div className="sub-counts">
                  <div><strong>{sum.subscribed}</strong><span>Subscribed</span></div>
                  <div><strong>{sum.unsubscribed}</strong><span>Unsubscribed</span></div>
                  <div><strong>{sum.bounced + sum.suppressed}</strong><span>Bounced or blocked</span></div>
                  <div><strong>{sum.no_consent}</strong><span>No consent recorded</span></div>
                </div>
                <p className="hint">Contacts with no consent recorded are never in the export.</p>
              </div>
              <div className="section">
                <h3>Sign-up page</h3>
                <p className="hint">Put this address on your website or in a post. People who use it are added to this band only.</p>
                <div className="field">
                  <label htmlFor="sub-url">Sign-up address</label>
                  <input id="sub-url" readOnly value={sum.subscribe_url} onFocus={(e) => e.target.select()} />
                </div>
                <button className="btn btn-secondary" onClick={() => void copy()}>
                  Copy address
                </button>{' '}
                <span className="hint" role="status">{copied}</span>
              </div>
            </>
          )}
          <div className="section">
            <h3>Export for bulk email</h3>
            {!canExport ? (
              <p className="hint">Only members who can edit can export the list.</p>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="ex-status">Who</label>
                  <select id="ex-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="subscribed">Subscribed</option>
                    <option value="unsubscribed">Unsubscribed</option>
                    <option value="bounced">Bounced</option>
                    <option value="suppressed">Blocked</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-local">Where they live</label>
                  <select id="ex-local" value={local} onChange={(e) => setLocal(e.target.value)}>
                    <option value="">Anywhere</option>
                    <option value="yes">Local only</option>
                    <option value="no">Not local</option>
                  </select>
                </div>
                {tags.length > 0 && (
                  <div className="field">
                    <label htmlFor="ex-tag">Tag</label>
                    <select id="ex-tag" value={tag} onChange={(e) => setTag(e.target.value)}>
                      <option value="">Any tag</option>
                      {tags.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                )}
                <p role="status" aria-live="polite">
                  {count === null ? 'Counting' : `${count} ${count === 1 ? 'person matches' : 'people match'}`}
                </p>
                <a className="btn btn-primary" href={`/api/export/subscribers?${qs('csv')}`} download aria-disabled={!count}>
                  Download CSV
                </a>
                <p className="hint">Each row has its own unsubscribe link. Keep that column when you load the file into your email tool.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
