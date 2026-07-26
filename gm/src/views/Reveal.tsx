/**
 * /reveal — the final ceremony (§7.9), behind a typed phrase. Both halves of
 * §4.6 run, then a paced walkthrough: player by player, then NPCs with labels
 * finally opened, then the world, then the unused slot reservations.
 */
import { useEffect, useState } from 'react';
import { api, DEGREES, Status } from '../api';

const PHRASE = 'open every column';

export function Reveal({ status, onChange }: { status: Status; onChange: () => void }) {
  const [typed, setTyped] = useState('');
  const [walk, setWalk] = useState<any | null>(null);
  const [page, setPage] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/reveal/walkthrough').then(setWalk).catch(() => {}); }, []);

  const begin = async () => {
    setBusy(true);
    try {
      await api('/api/final-reveal', {});
      setWalk(await api('/api/reveal/walkthrough'));
      onChange();
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  };

  if (!walk) {
    return (
      <div className="pane" style={{ maxWidth: '38rem', margin: '3rem auto', textAlign: 'center' }}>
        <h2 style={{ fontFamily: 'var(--font-ceremony)', letterSpacing: '.15em' }}>THE FINAL REVEAL</h2>
        <p className="dim">Every lane discloses to its highest position; the master secret and every sealed label are published; every column — including the ones never drawn from — becomes inspectable, forever.</p>
        <p className="dim">Type <em className="rubric">{PHRASE}</em> to unlock the button.</p>
        <p><input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: '70%', textAlign: 'center' }} /></p>
        <p><button className="btn rubric" disabled={typed.trim() !== PHRASE || busy} onClick={begin}>{busy ? 'opening…' : 'Begin the final reveal'}</button></p>
        {msg && <p className="rubric">{msg}</p>}
      </div>
    );
  }

  const pages: any[] = [...walk.slots, { never: true }];
  const cur = pages[Math.min(page, pages.length - 1)];

  return (
    <div className="walkpage">
      <div className="sectionhead">
        <span className="eyebrow">walkthrough {page + 1} / {pages.length}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← previous</button>
        <button className="btn primary" disabled={page >= pages.length - 1} onClick={() => setPage((p) => p + 1)}>next →</button>
      </div>

      {cur.never ? (
        <div className="pane">
          <h2>Unused slot reservations</h2>
          <p className="dim">{walk.never_activated.length} slots were reserved and never activated: <span className="mono">{walk.never_activated.join(', ')}</span>.</p>
          <p className="dim">No roll sequences were derived for these slots because activation never bound them to a beacon round. Their ordered reservations remain visible in the genesis record.</p>
          <p><button className="btn rubric" onClick={async () => {
            const reason = prompt('Write the closing entry. Reason (public):', 'campaign complete');
            if (reason) { await api('/api/closed', { reason }); onChange(); setMsg('closed — the ledger is complete'); }
          }}>Write `closed` — end the ledger</button> {msg && <span className="open-c">{msg}</span>}</p>
        </div>
      ) : (
        <div className="pane">
          <h2>{cur.display ?? cur.id} <span className="eyebrow">{cur.role}{cur.retired ? ' · retired' : ''}</span></h2>
          {cur.role === 'npc' && <p className="dim">Label opened at reveal: <strong>{cur.display}</strong> was <span className="mono">{cur.id}</span> all along.</p>}
          {cur.draws.length > 0 ? (
            <>
              <p className="dim">{cur.draws.length} draws · mean {cur.mean?.toFixed(2)} (uniform expects 10.50)</p>
              <div style={{ maxHeight: '44vh', overflowY: 'auto' }}>
                <table className="grid">
                  <thead><tr><th>s.</th><th>lane #</th><th>check</th><th>roll</th><th>mod</th><th>DC</th><th>degree</th><th>context</th></tr></thead>
                  <tbody>
                    {cur.draws.map((d: any) => (
                      <tr key={d.seq} style={d.corrected ? { opacity: .5, textDecoration: 'line-through' } : undefined}>
                        <td>{d.session}</td>
                        <td className="mono">{d.lane} #{d.position}</td>
                        <td className="dim">{d.check_type}</td>
                        <td className="brass mono" style={{ fontSize: '1rem' }}>{d.roll}</td>
                        <td className="mono">{d.modifier ?? '—'}</td>
                        <td className="mono">{d.dc ?? '—'}</td>
                        <td>{d.degree !== null ? <span className={`degree-${d.degree}`}>{DEGREES[d.degree]}</span> : '—'}</td>
                        <td className="faint">{d.context ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <p className="faint">No draws were ever made for this column.</p>}
          <h3 style={{ marginTop: '1rem' }}>The unconsumed remainder</h3>
          <p className="dim">This walkthrough previews up to 40 values per lane. The public verifier can export every unconsumed value after independently recomputing the columns.</p>
          {cur.lanes.map((l: any) => (
            <p key={l.lane} style={{ margin: '.3rem 0' }}>
              <span className="mono dim">{l.lane}</span> — {l.remainder_count} values never drawn:{' '}
              <span className="remainder">{l.remainder_sample.join(' ')}{l.remainder_count > l.remainder_sample.length ? ' …' : ''}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
