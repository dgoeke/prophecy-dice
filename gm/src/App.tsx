import { useCallback, useEffect, useState } from 'react';
import { api, Status } from './api';
import { Table } from './views/Table';
import { Setup } from './views/Setup';
import { Slots } from './views/Slots';
import { Sheets } from './views/Sheets';
import { Ledger } from './views/Ledger';
import { Disclose } from './views/Disclose';
import { Reveal } from './views/Reveal';

const ROUTES = ['table', 'slots', 'sheets', 'ledger', 'disclose', 'reveal'] as const;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [route, setRoute] = useState(() => (location.hash.slice(2) || 'table'));

  const refresh = useCallback(async () => {
    try { setStatus(await api<Status>('/api/status')); setErr(null); }
    catch (e: any) { setErr(e.message); }
  }, []);

  useEffect(() => {
    refresh();
    const onHash = () => setRoute(location.hash.slice(2) || 'table');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [refresh]);

  // live status: SSE when available, polling otherwise (tests, old browsers)
  useEffect(() => {
    if (location.search.includes('nosse') || !status || status.locked) return; // snapshot tooling / pre-auth
    if (typeof EventSource !== 'undefined' && !(globalThis as any).__API_BASE) {
      const es = new EventSource('/api/events');
      es.onmessage = (ev) => setStatus(JSON.parse(ev.data));
      return () => es.close();
    }
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh, status?.locked]);

  if (err) return <div className="unlock"><h1>PROPHECY DICE</h1><p className="rubric">{err}</p><button className="btn" onClick={refresh}>Retry</button></div>;
  if (!status) return <div className="unlock"><h1>PROPHECY DICE</h1><p className="keyhole">reaching the service…</p></div>;
  if (status.phase === 'empty') return <Setup status={status} onChange={refresh} />;
  if (status.locked) return <UnlockScreen status={status} onUnlocked={refresh} />;
  if (status.phase === 'precommitted') return <Setup status={status} onChange={refresh} />;

  const view =
    route === 'slots' ? <Slots status={status} /> :
    route === 'sheets' ? <Sheets /> :
    route === 'ledger' ? <Ledger /> :
    route === 'disclose' ? <Disclose /> :
    route === 'reveal' ? <Reveal status={status} onChange={refresh} /> :
    <Table status={status} onChange={refresh} />;

  return (
    <>
      {status.rehearsal && <div className="banner rehearsal">REHEARSAL — throwaway secret, publishes to an isolated directory by default, refuses mirrors, discard freely</div>}
      <header className="statusbar">
        <span className="wordmark">PROPHECY DICE</span>
        <nav className="nav">
          {ROUTES.map((r) => (
            <a key={r} href={`#/${r}`} className={route === r ? 'active' : ''}>{r}</a>
          ))}
        </nav>
        <span className="spacer" />
        {status.campaign && <span className="chip">{status.campaign} · s.{status.session}</span>}
        {(status.clients ?? 0) > 1 && <span className="chip warn">another client is connected</span>}
        {(status.unpublished ?? 0) > 0 && <span className="chip rubric">{status.unpublished} unpublished</span>}
        <button className="btn ghost" title="Lock the service (the key leaves memory)"
          onClick={async () => { await api('/api/lock', {}); refresh(); }}>lock</button>
      </header>
      {(status.unpublished ?? 0) > 0 && route === 'table' && (
        <div className="banner rubric">Unpublished entries exist — close the session and publish before the table disperses.</div>
      )}
      <main className="view">{view}</main>
    </>
  );
}

function UnlockScreen({ status, onUnlocked }: { status: Status; onUnlocked: () => void }) {
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="unlock">
      <h1>PROPHECY DICE</h1>
      <p className="keyhole">locked — the key is not in memory{status.campaign ? ` · ${status.campaign}` : ''}</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        try { await api('/api/unlock', { passphrase: pass }); onUnlocked(); }
        catch (er: any) { setMsg(er.message); }
      }}>
        <input type="password" autoFocus placeholder="passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
        <button className="btn primary" type="submit">Unlock</button>
      </form>
      {msg && <p className="rubric">{msg}</p>}
      <p className="dim" style={{ maxWidth: '28rem', textAlign: 'center', fontSize: '.82rem' }}>
        The published ledger stays readable while locked; drawing is impossible until the passphrase is entered.
      </p>
    </div>
  );
}
