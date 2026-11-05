import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ago } from './activity';
import { api, errorText } from './api';
import { useBand } from './band';
import { MEDIA, slug, tagUrl } from './links';
import type { BuiltLink, LinkTarget } from './types';

interface Props {
  contactId?: string | null;
  gigId?: string | null;
  gigTitle?: string | null;
  canEdit: boolean;
  /** Called after a link is made or a click recorded, so the activity log can refresh. */
  onChange?: () => void;
}

const OTHER = 'other';

/** Build a link with standard UTM tags for one contact or gig, save it, and copy it. */
export function LinkBuilder({ contactId, gigId, gigTitle, canEdit, onChange }: Props) {
  const band = useBand();
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  const [links, setLinks] = useState<BuiltLink[] | null>(null);
  const [which, setWhich] = useState('');
  const [url, setUrl] = useState('');
  const [medium, setMedium] = useState('email');
  const [campaign, setCampaign] = useState(gigTitle ? slug(gigTitle) : '');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ medium: string | null; copied: boolean } | null>(null);
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(false);

  const query = gigId ? `gig_id=${gigId}` : `contact_id=${contactId}`;

  const load = useCallback(async (): Promise<void> => {
    try {
      setLinks((await api<{ links: BuiltLink[] }>('GET', `/api/links?${query}`)).links);
    } catch (err) {
      setError(errorText(err));
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ targets: LinkTarget[] }>('GET', '/api/link-targets')
      .then((r) => {
        const active = r.targets.filter((t) => t.active);
        setTargets(active);
        setWhich((cur) => cur || active[0]?.id || OTHER);
      })
      .catch(() => setWhich(OTHER))
      .finally(() => setReady(true));
  }, []);

  const target = targets.find((t) => t.id === which);
  const base = which === OTHER ? url : (target?.url ?? '');
  const preview = useMemo(
    () => (base ? tagUrl(base, { source: band.slug, medium, campaign, content: content || (target ? slug(target.name) : '') }) : null),
    [base, band.slug, medium, campaign, content, target],
  );

  const copy = async (text: string): Promise<boolean> => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
      setNote('Copied');
    } catch {
      ok = false;
      setNote('Could not copy. Select the address and copy it.');
    }
    setTimeout(() => setNote(''), 3000);
    return ok;
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const link = await api<BuiltLink>('POST', '/api/links', {
        contact_id: contactId ?? null,
        gig_id: gigId ?? null,
        link_target_id: which === OTHER ? null : which,
        url: which === OTHER ? url : null,
        utm_source: band.slug,
        utm_medium: medium,
        utm_campaign: campaign,
        utm_content: content || (target ? slug(target.name) : ''),
      });
      const copied = await copy(link.destination_url);
      setMade({ medium: link.utm_medium, copied });
      await load();
      onChange?.();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const click = async (id: string): Promise<void> => {
    try {
      const saved = await api<BuiltLink>('POST', `/api/links/${id}/clicks`, {});
      setLinks((list) => (list ?? []).map((l) => (l.id === id ? saved : l)));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="log">
      {canEdit && ready && (
        <form className="composer" onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor="lb-which">Link to send</label>
            <select id="lb-which" value={which} onChange={(e) => setWhich(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value={OTHER}>Another address</option>
            </select>
          </div>
          {which === OTHER && (
            <div className="field">
              <label htmlFor="lb-url">Web address</label>
              <input id="lb-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </div>
          )}
          <div className="grid-2">
            <div className="field">
              <label htmlFor="lb-medium">How you will send it</label>
              <input id="lb-medium" list="lb-media" value={medium} onChange={(e) => setMedium(e.target.value)} />
              <datalist id="lb-media">
                {MEDIA.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="lb-campaign">Campaign</label>
              <input id="lb-campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="For example smith-wedding" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="lb-content">Label for this link</label>
            <input id="lb-content" value={content} onChange={(e) => setContent(e.target.value)} placeholder={target ? slug(target.name) : 'Optional'} />
          </div>
          <p className="hint link-preview" aria-live="polite">
            {preview ? preview : base ? 'That is not a web address yet.' : 'Choose a link to see the tagged address.'}
          </p>
          <p className="hint" style={{ margin: 0 }}>
            The address names the band, how it was sent and the campaign. It does not name the person, so a visit shows which link worked, not who clicked.
          </p>
          <div className="composer-end">
            <button className="btn btn-primary" disabled={busy || !preview || !medium.trim()}>
              {busy ? 'Saving' : 'Create and copy link'}
            </button>
          </div>
        </form>
      )}
      {made && (
        <p className="made" role="status">
          {made.copied
            ? `Copied to your clipboard and noted in the activity log. Paste it into your ${made.medium ?? 'message'}.`
            : 'Saved and noted in the activity log. Use Copy on the link below.'}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {note && !made && <span className="hint" role="status">{note}</span>}
      {links === null ? (
        <p className="hint">Loading</p>
      ) : links.length === 0 ? (
        <p className="hint">No links built yet.</p>
      ) : (
        <ul className="history">
          {links.map((l) => (
            <li key={l.id}>
              <time dateTime={l.created_at}>
                <strong>{l.target_name ?? 'Other address'}</strong>, {ago(l.created_at).toLowerCase()}
                {l.utm_campaign ? `, ${l.utm_campaign}` : ''}
                {l.utm_medium ? `, by ${l.utm_medium}` : ''}
              </time>
              <span className="log-body link-url">{l.destination_url}</span>
              <span className="link-actions">
                <span className={`chip${l.clicks > 0 ? ' money' : ''}`}>
                  {l.clicks === 0 ? 'No clicks recorded' : l.clicks === 1 ? '1 click' : `${l.clicks} clicks`}
                </span>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setMade(null);
                    void copy(l.destination_url);
                  }}
                >
                  Copy
                </button>
                {canEdit && (
                  <button className="btn btn-secondary" onClick={() => void click(l.id)}>
                    Record a click
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
