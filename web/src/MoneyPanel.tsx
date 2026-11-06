import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api';
import { dollars, STATE_LABEL, validAmount, type PayState } from './money';
import { shortDate, todayIso } from './stages';

interface Payment {
  id: string;
  kind: 'deposit' | 'balance' | 'other';
  amount: string;
  due_on: string | null;
  paid_on: string | null;
  method: string | null;
  note: string | null;
}
interface Money {
  fee: string | null;
  scheduled: string;
  received: string;
  outstanding: string;
  state: PayState;
  schedule_gap: string | null;
  payments: Payment[];
}
const KIND = { deposit: 'Deposit', balance: 'Balance', other: 'Payment' } as const;

/** On a gig: the fee, what is due, what has come in, and who paid when. All sums come from the database. */
export function MoneyPanel({ gigId, canEdit, feeKey, onChange }: { gigId: string; canEdit: boolean; feeKey: string; onChange: () => void }) {
  const [m, setM] = useState<Money | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState('50');
  const [adding, setAdding] = useState(false);
  const [add, setAdd] = useState({ kind: 'other', amount: '', due_on: '', paid_on: '', method: '' });
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payDate, setPayDate] = useState(todayIso());
  const [payMethod, setPayMethod] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      setM(await api<Money>('GET', `/api/gigs/${gigId}/money`));
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  }, [gigId]);
  // Reload when the fee or stage was saved on the gig.
  useEffect(() => {
    void load();
  }, [load, feeKey]);

  const run = async (fn: () => Promise<Money>): Promise<boolean> => {
    setBusy(true);
    try {
      setM(await fn());
      setError('');
      onChange();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!m) return error ? <div className="section"><h3>Money</h3><p className="error-text" role="alert">{error}</p></div> : null;
  const hasFee = m.fee !== null && Number(m.fee) > 0;

  return (
    <div className="section">
      <h3>Money</h3>
      <dl className="money-sum">
        <div><dt>Fee</dt><dd>{hasFee ? dollars(m.fee) : 'Not set'}</dd></div>
        <div><dt>Received</dt><dd>{dollars(m.received)}</dd></div>
        <div><dt>Still to come</dt><dd>{dollars(m.outstanding)}</dd></div>
        <div><dt>Status</dt><dd><span className={`chip${m.state === 'paid' ? '' : ' money'}`}>{STATE_LABEL[m.state]}</span></dd></div>
      </dl>
      {m.schedule_gap && (
        <p className="hint" role="status">
          {Number(m.schedule_gap) > 0 ? `${dollars(m.schedule_gap)} of the fee has no payment planned.` : `Payments planned are ${dollars(String(Math.abs(Number(m.schedule_gap))))} more than the fee.`}
        </p>
      )}

      {m.payments.length === 0 ? (
        <p className="empty">No payments yet.{canEdit && !hasFee ? ' Set a fee, save, then plan a deposit and balance.' : ''}</p>
      ) : (
        <ul className="pay-list">
          {m.payments.map((p) => (
            <li key={p.id}>
              <div className="pay-main">
                <strong>{KIND[p.kind]}</strong> {dollars(p.amount)}
                <span className="card-sub">
                  {p.paid_on ? `Paid ${shortDate(p.paid_on)}${p.method ? ` by ${p.method}` : ''}` : p.due_on ? `Due ${shortDate(p.due_on)}` : 'No due date'}
                </span>
              </div>
              {canEdit && payingId !== p.id && (
                <div className="pay-actions">
                  {p.paid_on ? (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => api<Money>('PATCH', `/api/payments/${p.id}`, { paid_on: null }))}>
                      Mark not paid
                    </button>
                  ) : (
                    <>
                      <button className="btn btn-secondary" disabled={busy} onClick={() => { setPayingId(p.id); setPayDate(todayIso()); setPayMethod(p.method ?? ''); }}>
                        Mark paid
                      </button>
                      <button className="btn btn-secondary" disabled={busy} aria-label={`Remove ${KIND[p.kind].toLowerCase()} ${dollars(p.amount)}`} onClick={() => void run(() => api<Money>('DELETE', `/api/payments/${p.id}`))}>
                        Remove
                      </button>
                    </>
                  )}
                </div>
              )}
              {payingId === p.id && (
                <div className="pay-form">
                  <div className="field">
                    <label htmlFor={`pd-${p.id}`}>Date received</label>
                    <input id={`pd-${p.id}`} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor={`pm-${p.id}`}>How</label>
                    <input id={`pm-${p.id}`} value={payMethod} placeholder="Check, Venmo, cash" onChange={(e) => setPayMethod(e.target.value)} />
                  </div>
                  <button className="btn btn-secondary" onClick={() => setPayingId(null)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    disabled={busy || !payDate}
                    onClick={() => void run(() => api<Money>('PATCH', `/api/payments/${p.id}`, { paid_on: payDate, method: payMethod })).then((ok) => ok && setPayingId(null))}
                  >
                    Save payment
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && m.payments.length === 0 && hasFee && (
        <div className="pay-form">
          <div className="field">
            <label htmlFor="pay-pct">Deposit percent</label>
            <input id="pay-pct" type="number" min="1" max="99" value={percent} onChange={(e) => setPercent(e.target.value)} />
          </div>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => api<Money>('POST', `/api/gigs/${gigId}/payments/plan`, { deposit_percent: Number(percent) }))}>
            Plan deposit and balance
          </button>
        </div>
      )}

      {canEdit && !adding && (
        <button className="btn btn-secondary" onClick={() => setAdding(true)}>
          Add a payment
        </button>
      )}
      {canEdit && adding && (
        <div className="pay-form">
          <div className="field">
            <label htmlFor="pay-kind">Type</label>
            <select id="pay-kind" value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}>
              <option value="deposit">Deposit</option>
              <option value="balance">Balance</option>
              <option value="other">Other payment</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="pay-amount">Amount</label>
            <input id="pay-amount" inputMode="decimal" placeholder="1250.00" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pay-due">Due on</label>
            <input id="pay-due" type="date" value={add.due_on} onChange={(e) => setAdd({ ...add, due_on: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pay-paid">Already paid on</label>
            <input id="pay-paid" type="date" value={add.paid_on} onChange={(e) => setAdd({ ...add, paid_on: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pay-how">How</label>
            <input id="pay-how" value={add.method} placeholder="Check, Venmo, cash" onChange={(e) => setAdd({ ...add, method: e.target.value })} />
          </div>
          <button className="btn btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !validAmount(add.amount)}
            onClick={() =>
              void run(() => api<Money>('POST', `/api/gigs/${gigId}/payments`, { kind: add.kind, amount: add.amount.trim(), due_on: add.due_on, paid_on: add.paid_on, method: add.method })).then((ok) => {
                if (ok) { setAdding(false); setAdd({ kind: 'other', amount: '', due_on: '', paid_on: '', method: '' }); }
              })
            }
          >
            Add payment
          </button>
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
