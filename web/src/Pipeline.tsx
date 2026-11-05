import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from './api';
import { GigCard } from './GigCard';
import { GigDrawer } from './GigDrawer';
import { NewGigDialog } from './NewGigDialog';
import { groupByStage, STAGES, stageLabel, todayIso } from './stages';
import type { Gig, Role, StageKey } from './types';

// Played and lost fill up over the years, so they show the latest few until asked for more.
const COLLAPSED: StageKey[] = ['played', 'lost'];
const COLLAPSED_COUNT = 8;

export function Pipeline({ role }: { role: Role }) {
  const canEdit = role !== 'read_only';
  const [gigs, setGigs] = useState<Gig[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [phoneStage, setPhoneStage] = useState<StageKey>('new');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<StageKey>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<StageKey | null>(null);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const today = useMemo(() => todayIso(), []);

  const say = useCallback((text: string, bad = false): void => {
    clearTimeout(toastTimer.current);
    setToast({ text, bad });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      api<{ gigs: Gig[] }>('GET', `/api/gigs?q=${encodeURIComponent(query)}`)
        .then((r) => {
          if (!current) return;
          setGigs(r.gigs);
          setLoadError('');
          setLoaded(true);
        })
        .catch((err) => {
          if (!current) return;
          setLoadError(errorText(err));
          setLoaded(true);
        });
    }, query ? 250 : 0);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [query]);

  const grouped = useMemo(() => groupByStage(gigs), [gigs]);

  const move = async (id: string, stage: StageKey): Promise<void> => {
    const before = gigs.find((g) => g.id === id);
    if (!before || before.stage === stage) return;
    // Show the move straight away and put it back if the server says no.
    setGigs((list) => list.map((g) => (g.id === id ? { ...g, stage, postponed: stage === 'confirmed' ? g.postponed : false } : g)));
    try {
      const saved = await api<Gig>('PATCH', `/api/gigs/${id}`, { stage });
      setGigs((list) => list.map((g) => (g.id === id ? saved : g)));
      say(`Moved “${before.title}” to ${stageLabel(stage)}`);
    } catch (err) {
      setGigs((list) => list.map((g) => (g.id === id ? before : g)));
      say(errorText(err), true);
    }
  };

  const replace = (saved: Gig): void => setGigs((list) => list.map((g) => (g.id === saved.id ? saved : g)));

  return (
    <>
      <div className="page-head">
        <h1>
          Pipeline<span className="count">{gigs.length === 1 ? '1 gig' : `${gigs.length} gigs`}</span>
        </h1>
        <label className="sr-only" htmlFor="gig-search">
          Search gigs
        </label>
        <input
          id="gig-search"
          className="search"
          type="search"
          placeholder="Search gigs, venues, contacts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            New gig
          </button>
        )}
      </div>

      {loadError && (
        <p className="error-text" role="alert">
          {loadError}
        </p>
      )}
      {!canEdit && (
        <p className="hint" style={{ marginTop: -8 }}>
          You have read-only access to this band.
        </p>
      )}

      <div className="tabs" role="tablist" aria-label="Stages">
        {STAGES.map((s) => (
          <button
            key={s.key}
            role="tab"
            className="tab"
            aria-selected={phoneStage === s.key}
            onClick={() => setPhoneStage(s.key)}
          >
            {s.label}
            <small>{grouped[s.key].length}</small>
          </button>
        ))}
      </div>

      <div className="board">
        {STAGES.map((s) => {
          const all = grouped[s.key];
          const collapsible = COLLAPSED.includes(s.key) && !expanded.has(s.key) && all.length > COLLAPSED_COUNT;
          // Newest dates first for finished stages, so "latest" means latest.
          const ordered = COLLAPSED.includes(s.key) ? [...all].sort((a, b) => (b.event_date ?? '').localeCompare(a.event_date ?? '')) : all;
          const shown = collapsible ? ordered.slice(0, COLLAPSED_COUNT) : ordered;
          return (
            <section
              key={s.key}
              className={`col${dropStage === s.key ? ' drop' : ''}`}
              style={{ ['--stage' as string]: `var(--st-${s.key})` }}
              data-active={phoneStage === s.key}
              aria-label={s.label}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setDropStage(s.key);
              }}
              onDragLeave={() => setDropStage((cur) => (cur === s.key ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                setDropStage(null);
                setDragId(null);
                if (id) void move(id, s.key);
              }}
            >
              <div className="col-head" title={s.hint}>
                <h2>{s.label}</h2>
                <span>{all.length}</span>
              </div>
              {shown.map((g) => (
                <GigCard
                  key={g.id}
                  gig={g}
                  today={today}
                  canEdit={canEdit}
                  dragging={dragId === g.id}
                  onOpen={setOpenId}
                  onMove={(id, st) => void move(id, st)}
                  onDragStart={setDragId}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropStage(null);
                  }}
                />
              ))}
              {collapsible && (
                <button className="btn btn-secondary more" onClick={() => setExpanded((e) => new Set(e).add(s.key))}>
                  Show all {all.length}
                </button>
              )}
              {all.length === 0 && loaded && (
                <p className="empty">{query ? 'No matching gigs.' : s.key === 'new' && canEdit ? 'No new leads. Add one with New gig.' : 'Nothing here.'}</p>
              )}
            </section>
          );
        })}
      </div>

      {canEdit && (
        <button className="btn btn-primary fab" onClick={() => setAdding(true)}>
          New gig
        </button>
      )}

      {adding && (
        <NewGigDialog
          onClose={() => setAdding(false)}
          onCreated={(g) => {
            setGigs((list) => [g, ...list]);
            setPhoneStage(g.stage);
            setAdding(false);
            say(`Added “${g.title}”`);
          }}
        />
      )}
      {openId && (
        <GigDrawer
          id={openId}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onSaved={(g) => {
            replace(g);
            say('Changes saved');
          }}
          onArchived={(id, title) => {
            setGigs((list) => list.filter((g) => g.id !== id));
            setOpenId(null);
            say(`Archived “${title}”`);
          }}
        />
      )}
      {toast && (
        <div className={`toast${toast.bad ? ' bad' : ''}`} role="status">
          {toast.text}
        </div>
      )}
    </>
  );
}
