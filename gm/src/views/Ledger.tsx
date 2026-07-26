/**
 * /ledger — filterable read-only view (§7.6). The histogram covers DISCLOSED
 * draws only, with the undisclosed count shown beside it — one number must
 * never pretend to cover both.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

const phi = (z: number) => 0.5 * (1 + Math.tanh(z * (0.7978845608 + 0.0356774 * z * z)));
function chi2(rolls: number[]) {
  const exp = rolls.length / 20;
  const counts = new Array(21).fill(0);
  for (const r of rolls) counts[r]++;
  let x2 = 0;
  for (let f = 1; f <= 20; f++) x2 += (counts[f] - exp) ** 2 / exp;
  const z = ((x2 / 19) ** (1 / 3) - (1 - 2 / 171)) / Math.sqrt(2 / 171);
  return { x2, p: 1 - phi(z), counts };
}

export function Ledger() {
  const [ledger, setLedger] = useState<any | null>(null);
  const [stats, setStats] = useState<{ per_slot: Record<string, number[]>; undisclosed: number } | null>(null);
  const [f, setF] = useState({ kind: '', slot: '', session: '', text: '' });

  useEffect(() => {
    api('/api/ledger').then(setLedger);
    api('/api/stats/disclosed').then(setStats).catch(() => {});
  }, []);
  const entries = ledger?.entries ?? [];

  const filtered = useMemo(() => entries.filter((e: any) =>
    (!f.kind || e.kind === f.kind) &&
    (!f.slot || e.slot === f.slot) &&
    (!f.session || String(e.session) === f.session) &&
    (!f.text || JSON.stringify(e).includes(f.text)),
  ), [entries, f]);

  const kinds = useMemo(() => [...new Set(entries.map((e: any) => e.kind))] as string[], [entries]);
  const slots = useMemo(() => [...new Set(entries.filter((e: any) => e.slot).map((e: any) => e.slot))].sort() as string[], [entries]);

  const csv = () => {
    const draws = entries.filter((e: any) => e.kind === 'draw');
    const head = 'seq,ts,session,slot,lane,position,check_type,initiator,modifier,dc,batch';
    const rows = draws.map((e: any) =>
      [e.seq, e.ts, e.session, e.slot, e.lane, e.position, e.check_type, e.initiator, e.modifier ?? '', e.dc ?? '', e.batch ?? ''].join(','));
    const blob = new Blob([head + '\n' + rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'column-draws.csv';
    a.click();
  };

  if (!ledger) return <p className="dim">…</p>;

  return (
    <div>
      <div className="pane">
        <h2>Ledger — {entries.length} entries · head <code>{String(ledger.head).slice(0, 16)}…</code></h2>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.6rem' }}>
          <select value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))}>
            <option value="">all kinds</option>{kinds.map((k) => <option key={k}>{k}</option>)}
          </select>
          <select value={f.slot} onChange={(e) => setF((x) => ({ ...x, slot: e.target.value }))}>
            <option value="">all slots</option>{slots.map((s) => <option key={s}>{s}</option>)}
          </select>
          <input type="text" placeholder="session" style={{ width: '5rem' }} value={f.session} onChange={(e) => setF((x) => ({ ...x, session: e.target.value }))} />
          <input type="text" placeholder="contains…" value={f.text} onChange={(e) => setF((x) => ({ ...x, text: e.target.value }))} />
          <button className="btn" onClick={csv}>Export draws CSV</button>
        </div>
        <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
          <table className="grid">
            <thead><tr><th>seq</th><th>ts</th><th>s.</th><th>kind</th><th>slot/lane</th><th>#</th><th>detail</th></tr></thead>
            <tbody>
              {filtered.map((e: any) => (
                <tr key={e.seq}>
                  <td className="mono">{e.seq}</td>
                  <td className="mono faint">{e.ts?.slice(5, 16)}</td>
                  <td>{e.session}</td>
                  <td className={e.kind === 'void' || e.kind === 'reveal-all' || e.kind === 'correction' ? 'rubric' : e.kind === 'disclose' ? 'open-c' : ''}>{e.kind}</td>
                  <td className="mono">{e.slot ? `${e.slot}${e.lane ? '/' + e.lane : ''}` : ''}</td>
                  <td className="mono">{e.position ?? e.through_position ?? ''}</td>
                  <td className="dim" style={{ maxWidth: '26rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.check_type ?? e.reason ?? e.text ?? (e.kind === 'sheet-update' ? JSON.stringify(e.modifiers) : '')}
                    {e.modifier !== undefined && ` · ${e.modifier >= 0 ? '+' : ''}${e.modifier}`}
                    {e.dc !== undefined && ` · DC ${e.dc}`}
                    {e.dc_commit && ' · DC sealed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {stats && (
        <div className="pane">
          <h2>Disclosed draws — distribution</h2>
          <p className="dim">Over disclosed draws only. <span className="sealed-c">{stats.undisclosed} draws remain sealed</span> and are not in these bars.</p>
          {Object.entries(stats.per_slot).map(([slot, rolls]) => {
            const c = chi2(rolls);
            return (
              <div key={slot} style={{ marginBottom: '.8rem' }}>
                <p className="mono" style={{ margin: '0 0 .2rem' }}>{slot} — n={rolls.length}, χ²={c.x2.toFixed(1)} (df 19), p={c.p.toFixed(3)}</p>
                <div className="bars20">
                  {Array.from({ length: 20 }, (_, i) => {
                    const mx = Math.max(1, ...c.counts.slice(1));
                    return <div key={i} className={i === 9 ? 'mid' : ''} title={`${i + 1}: ${c.counts[i + 1]}`} style={{ height: `${(c.counts[i + 1] / mx) * 100}%` }} />;
                  })}
                </div>
              </div>
            );
          })}
          {Object.keys(stats.per_slot).length === 0 && <p className="faint">Nothing disclosed yet.</p>}
        </div>
      )}
    </div>
  );
}
