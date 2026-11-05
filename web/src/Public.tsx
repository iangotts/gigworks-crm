import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';

/** The pages anyone can open without logging in: the subscribe form and the unsubscribe link. */
export function publicRoute(path: string): { kind: 'subscribe' | 'unsubscribe'; value: string } | null {
  const m = /^\/(subscribe|unsubscribe)\/([^/]+)\/?$/.exec(path);
  return m ? { kind: m[1] as 'subscribe' | 'unsubscribe', value: decodeURIComponent(m[2] as string) } : null;
}

function Shell({ band, children }: { band?: string; children: React.ReactNode }) {
  return (
    <main className="public">
      <div className="public-card">
        {band && <p className="public-band">{band}</p>}
        {children}
      </div>
    </main>
  );
}

interface BandInfo {
  name: string;
  consent_text: string;
  token: string;
}

export function PublicSubscribe({ slug }: { slug: string }) {
  const [info, setInfo] = useState<BandInfo | null | 'missing'>(null);
  const [email, setEmail] = useState('');
  const [first, setFirst] = useState('');
  const [agree, setAgree] = useState(false);
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<BandInfo>('GET', `/api/public/band/${encodeURIComponent(slug)}`)
      .then(setInfo)
      .catch(() => setInfo('missing'));
  }, [slug]);

  if (info === null) return <Shell><p className="hint">Loading</p></Shell>;
  if (info === 'missing') {
    return (
      <Shell>
        <h1>This sign-up page does not exist</h1>
        <p>Check the address you were given, or ask the band for the right link.</p>
      </Shell>
    );
  }
  if (done) {
    return (
      <Shell band={info.name}>
        <h1>Thanks, you are on the list</h1>
        <p>You will hear from {info.name} about gigs and news. Every email has a link to unsubscribe.</p>
      </Shell>
    );
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', `/api/public/band/${encodeURIComponent(slug)}/subscribe`, {
        email,
        first_name: first,
        consent: agree,
        token: info.token,
        website: trap,
      });
      setDone(true);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(
        code === 'form_expired'
          ? 'This form timed out. Reload the page and try again.'
          : code === 'consent_required'
            ? 'Tick the box to say you agree.'
            : err instanceof ApiError && err.status === 429
              ? 'Too many tries. Wait a minute and try again.'
              : 'Something went wrong. Try again.',
      );
      setBusy(false);
    }
  };

  return (
    <Shell band={info.name}>
      <h1>Hear from {info.name}</h1>
      <p>Gig news and the odd update, straight to your inbox.</p>
      <form onSubmit={(e) => void submit(e)} className="public-form">
        <div className="field">
          <label htmlFor="p-email">Email</label>
          <input id="p-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-first">First name (optional)</label>
          <input id="p-first" autoComplete="given-name" value={first} onChange={(e) => setFirst(e.target.value)} />
        </div>
        {/* Hidden from people. A script that fills in every field gives itself away. */}
        <div className="trap" aria-hidden="true">
          <label htmlFor="p-website">Leave this empty</label>
          <input id="p-website" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
        </div>
        <label className="check consent">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{info.consent_text}</span>
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" disabled={busy || !agree || !email.trim()}>
          {busy ? 'Subscribing' : 'Subscribe'}
        </button>
      </form>
    </Shell>
  );
}

interface UnsubInfo {
  band: string;
  email: string;
  status: string;
}

export function PublicUnsubscribe({ token }: { token: string }) {
  const [info, setInfo] = useState<UnsubInfo | null | 'invalid'>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const url = encodeURIComponent(token);

  useEffect(() => {
    api<UnsubInfo>('GET', `/api/public/unsubscribe/${url}`)
      .then((r) => {
        setInfo(r);
        setStatus(r.status);
      })
      .catch(() => setInfo('invalid'));
  }, [url]);

  if (info === null) return <Shell><p className="hint">Loading</p></Shell>;
  if (info === 'invalid') {
    return (
      <Shell>
        <h1>This link is not valid</h1>
        <p>If you copied it from an email, make sure you copied all of it. Or reply to the email and ask to be removed.</p>
      </Shell>
    );
  }

  const change = async (to: 'unsubscribe' | 'resubscribe'): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setStatus((await api<{ status: string }>('POST', `/api/public/${to}/${url}`)).status);
    } catch {
      setError('Something went wrong. Try again.');
    }
    setBusy(false);
  };

  if (status === 'unsubscribed') {
    return (
      <Shell band={info.band}>
        <h1>You are unsubscribed</h1>
        <p>{info.email} will no longer get email from {info.band}.</p>
        <p className="hint">Pressed it by mistake?</p>
        <button className="btn btn-secondary" disabled={busy} onClick={() => void change('resubscribe')}>
          Undo, keep me subscribed
        </button>
        {error && <p className="error-text" role="alert">{error}</p>}
      </Shell>
    );
  }
  return (
    <Shell band={info.band}>
      <h1>Unsubscribe from {info.band}?</h1>
      <p>{info.email} will stop getting news and gig announcements.</p>
      <button className="btn btn-primary" disabled={busy} onClick={() => void change('unsubscribe')}>
        {busy ? 'Unsubscribing' : 'Unsubscribe'}
      </button>
      {error && <p className="error-text" role="alert">{error}</p>}
    </Shell>
  );
}
