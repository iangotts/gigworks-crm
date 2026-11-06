import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { BandPicker, Login } from './Login';
import { BandContext } from './band';
import { Contacts } from './Contacts';
import { FollowUps } from './FollowUps';
import { Links } from './Links';
import { PublicSubscribe, PublicUnsubscribe, publicRoute } from './Public';
import { Pipeline } from './Pipeline';
import { CalendarDialog } from './CalendarDialog';
import { PAGES, usePage } from './route';
import { Templates } from './Templates';
import type { Me } from './types';

export default function App() {
  // Subscribe and unsubscribe pages are for anyone, so they never ask for a login.
  const open = publicRoute(window.location.pathname);
  if (open) return open.kind === 'subscribe' ? <PublicSubscribe slug={open.value} /> : <PublicUnsubscribe token={open.value} />;
  return <Crm />;
}

function Crm() {
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  // Changes when the band changes, so the pipeline reloads from scratch.
  const [epoch, setEpoch] = useState(0);
  // Google sends the browser back with ?calendar=connected, declined or failed.
  const [calendar, setCalendar] = useState<{ notice?: string } | null>(() => {
    const flag = new URLSearchParams(window.location.search).get('calendar');
    if (!flag) return null;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    return { notice: flag === 'connected' ? 'Connected. Now choose which calendar to share.' : flag === 'declined' ? 'Google was not given access, so nothing was connected.' : 'Connecting to Google did not work. Try again.' };
  });
  const page = usePage();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setMe(await api<Me>('GET', '/api/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void refresh();
  }, [refresh]);

  const logout = async (): Promise<void> => {
    await api('POST', '/api/logout', {}).catch(() => undefined);
    setMe(null);
  };

  const pick = async (tenantId: string): Promise<void> => {
    await api('POST', '/api/session/tenant', { tenantId });
    await refresh();
    setEpoch((n) => n + 1);
  };

  if (me === 'loading') return <div className="splash">Loading</div>;
  if (!me) return <Login onDone={(m) => setMe(m)} />;

  const active = me.tenants.find((t) => t.id === me.activeTenantId);
  if (!active) return <BandPicker tenants={me.tenants} onPick={pick} onLogout={logout} />;

  return (
    <>
      <header className="header">
        <div className="header-in">
          <span className="wordmark">GW-CRM</span>
          <div className="band-switch">
            {me.tenants.length > 1 ? (
              <>
                <label className="sr-only" htmlFor="band">
                  Band
                </label>
                <select id="band" value={active.id} onChange={(e) => void pick(e.target.value)}>
                  {me.tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <span className="band-name">{active.name}</span>
            )}
          </div>
          <nav className="nav" aria-label="Main">
            {PAGES.map((p) => (
              <a key={p.key} href={`#/${p.key}`} aria-current={page === p.key ? 'page' : undefined}>
                {p.label}
              </a>
            ))}
          </nav>
          <div className="header-end">
            <span className="who">{me.user.name ?? me.user.email}</span>
            <button className="btn btn-ghost" onClick={() => setCalendar({})}>
              Calendar
            </button>
            <button className="btn btn-ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      {calendar && <CalendarDialog role={active.role} bandName={active.name} notice={calendar.notice} onClose={() => setCalendar(null)} />}
      <main className="page">
        <BandContext.Provider value={{ name: active.name, slug: active.slug }}>
          {page === 'pipeline' && <Pipeline key={`${active.id}-${epoch}`} role={active.role} />}
          {page === 'contacts' && <Contacts key={`${active.id}-${epoch}`} role={active.role} />}
          {page === 'followups' && <FollowUps key={`${active.id}-${epoch}`} role={active.role} />}
          {page === 'links' && <Links key={`${active.id}-${epoch}`} role={active.role} />}
          {page === 'templates' && <Templates key={`${active.id}-${epoch}`} role={active.role} />}
        </BandContext.Provider>
      </main>
      <nav className="tabbar" aria-label="Main">
        {PAGES.map((p) => (
          <a key={p.key} href={`#/${p.key}`} aria-current={page === p.key ? 'page' : undefined}>
            {p.label}
          </a>
        ))}
      </nav>
    </>
  );
}
