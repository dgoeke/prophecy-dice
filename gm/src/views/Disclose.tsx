/**
 * /disclose — rolling disclosure (§7.6, §4.4). The preview is mandatory:
 * everything listed becomes public and cannot be taken back.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, DEGREES, TableState } from '../api';

export function Disclose() {
  const [table, setTable] = useState<TableState | null>(null);
  const [policy, setPolicy] = useState<string>('');
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<any | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setTable(await api<TableState>('/api/table'));
    const ledger = await api('/api/ledger');
    setPolicy(ledger.entries[0]?.transcript?.disclosure_policy ?? '');
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  if (!table) return <p className="dim">…</p>;

  const lanes = Object.entries(table.lanes).sort();

  const doPreview = async (key: string) => {
    const [slot, lane] = key.split('/');
    const raw = (targets[key] ?? '').trim();
    const through = Number(raw);
    if (raw === '' || !Number.isInteger(through)) return setMsg('pick an integer target position');
    try { setPreview({ ...(await api('/api/disclose/preview', { slot, lane, through_position: through })), key }); setMsg(null); }
    catch (e: any) { setMsg(e.message); }
  };

  const commit = async () => {
    const [slot, lane] = preview.key.split('/');
    try {
      await api('/api/disclose', { slot, lane, through_position: preview.through_position });
      setPreview(null); setMsg(`${preview.key} disclosed through ${preview.through_position}`); refresh();
    } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div>
      <div className="pane">
        <h2>Standing policy</h2>
        <p className="dim">{policy || '—'}</p>
        <p className="faint">The app records the policy and shows the lag; it does not enforce a cadence. Pick watermarks far enough back that knowing the roll cannot change how the table reads a live scene.</p>
      </div>
      {msg && <p className="open-c">{msg}</p>}
      <div className="pane">
        <h2>Lanes</h2>
        <table className="grid">
          <thead><tr><th>slot/lane</th><th>drawn</th><th>disclosed through</th><th>lag</th><th>disclose through…</th><th /></tr></thead>
          <tbody>
            {lanes.map(([key, s]) => (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td className="mono">{s.drawn}</td>
                <td className="mono">{s.watermark || '—'}</td>
                <td className="mono">{s.drawn - s.watermark}</td>
                <td><input type="text" style={{ width: '5rem' }} placeholder={String(s.drawn)} value={targets[key] ?? ''}
                  onChange={(e) => setTargets((t) => ({ ...t, [key]: e.target.value }))} /></td>
                <td><button className="btn" disabled={s.drawn === 0} onClick={() => doPreview(key)}>preview</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview && (
        <div className="pane" style={{ borderColor: 'var(--rubric-deep)' }}>
          <h2 className="rubric">Preview — everything below becomes public</h2>
          <p className="dim">{preview.key} through position {preview.through_position} (currently {preview.watermark}). {preview.opened.length} sealed value(s) open. Getting this wrong is unrecoverable.</p>
          <table className="grid">
            <thead><tr><th>#</th><th>roll</th><th>mod</th><th>DC</th><th>degree</th><th>context</th></tr></thead>
            <tbody>
              {preview.draws.map((d: any) => (
                <tr key={d.seq}>
                  <td className="mono">{d.position}</td>
                  <td className="brass mono">{d.roll}</td>
                  <td className="mono">{d.modifier ?? '—'}</td>
                  <td className="mono">{d.dc ?? '—'}</td>
                  <td>{d.degree !== null ? <span className={`degree-${d.degree}`}>{DEGREES[d.degree]}</span> : '—'}</td>
                  <td className="dim">{d.context ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <footer style={{ display: 'flex', gap: '.6rem', justifyContent: 'flex-end', marginTop: '.8rem' }}>
            <button className="btn ghost" onClick={() => setPreview(null)}>cancel</button>
            <button className="btn rubric" onClick={commit}>Disclose — irreversible</button>
          </footer>
        </div>
      )}
    </div>
  );
}
