/**
 * /slots — roster and activation (§7.4). The UI offers ONLY the lowest
 * deferred slot, so ordered allocation is structural, not a rule to remember.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, defaultLanesForRole, Status, TableState } from '../api';

const randHex = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
// Lane defaults come from the campaign's own frozen registry, never a
// hardcoded table: see defaultLanesForRole.

export function Slots({ status }: { status: Status }) {
  const [table, setTable] = useState<TableState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ display: '', role: 'npc', lanes: '', nonce: '' });
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => setTable(await api<TableState>('/api/table')), []);
  useEffect(() => { refresh(); }, [refresh, status.entries]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  // seed the lane field from the registry once it arrives
  useEffect(() => {
    if (table && !form.lanes) {
      setForm((f) => ({ ...f, lanes: defaultLanesForRole(table.registry, f.role).join(',') }));
    }
  }, [table, form.lanes, form.role]);

  if (!table) return <p className="dim">…</p>;
  const pending = status.pending_activation;
  const waitLeft = pending ? Math.max(0, pending.round_time - Math.floor(Date.now() / 1000)) : 0;

  const run = (p: Promise<unknown>, ok?: string) =>
    p.then(() => { setMsg(ok ?? null); refresh(); }).catch((e) => setMsg(e.message));

  return (
    <div>
      {msg && <p className="rubric">{msg}</p>}
      <div className="pane">
        <h2>Active slots</h2>
        <table className="grid">
          <thead><tr><th>slot</th><th>who</th><th>role</th><th>lanes (drawn)</th><th /></tr></thead>
          <tbody>
            {table.slots.map((s) => (
              <tr key={s.id} style={s.retired ? { opacity: .55 } : undefined}>
                <td className="mono">{s.id}</td>
                <td>{s.display ?? '—'}{s.role === 'npc' && <span className="faint"> (sealed to players)</span>}{s.retired && <span className="rubric"> · retired</span>}</td>
                <td>{s.role}</td>
                <td className="mono">{s.lanes.map((l) => `${l} (${table.lanes[`${s.id}/${l}`]?.drawn ?? 0})`).join(' · ')}</td>
                <td>{!s.retired && <button className="btn ghost" onClick={() => {
                  const reason = prompt(`Retire ${s.display ?? s.id}? Reason (public):`);
                  if (reason) run(api('/api/retire-slot', { slot: s.id, reason }), 'retired');
                }}>retire</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pending ? (
        <div className="pane">
          <h2>Pending activation — {pending.slot}</h2>
          <p className="dim">The exact slot, lanes, nonce, hidden-label commitment, and future beacon round are now public and frozen. No other ledger event can occur until this activation completes.</p>
          <p className="faint">Post this full declaration head to the group chat before the round arrives:</p>
          <div className="commitment">{pending.declaration_head}</div>
          <p><button className="btn" onClick={() => navigator.clipboard?.writeText(pending.declaration_head)}>Copy full head</button></p>
          {pending.player_label_salt && <>
            <p className="faint">Give this label-verification salt privately to the joining player only. With it, their display name and role must reproduce the declaration’s <code>label_commit</code>; publishing it would reveal that this is a player activation.</p>
            <div className="commitment">{pending.player_label_salt}</div>
            <p><button className="btn" onClick={() => navigator.clipboard?.writeText(pending.player_label_salt!)}>Copy private player salt</button></p>
          </>}
          <p className="dim">Waiting on beacon round <span className="mono">{pending.round}</span>. Players should independently compare the recorded randomness with the named public drand round; the offline verifier binds the value but does not authenticate drand’s BLS signature.</p>
          {waitLeft > 0
            ? <p className="brass mono">{Math.floor(waitLeft / 60)}:{String(waitLeft % 60).padStart(2, '0')} until the round publishes</p>
            : <p className="open-c">The round should have published.</p>}
          <button className="btn primary" disabled={waitLeft > 0}
            onClick={() => run(api('/api/activation/complete', {}), 'activated')}>Fetch randomness &amp; activate</button>
        </div>
      ) : (
        <div className="pane">
          <h2>Activate {table.next_deferred ?? '— no deferred slots left'}</h2>
          <p className="dim">Only the lowest deferred slot is offered. The label seals until final reveal; a joining player should type their own nonce.</p>
          {table.next_deferred && (
            <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="fld">display (sealed)<input type="text" value={form.display} onChange={(e) => setForm((f) => ({ ...f, display: e.target.value }))} /></label>
              <label className="fld">role<select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value, lanes: defaultLanesForRole(table.registry, e.target.value).join(',') }))}>
                <option value="player">player</option><option value="npc">npc</option><option value="world">world</option></select></label>
              <label className="fld">lanes<input type="text" value={form.lanes} onChange={(e) => setForm((f) => ({ ...f, lanes: e.target.value }))} />
                {(() => {
                  // narrowing is legitimate but permanent, so say what it costs
                  const chosen = form.lanes.split(',').map((s) => s.trim()).filter(Boolean);
                  const missing = defaultLanesForRole(table.registry, form.role).filter((l) => !chosen.includes(l));
                  return missing.length ? (
                    <span className="rubric" style={{ fontSize: '.72rem' }}>
                      omits {missing.join(', ')} — this slot could never make those
                      checks, and lanes cannot be added later
                    </span>
                  ) : null;
                })()}
              </label>
              <label className="fld">nonce<input type="text" value={form.nonce} onChange={(e) => setForm((f) => ({ ...f, nonce: e.target.value }))} /></label>
              <button className="btn ghost" onClick={() => setForm((f) => ({ ...f, nonce: f.nonce + randHex() }))}>csprng</button>
              <button className="btn primary" onClick={() => run(api('/api/activation/declare', {
                display: form.display, role: form.role, nonce: form.nonce,
                lanes: form.lanes.split(',').map((s) => s.trim()).filter(Boolean),
              }), 'declared — wait for the beacon round')}>Declare</button>
            </div>
          )}
          <p className="faint" style={{ marginTop: '.6rem' }}>Activate during prep, in small batches — not the moment a scene needs it. For a genuinely unplanned roll, use the world's routine lane.</p>
        </div>
      )}
    </div>
  );
}
