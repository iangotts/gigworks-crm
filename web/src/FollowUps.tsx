import { useCallback, useEffect, useRef, useState } from 'react';
import { dueText, dueTone } from './activity';
import { api, errorText } from './api';
import { ContactDrawer } from './ContactDrawer';
import { GigDrawer } from './GigDrawer';
import { shortDate, stageLabel, todayIso, isBefore } from './stages';
import type { Followups, Role } from './types';

type Item = {
  key: string;
  due: string; // ISO time, or a YYYY-MM-DD date
  tone: 'overdue' | 'today' | 'later';
  title: string;
  who: string | null;
  note: string;
  done: () => Promise<void>;
  open: () => void;
};

export function FollowUps({ role }: { role: Role }) {
  const canEdit = role !== 'read_only';
  const [data, setData] = useState<Followups | null>(null);
  const [error, setError] = useState('');
  const [gigId, setGigId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const today = todayIso();

  const say = (t: string): void => {
    clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  };

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api<Followups>('GET', '/api/followups'));
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = (what: () => Promise<unknown>, message: string) => async (): Promise<void> => {
    try {
      await what();
      say(message);
      await load();
    } catch (err) {
      say(errorText(err));
    }
  };

  const followups: Item[] = data
    ? [
        ...data.tasks.map((t): Item => ({
          key: `t-${t.id}`,
          due: t.due_at ?? '9999-12-31',
          tone: t.due_at ? dueTone(t.due_at) : 'later',
          title: t.body ?? 'To do',
          who: t.contact_name,
          note: t.gig_title ? `About ${t.gig_title}` : 'To do',
          done: finish(() => api('PATCH', `/api/activity/${t.id}`, { completed: true }), 'Marked done'),
          open: () => (t.gig_id ? setGigId(t.gig_id) : t.contact_id && setContactId(t.contact_id)),
        })),
        ...data.gigs.map((g): Item => ({
          key: `g-${g.id}`,
          due: g.next_action_at,
          tone: dueTone(g.next_action_at),
          title: g.title,
          who: g.contact_name,
          note: `Follow up, ${stageLabel(g.stage)}`,
          done: finish(() => api('PATCH', `/api/gigs/${g.id}`, { next_action_at: null }), 'Follow-up cleared'),
          open: () => setGigId(g.id),
        })),
      ].sort((a, b) => a.due.localeCompare(b.due))
    : [];

  const replies: Item[] = data
    ? data.replies.map((g): Item => ({
        key: `r-${g.id}`,
        due: g.reply_owed_by,
        tone: isBefore(g.reply_owed_by, today) ? 'overdue' : g.reply_owed_by === today ? 'today' : 'later',
        title: g.title,
        who: g.contact_name,
        note: stageLabel(g.stage),
        done: finish(() => api('PATCH', `/api/gigs/${g.id}`, { reply_owed_by: null }), 'Marked as replied'),
        open: () => setGigId(g.id),
      }))
    : [];

  const render = (items: Item[], doneLabel: string, empty: string) =>
    items.length === 0 ? (
      <p className="empty">{empty}</p>
    ) : (
      <ul className="todo">
        {items.map((i) => (
          <li key={i.key} className={i.tone}>
            <button className="todo-main" onClick={i.open}>
              <span className="todo-title">{i.title}</span>
              <span className="card-sub">{[i.who, i.note].filter(Boolean).join(', ')}</span>
            </button>
            <span className={`chip${i.tone === 'overdue' ? ' alert' : ''}`}>
              {i.due.startsWith('9999') ? 'No date' : i.due.length === 10 ? (i.tone === 'overdue' ? `Overdue, ${shortDate(i.due)}` : i.tone === 'today' ? 'Today' : shortDate(i.due)) : dueText(i.due)}
            </span>
            {canEdit && (
              <button className="btn btn-secondary" onClick={() => void i.done()}>
                {doneLabel}
              </button>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <div className="page-head">
        <h1>Follow-ups</h1>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {data && (
        <div className="two-col">
          <section aria-labelledby="fu-replies">
            <h2 id="fu-replies" className="list-head">
              Replies owed <span className="count">{replies.length}</span>
            </h2>
            {render(replies, 'Replied', 'No replies owed. Nobody is waiting on you.')}
          </section>
          <section aria-labelledby="fu-todo">
            <h2 id="fu-todo" className="list-head">
              To follow up <span className="count">{followups.length}</span>
            </h2>
            {render(followups, 'Done', 'Nothing to follow up. Add a to-do from a contact or a gig.')}
          </section>
        </div>
      )}
      {!data && !error && <p className="hint">Loading</p>}

      {gigId && (
        <GigDrawer
          id={gigId}
          canEdit={canEdit}
          onClose={() => {
            setGigId(null);
            void load();
          }}
          onSaved={() => say('Changes saved')}
          onArchived={() => {
            setGigId(null);
            say('Gig archived');
            void load();
          }}
        />
      )}
      {contactId && (
        <ContactDrawer
          key={contactId}
          id={contactId}
          canEdit={canEdit}
          onClose={() => {
            setContactId(null);
            void load();
          }}
          onSaved={() => say('Changes saved')}
          onArchived={() => {
            setContactId(null);
            void load();
          }}
          onOpenGig={(g) => setGigId(g)}
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
