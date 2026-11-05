import { useState, type FormEvent } from 'react';
import { api, errorText } from './api';
import type { Me, Tenant } from './types';

export function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/login', { email, password });
      onDone(await api<Me>('GET', '/api/me'));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-top">
          <h1>GW-CRM</h1>
        </div>
        <div className="auth-body">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <p className="error-text" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Signing in' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

const ROLE_TEXT: Record<Tenant['role'], string> = { admin: 'Admin', member: 'Member', read_only: 'Read-only' };

export function BandPicker({ tenants, onPick, onLogout }: { tenants: Tenant[]; onPick: (id: string) => void; onLogout: () => void }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-top">
          <h1>Choose a band</h1>
        </div>
        <div className="auth-body">
          {tenants.length === 0 ? (
            <p style={{ margin: 0 }}>Your login is not in any band yet. Ask an admin to add you.</p>
          ) : (
            <div className="band-list">
              {tenants.map((t) => (
                <button key={t.id} className="band-btn" onClick={() => onPick(t.id)}>
                  <strong>{t.name}</strong>
                  <span>{ROLE_TEXT[t.role]}</span>
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-secondary" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
