/**
 * /sheets — modifiers (§7.5). Player saves write a public sheet-update entry;
 * NPC and world modifiers stay in private state and open at final reveal.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, TableState } from '../api';

export function Sheets() {
  const [table, setTable] = useState<TableState | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [dates, setDates] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => setTable(await api<TableState>('/api/table')), []);
  useEffect(() => { refresh(); }, [refresh]);
  if (!table) return <p className="dim">…</p>;

  const today = new Date().toISOString().slice(0, 10);
  const save = async (slotId: string, isPublic: boolean, current: Record<string, number>) => {
    // Session 1 redefines saves as complete snapshots. Preserve every
    // untouched profile while this transitional check-type editor remains.
    const mods: Record<string, number> = { ...current };
    for (const [type, v] of Object.entries(edits[slotId] ?? {})) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) mods[type] = n;
    }
    try {
      await api('/api/sheet-update', {
        slot: slotId, modifiers: mods,
        ...(isPublic ? { effective_from: dates[slotId] ?? today } : {}),
      });
      setMsg(isPublic ? `${slotId}: public sheet-update written` : `${slotId}: stored privately — opens at final reveal`);
      refresh();
    } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div>
      {msg && <p className="open-c">{msg}</p>}
      <p className="dim">Auto-filled modifiers are what keep a routine draw at one keystroke — and they archive a year of level-ups better than anyone's memory.</p>
      {table.slots.filter((s) => s.active && !s.retired).map((slot) => {
        const isPublic = slot.role === 'player';
        const types = table.registry.filter((t) => t.roles.includes(slot.role ?? '') && slot.lanes.includes(t.lane));
        const current = isPublic ? table.sheets[slot.id] ?? {} : table.npc_sheets[slot.id] ?? {};
        return (
          <div className="pane" key={slot.id}>
            <h2>{slot.display ?? slot.id} <span className="eyebrow">{slot.role} · {isPublic ? 'public' : 'private until reveal'}</span></h2>
            <div style={{ display: 'flex', gap: '.8rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {types.map((t) => (
                <label className="fld" key={t.id}>{t.id}
                  <input type="text" style={{ width: '4.5rem' }}
                    placeholder={current[t.id] !== undefined ? String(current[t.id]) : '—'}
                    value={edits[slot.id]?.[t.id] ?? ''}
                    onChange={(e) => setEdits((x) => ({ ...x, [slot.id]: { ...x[slot.id], [t.id]: e.target.value } }))} />
                </label>
              ))}
              {isPublic && <label className="fld">effective from
                <input type="date" value={dates[slot.id] ?? today} onChange={(e) => setDates((d) => ({ ...d, [slot.id]: e.target.value }))} />
              </label>}
              <button className="btn primary" onClick={() => save(slot.id, isPublic, current)}>Save</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
