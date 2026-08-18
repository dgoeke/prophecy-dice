/**
 * /sheets — named modifier profiles (§7.5). Player saves are public complete
 * snapshots; NPC and world maps are private complete current values.
 */
import { useCallback, useEffect, useState } from 'react';
import { validProfileName } from '../../core/profile.ts';
import { api, SlotInfo, TableState } from '../api';

interface ProfileRow { id: string; name: string; value: string }
interface SheetDraft {
  rows: ProfileRow[];
  defaults: Record<string, string>;
  missingDefaults: Record<string, string>;
  baseline: Record<string, number>;
}
let nextRowId = 0;
const row = (name = '', value = ''): ProfileRow => ({ id: `profile-${++nextRowId}`, name, value });
const blankDraft = (): SheetDraft => ({ rows: [], defaults: {}, missingDefaults: {}, baseline: {} });
const sameModifiers = (a: Record<string, number>, b: Record<string, number>) => {
  const aKeys = Object.keys(a); const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
};

const availableTypes = (table: TableState, slot: SlotInfo) =>
  table.registry.filter((t) => t.roles.includes(slot.role ?? '') && slot.lanes.includes(t.lane));

const draftFor = (table: TableState, slot: SlotInfo): SheetDraft => {
  const current = slot.role === 'player'
    ? table.sheets[slot.id] ?? {}
    : table.npc_sheets[slot.id] ?? {};
  const rows = Object.entries(current).map(([name, value]) => row(name, String(value)));
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  const defaults: Record<string, string> = {};
  const missingDefaults: Record<string, string> = {};
  for (const type of availableTypes(table, slot)) {
    const name = table.profile_defaults[slot.id]?.[type.id];
    const resolved = name ? byName.get(name) : undefined;
    if (name && !resolved) missingDefaults[type.id] = name;
    defaults[type.id] = resolved ?? (name ? `missing:${type.id}` : '');
  }
  return { rows, defaults, missingDefaults, baseline: { ...current } };
};

export function Sheets() {
  const [table, setTable] = useState<TableState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, SheetDraft>>({});
  const [dates, setDates] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const next = await api<TableState>('/api/table');
    setTable(next);
    setDates((old) => {
      const updated = { ...old };
      for (const slot of next.slots) updated[slot.id] ??= today;
      return updated;
    });
    setDrafts((old) => {
      const updated = { ...old };
      for (const slot of next.slots.filter((s) => s.active && !s.retired)) {
        updated[slot.id] ??= draftFor(next, slot);
      }
      return updated;
    });
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!table) return <p className="dim">…</p>;

  const today = new Date().toISOString().slice(0, 10);
  const updateDraft = (slotId: string, fn: (draft: SheetDraft) => SheetDraft) =>
    setDrafts((all) => ({ ...all, [slotId]: fn(all[slotId] ?? blankDraft()) }));

  const rename = (slotId: string, rowId: string, name: string) => updateDraft(slotId, (draft) => ({
    ...draft,
    rows: draft.rows.map((r) => r.id === rowId ? { ...r, name } : r),
  }));

  const remove = (slotId: string, rowId: string) => updateDraft(slotId, (draft) => ({
    ...draft,
    rows: draft.rows.filter((r) => r.id !== rowId),
    defaults: Object.fromEntries(Object.entries(draft.defaults)
      .map(([type, selected]) => [type, selected === rowId ? '' : selected])),
  }));

  const save = async (slot: SlotInfo) => {
    const draft = drafts[slot.id] ?? blankDraft();
    const names = draft.rows.map((r) => r.name.normalize('NFC'));
    if (names.some((name) => !validProfileName(name))) {
      setMsg(`${slot.display ?? slot.id}: profile names must be trimmed, non-empty, at most 64 characters, and contain no controls or reserved object names`);
      return;
    }
    if (new Set(names).size !== names.length) {
      setMsg(`${slot.display ?? slot.id}: profile names must be unique`);
      return;
    }
    const modifiers: Record<string, number> = {};
    for (const profile of draft.rows) {
      const canonicalName = profile.name.normalize('NFC');
      if (profile.value.trim() === '' || !Number.isInteger(Number(profile.value))) {
        setMsg(`${slot.display ?? slot.id}: ${profile.name || 'each profile'} needs an integer modifier`);
        return;
      }
      modifiers[canonicalName] = Number(profile.value);
    }
    const profilesChanged = !sameModifiers(modifiers, draft.baseline);
    if (slot.role === 'player' && profilesChanged && draft.rows.length === 0) {
      setMsg(`${slot.display ?? slot.id}: a public profile snapshot cannot be empty`);
      return;
    }
    const nameByRow = new Map(draft.rows.map((r) => [r.id, r.name.normalize('NFC')]));
    const defaults: Record<string, string> = {};
    for (const type of availableTypes(table, slot)) {
      const selected = draft.defaults[type.id] ?? '';
      const selectedName = nameByRow.get(selected);
      if (selectedName) defaults[type.id] = selectedName;
      else if (selected === `missing:${type.id}` && draft.missingDefaults[type.id]) {
        defaults[type.id] = draft.missingDefaults[type.id];
      }
    }

    const isPlayer = slot.role === 'player';
    const effective = dates[slot.id] ?? today;
    setSaving(slot.id); setMsg(null);
    try {
      await api('/api/profiles/save', {
        slot: slot.id, defaults,
        ...(profilesChanged ? {
          modifiers, ...(isPlayer ? { effective_from: effective } : {}),
        } : {}),
      });
      setMsg(isPlayer
        ? `${slot.display ?? slot.id}: defaults saved${profilesChanged ? ' with a public profile snapshot' : '; profile snapshot unchanged'}${profilesChanged && effective > today ? ` — defaults apply now; profiles become effective ${effective}` : ''}`
        : `${slot.display ?? slot.id}: private defaults saved${profilesChanged ? ' with profiles' : '; profiles unchanged'}`);
      const next = await api<TableState>('/api/table');
      setTable(next);
      const currentSlot = next.slots.find((candidate) => candidate.id === slot.id);
      if (currentSlot) setDrafts((all) => ({ ...all, [slot.id]: draftFor(next, currentSlot) }));
      if (isPlayer) setDates((all) => ({ ...all, [slot.id]: today }));
    } catch (e: any) {
      setMsg(`${slot.display ?? slot.id}: ${e.message}`);
      await refresh().catch(() => {});
    } finally { setSaving(null); }
  };

  return (
    <div>
      {msg && <p className="open-c" role="status">{msg}</p>}
      <p className="dim">Profiles are final character-sheet bonuses. Each save is a complete snapshot: deleting a row deletes that profile.</p>
      {table.slots.filter((s) => s.active && !s.retired).map((slot) => {
        const isPlayer = slot.role === 'player';
        const draft = drafts[slot.id] ?? blankDraft();
        const types = availableTypes(table, slot);
        const scheduled = isPlayer ? table.scheduled_sheets[slot.id] ?? [] : [];
        return (
          <section className="pane sheetpane" key={slot.id}>
            <h2>{slot.display ?? slot.id} <span className="eyebrow">{slot.role} · {isPlayer ? 'public snapshots' : 'private until reveal'}</span></h2>
            <div className="profile-editor">
              <div>
                <div className="eyebrow">Profiles</div>
                {draft.rows.length === 0 && <p className="faint">No profiles yet.</p>}
                {draft.rows.map((profile, i) => (
                  <div className="profile-row" key={profile.id}>
                    <input aria-label={`profile ${i + 1} name`} placeholder="Profile name" value={profile.name}
                      onChange={(e) => rename(slot.id, profile.id, e.target.value)} />
                    <input aria-label={`${profile.name || `profile ${i + 1}`} modifier`} className="profile-value"
                      inputMode="numeric" placeholder="+0" value={profile.value}
                      onChange={(e) => updateDraft(slot.id, (d) => ({ ...d, rows: d.rows.map((r) => r.id === profile.id ? { ...r, value: e.target.value } : r) }))} />
                    <button className="btn ghost" aria-label={`delete ${profile.name || `profile ${i + 1}`}`}
                      onClick={() => remove(slot.id, profile.id)}>×</button>
                  </div>
                ))}
                <button className="btn" onClick={() => updateDraft(slot.id, (d) => ({ ...d, rows: [...d.rows, row()] }))}>+ add profile</button>
              </div>
              <div>
                <div className="eyebrow">Defaults by check type</div>
                <div className="default-grid">
                  {types.map((type) => (
                    <label className="fld" key={type.id}>{type.id}
                      <select value={draft.defaults[type.id] ?? ''}
                        onChange={(e) => updateDraft(slot.id, (d) => ({ ...d, defaults: { ...d.defaults, [type.id]: e.target.value } }))}>
                        <option value="">— no default —</option>
                        {draft.missingDefaults[type.id] && <option value={`missing:${type.id}`}>
                          ⚠ missing profile: {draft.missingDefaults[type.id]}
                        </option>}
                        {draft.rows.filter((r) => validProfileName(r.name)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="sheet-actions">
              {scheduled.length > 0 && <p className="dim">A separate snapshot is scheduled for {scheduled.map((sheet) => sheet.effective_from).join(', ')}. This editor starts from the profile currently applicable to draws.</p>}
              {isPlayer && <label className="fld">effective from
                <input type="date" value={dates[slot.id] ?? today} onChange={(e) => setDates((d) => ({ ...d, [slot.id]: e.target.value }))} />
              </label>}
              <button className="btn primary" disabled={saving === slot.id} onClick={() => void save(slot)}>
                {saving === slot.id ? 'Saving…' : 'Save profiles & defaults'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
