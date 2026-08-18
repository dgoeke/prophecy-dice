/**
 * /table — in-session play (§7.3). This screen is a correctness requirement:
 * a routine draw is one keystroke with zero typing (acceptance criterion 4).
 *
 * Keyboard model: digits 1–5 arm players, 6–8 the NPC bench, 9/0 the world
 * (routine / deep purpose); a lowercase letter arms a check type scoped to
 * the armed slot's role; Enter draws. Arming is sticky, so repeating the
 * same check is Enter alone. `b` arms a party-wide batch, `d` edits the DC,
 * `m` is reserved for the pending manual/profile picker added in session 2;
 * `.` veils results and NPC names, `U` corrects the last draw, `O`/`C` open
 * and close the session, and `P` publishes. `m` enters a one-off manual
 * modifier and `,` cycles the armed check through the slot's profiles.
 *
 * Sealed results live only in this component's memory: after a refresh they
 * are gone, and recovering them requires the logged reveal-all (criterion 9).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, CheckType, DEGREES, laneColor, SlotInfo, Status, TableState, uuid } from '../api';

const RESERVED_KEYS = new Set(['b', 'd', 'm']);
// Ten digit keys: the world always owns 9/0, so the remaining keys split
// between the five keyboard-addressable players and the NPC scene bench.
const PLAYER_KEY_COUNT = 5;
const WORLD_KEY_COUNT = 2;
const NPC_BENCH_CAPACITY = 10 - PLAYER_KEY_COUNT - WORLD_KEY_COUNT;
const FIRST_NPC_KEY = PLAYER_KEY_COUNT + 1;
const LAST_NPC_KEY = FIRST_NPC_KEY + NPC_BENCH_CAPACITY - 1;
const HOTKEY_LEGEND = `press 1–${PLAYER_KEY_COUNT}, ${FIRST_NPC_KEY}–${LAST_NPC_KEY}, 9/0`;

export function assignTypeHotkeys(types: CheckType[]): (CheckType & { key: string })[] {
  const used = new Set(RESERVED_KEYS);
  return types.map((type) => {
    let key = '';
    for (const ch of type.id) if (/[a-z]/.test(ch) && !used.has(ch)) { key = ch; break; }
    if (key) used.add(key);
    return { ...type, key };
  });
}

interface LogLine {
  id: number; t: string; seq?: number; who: string; lane?: string; position?: number;
  desc: string; roll?: number; mod?: number; dcVal?: number; kind: 'draw' | 'void' | 'note';
  checkType?: string; openLane?: boolean; ritual?: boolean; npc?: boolean;
}

type AnnouncedOverlay = {
  mode: 'announced'; slot: string; typeId: string; announceSeq: number; context: string;
  dcVal: number | null; initiator: 'gm' | 'player'; recovered: boolean;
  dcInput?: string; manualInput?: string; manualEditing?: boolean;
};

type Overlay =
  | { mode: 'context'; slot: string; typeId: string; }
  | AnnouncedOverlay
  | { mode: 'numeral'; roll: number; mod?: number; dcVal?: number; label: string }
  | { mode: 'void'; announced: AnnouncedOverlay }
  | { mode: 'correct' }
  | { mode: 'closing' }
  | { mode: 'publish' };

export type PendingModifier =
  | { kind: 'profile'; name: string; value: number }
  | { kind: 'manual'; value: number };

interface Armed { slot: string | null; type: string | null; batch: boolean }

let logId = 0;
const nowT = () => new Date().toTimeString().slice(0, 5);
const integerText = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
};

export function Table({ status, onChange }: { status: Status; onChange: () => void | Promise<void> }) {
  const [table, setTable] = useState<TableState | null>(null);
  const [armed, setArmed] = useState<Armed>({ slot: null, type: null, batch: false });
  const [pendingModifier, setPendingModifier] = useState<PendingModifier | null>(null);
  const [manualEditing, setManualEditing] = useState(false);
  const [dc, setDc] = useState<number | null>(null);
  const [dcEditing, setDcEditing] = useState(false);
  const [pinSaving, setPinSaving] = useState(false);
  // the last announcement seq the server was observed to be holding open
  const seenAnnounce = useRef<number | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [veiled, setVeiled] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refreshTable = useCallback(async () => {
    const next = await api<TableState>('/api/table');
    setTable(next);
    return next;
  }, []);
  const say = useCallback((m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2600);
  }, []);
  useEffect(() => { refreshTable(); }, [refreshTable]);

  const registry = table?.registry ?? [];
  const typeById = useMemo(() => Object.fromEntries(registry.map((t) => [t.id, t])), [registry]);

  // An open announcement is public and resolvable only by a draw or a void.
  // Rebuild the ANNOUNCED state from the server whenever the client doesn't
  // have it — after a reload, or after a reveal the server refused — so the
  // GM is never left without a way to finish what the table already saw.
  useEffect(() => {
    if (!table) return;
    const a = table.open_announce;
    if (!a) {
      // Dismiss only an announcement this client has actually seen the
      // server holding. A bare "no open announce" is ambiguous: immediately
      // after announcing, the cached table still predates it, and dismissing
      // on that would tear down the overlay the GM just created.
      if (overlay?.mode === 'announced' && seenAnnounce.current === overlay.announceSeq) {
        seenAnnounce.current = null;
        setOverlay(null);
      }
      return;
    }
    seenAnnounce.current = a.seq;
    if (overlay) return;
    setOverlay({
      mode: 'announced', slot: a.slot, typeId: a.checkType, announceSeq: a.seq,
      context: a.context ?? typeById[a.checkType]?.label ?? a.checkType,
      // the DC is client-side until the draw seals it, so a reload cannot
      // recover it; the ANNOUNCED overlay lets it be (re-)entered instead
      dcVal: null,
      // inv 8: the resolving draw must match the announcement's initiator
      initiator: a.initiator === 'player' ? 'player' : 'gm',
      // Client-only modifier choices cannot be recovered. Require a fresh,
      // explicit choice before reveal so a reload never substitutes a default.
      recovered: true,
    });
  }, [table, overlay, typeById]);
  const slots = table?.slots ?? [];
  const players = useMemo(() => slots.filter((s) => s.active && !s.retired && s.role === 'player'), [slots]);
  const world = useMemo(() => slots.find((s) => s.active && !s.retired && s.role === 'world') ?? null, [slots]);
  const npcs = useMemo(() => slots.filter((s) => s.active && !s.retired && s.role === 'npc'), [slots]);
  // Preserve every stored pin, including legacy four-NPC benches. Only the
  // first three have digit keys; no UI interaction silently discards another.
  const pinnedBench = useMemo(() => [...new Set(table?.ui_state?.bench ?? [])]
    .filter((id) => npcs.some((n) => n.id === id)), [table, npcs]);
  const bench = useMemo(() => pinnedBench.slice(0, NPC_BENCH_CAPACITY), [pinnedBench]);
  const overflowPlayers = players.slice(PLAYER_KEY_COUNT);

  const armedSlot = slots.find((s) => s.id === armed.slot) ?? null;

  const clearPending = useCallback(() => {
    setPendingModifier(null);
    setManualEditing(false);
  }, []);

  const applyArm = useCallback((next: Armed) => {
    if (next.slot !== armed.slot || next.type !== armed.type || (!armed.batch && next.batch)) clearPending();
    setArmed(next);
  }, [armed, clearPending]);

  const profileMapFor = useCallback((slot: SlotInfo): Record<string, number> =>
    (slot.role === 'player' ? table?.sheets : table?.npc_sheets)?.[slot.id] ?? {}, [table]);
  const defaultProfileFor = useCallback((slot: SlotInfo, typeId: string): string | undefined =>
    table?.profile_defaults[slot.id]?.[typeId], [table]);
  const modifierFor = useCallback((slot: SlotInfo, typeId: string): number | undefined => {
    const profile = defaultProfileFor(slot, typeId);
    return profile === undefined ? undefined : profileMapFor(slot)[profile];
  }, [defaultProfileFor, profileMapFor]);

  const orderedProfiles = useCallback((slot: SlotInfo, typeId: string): string[] => {
    const profiles = profileMapFor(slot);
    const names = Object.keys(profiles).filter((name) => Number.isInteger(profiles[name])).sort();
    const preferred = defaultProfileFor(slot, typeId);
    return preferred && names.includes(preferred)
      ? [preferred, ...names.filter((name) => name !== preferred)] : names;
  }, [defaultProfileFor, profileMapFor]);

  const cycleProfile = useCallback((slot: SlotInfo, typeId: string) => {
    const names = orderedProfiles(slot, typeId);
    if (!names.length) { say('no saved profiles — add one on /sheets or press m'); return; }
    const current = pendingModifier?.kind === 'profile'
      ? pendingModifier.name : defaultProfileFor(slot, typeId);
    const at = current ? names.indexOf(current) : -1;
    const name = names[(at + 1 + names.length) % names.length];
    setPendingModifier({ kind: 'profile', name, value: profileMapFor(slot)[name] });
    setManualEditing(false);
  }, [pendingModifier, orderedProfiles, defaultProfileFor, profileMapFor, say]);

  const makePendingDefault = useCallback(async () => {
    if (!table || !armedSlot || !armed.type || pendingModifier?.kind !== 'profile' || armed.batch) return;
    try {
      await api('/api/profile-defaults', {
        slot: armedSlot.id,
        defaults: { ...(table.profile_defaults[armedSlot.id] ?? {}), [armed.type]: pendingModifier.name },
      });
      await refreshTable();
      say(`${pendingModifier.name} is now the default for ${armed.type}`);
    } catch (e: any) { say(e.message); }
  }, [table, armedSlot, armed, pendingModifier, refreshTable, say]);

  /** check types the armed slot can use, with stable hotkey letters. */
  const scopedTypes = useMemo(() => {
    if (!armedSlot) return [] as (CheckType & { key: string })[];
    return assignTypeHotkeys(registry
      .filter((t) => t.roles.includes(armedSlot.role ?? '') && armedSlot.lanes.includes(t.lane)));
  }, [registry, armedSlot]);

  const push = (line: Omit<LogLine, 'id' | 't'>) => setLog((l) => [{ id: ++logId, t: nowT(), ...line }, ...l].slice(0, 200));

  const armDigit = useCallback((key: string) => {
    const digit = Number(key);
    const worldType = (lane: string) =>
      registry.find((t) => t.roles.includes('world') && t.lane === lane && world?.lanes.includes(t.lane))
      ?? registry.find((t) => t.roles.includes('world') && world?.lanes.includes(t.lane));
    if (digit >= 1 && digit <= PLAYER_KEY_COUNT) {
      const p = players[digit - 1];
      if (p) applyArm({ slot: p.id, type: armed.type && typeById[armed.type]?.roles.includes('player') ? armed.type : null, batch: false });
      else say('no player assigned to that key');
    } else if (digit >= FIRST_NPC_KEY && digit <= LAST_NPC_KEY) {
      const n = npcs.find((x) => x.id === bench[digit - FIRST_NPC_KEY]);
      if (n) applyArm({ slot: n.id, type: armed.type && typeById[armed.type]?.roles.includes('npc') ? armed.type : null, batch: false });
      else say('no NPC pinned on that key — pin from the bench');
    } else if (key === '9' && world) {
      applyArm({ slot: world.id, type: worldType('routine')?.id ?? null, batch: false });
    } else if (key === '0' && world) {
      applyArm({ slot: world.id, type: worldType('deep')?.id ?? null, batch: false });
    }
  }, [players, npcs, bench, world, registry, typeById, armed, applyArm]);

  const fire = useCallback(async () => {
    if (!armed.slot || !armed.type) { say('arm a slot and a check type first'); return; }
    const type = typeById[armed.type];
    if (!type) return;
    try {
      if (armed.batch) {
        if (!type.roles.includes('player')) { say('batch draws are for player check types'); return; }
        const res = await api('/api/batch', {
          batch_id: uuid(), check_type: type.id, ...(dc !== null ? { dc } : {}),
          slots: players.map((p) => ({ slot: p.id })),
        });
        res.entries.forEach((e: any, i: number) => push({
          seq: e.seq, who: players[i]?.display ?? e.slot, lane: e.lane, position: e.position,
          desc: `${type.id} · batch`, roll: res.rolls[i], mod: res.modifiers?.[i] ?? e.modifier,
          dcVal: dc ?? undefined, kind: 'draw', checkType: type.id, openLane: e.lane === 'open',
        }));
        setArmed((a) => ({ ...a, batch: false }));
      } else if (type.ritual) {
        // an announcement is public and can only be resolved by a draw or a
        // void, so never write one we already know the draw will refuse
        if (pendingModifier === null && modifierFor(armedSlot!, type.id) === undefined) {
          say('no default profile modifier recorded — fix it on /sheets before announcing');
          return;
        }
        setOverlay({ mode: 'context', slot: armed.slot, typeId: type.id });
        return;
      } else {
        const res = await api('/api/draw', {
          draw_id: uuid(), slot: armed.slot, check_type: type.id, ...(dc !== null ? { dc } : {}),
          ...(pendingModifier?.kind === 'profile' ? { profile: pendingModifier.name }
            : pendingModifier?.kind === 'manual' ? { modifier: pendingModifier.value } : {}),
        });
        push({
          seq: res.entry.seq, who: armedSlot?.display ?? armed.slot, lane: res.entry.lane,
          position: res.entry.position, desc: type.id, roll: res.roll,
          mod: res.modifier ?? res.entry.modifier, dcVal: dc ?? undefined, kind: 'draw', checkType: type.id,
          openLane: res.entry.lane === 'open', npc: armedSlot?.role === 'npc',
        });
        clearPending();
      }
      refreshTable(); onChange();
    } catch (e: any) { say(e.message); }
  }, [armed, typeById, dc, players, armedSlot, pendingModifier, modifierFor, clearPending, refreshTable, onChange]);

  // global keyboard (§7.3.2: keyboard-first; mouse works but is not the target)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const inField = !!tgt && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tgt.tagName);
      if (overlay) return; // overlays own their keys
      if (inField) { if (e.key === 'Escape') (tgt as HTMLInputElement).blur(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // preventDefault on every handled key: several of them mount and
      // autofocus an input, and the same keydown's default text insertion
      // would otherwise land in it (e.g. a literal "d" in the DC field)
      const handled = () => {
        if (e.key >= '0' && e.key <= '9') { armDigit(e.key); return true; }
        if (e.key === 'Enter') { void fire(); return true; }
        if (e.key === '.') { setVeiled((v) => !v); return true; }
        if (e.key === 'Escape') { applyArm({ slot: null, type: null, batch: false }); return true; }
        if (e.key === 'b') {
          if (armed.type && typeById[armed.type]?.roles.includes('player')) applyArm({ ...armed, batch: true });
          else say('arm a player check type, then b for the party batch');
          return true;
        }
        if (e.key === 'd') { setDcEditing(true); return true; }
        if (e.key === 'm') {
          if (armed.batch) say('manual modifiers are disabled during a batch');
          else if (armedSlot && armed.type) setManualEditing(true);
          else say('arm a slot and a check type first');
          return true;
        }
        if (e.key === ',') {
          if (armed.batch) say('profile selection is disabled during a batch');
          else if (armedSlot && armed.type) cycleProfile(armedSlot, armed.type);
          else say('arm a slot and a check type first');
          return true;
        }
        if (e.key === 'U') { setOverlay({ mode: 'correct' }); return true; }
        if (e.key === 'P') {
          if (status.close_pending) setOverlay({ mode: 'closing' });
          else if (status.session_open) say('close the session before publishing');
          else setOverlay({ mode: 'publish' });
          return true;
        }
        if (e.key === 'C') {
          if (status.session_open || status.close_pending) setOverlay({ mode: 'closing' });
          else say('no session is open — press O to open one or P to publish');
          return true;
        }
        if (e.key === 'O') {
          if (status.close_pending) { setOverlay({ mode: 'closing' }); say('finish the pending publication first'); }
          else void api('/api/session/open', {}).then(() => { onChange(); say('session opened'); }).catch((er) => say(er.message));
          return true;
        }
        if (/^[a-z]$/.test(e.key)) {
          const t = scopedTypes.find((x) => x.key === e.key);
          if (t) { applyArm({ ...armed, type: t.id }); return true; }
        }
        return false;
      };
      if (handled()) e.preventDefault();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [overlay, armDigit, fire, armed, armedSlot, scopedTypes, typeById, status.session_open, status.close_pending, onChange, applyArm, cycleProfile, say]);

  if (!table) return <p className="dim">reaching the table…</p>;

  const armedType = armed.type ? typeById[armed.type] : null;
  const savedArmedProfile: string | undefined = armedSlot && armed.type
    ? defaultProfileFor(armedSlot, armed.type) : undefined;
  const savedArmedModifier: number | undefined = armedSlot && armed.type
    ? modifierFor(armedSlot, armed.type) : undefined;
  const displayedProfile = pendingModifier?.kind === 'profile' ? pendingModifier.name : savedArmedProfile;
  const displayedModifier = pendingModifier?.value ?? savedArmedModifier;
  // a batch is atomic: one player's missing modifier refuses the whole thing,
  // so the warning has to cover everyone it would draw for
  const batchMissing: string[] = armed.batch && armed.type
    ? players.filter((p) => modifierFor(p, armed.type!) === undefined).map((p) => p.display ?? p.id)
    : [];

  return (
    <div>
      <div className="tablewrap">
        <div>
          <div className="sectionhead"><span className="eyebrow">Players</span>
            {!status.session_open && !status.close_pending && <button className="btn" onClick={() => api('/api/session/open', {}).then(onChange).catch((e) => say(e.message))}>Open session [O]</button>}
            {status.close_pending && <button className="btn rubric" onClick={() => setOverlay({ mode: 'closing' })}>Finish publication</button>}
          </div>
          <div className="slotgrid players">
            {players.map((p, i) => (
              <SlotCard key={p.id} slot={p} digit={i < PLAYER_KEY_COUNT ? String(i + 1) : '·'} lanes={table.lanes}
                armed={armed.slot === p.id} veilName={false} veiled={veiled}
                onArm={() => applyArm({ slot: p.id, type: armed.type && typeById[armed.type]?.roles.includes('player') ? armed.type : null, batch: false })} />
            ))}
          </div>
          {overflowPlayers.length > 0 && <p className="rubric">{overflowPlayers.map((p) => p.display ?? p.id).join(', ')} {overflowPlayers.length === 1 ? 'has' : 'have'} no numeric hotkey, but {overflowPlayers.length === 1 ? 'is' : 'are'} included in party-wide batches.</p>}

          <details className="npcs">
            <summary className="sectionhead"><span className="eyebrow">NPCs — {pinnedBench.length} pinned; {bench.length}/{NPC_BENCH_CAPACITY} hotkeys</span></summary>
            <div className="slotgrid" style={{ marginTop: '.4rem' }}>
              {npcs.map((n) => {
                const pin = pinnedBench.indexOf(n.id);
                return (
                  <SlotCard key={n.id} slot={n} digit={pin >= 0 && pin < NPC_BENCH_CAPACITY ? String(FIRST_NPC_KEY + pin) : '·'} lanes={table.lanes}
                    armed={armed.slot === n.id} veilName veiled={veiled}
                    onArm={() => applyArm({ slot: n.id, type: null, batch: false })}
                    extra={
                      <button className="btn ghost" onClick={(e) => {
                        e.stopPropagation();
                        const next = pin >= 0 ? pinnedBench.filter((b) => b !== n.id) : [...pinnedBench, n.id];
                        if (pin < 0 && pinnedBench.length >= NPC_BENCH_CAPACITY) {
                          say('NPC pinned without a numeric hotkey; existing hotkeys remain unchanged');
                        }
                        setPinSaving(true);
                        api('/api/ui-state', { ...(table.ui_state ?? {}), bench: next })
                          .then(refreshTable)
                          .catch((e) => say(e.message))
                          .finally(() => setPinSaving(false));
                      }} disabled={pinSaving}>{pin >= 0 ? 'unpin' : 'pin'}</button>
                    } />
                );
              })}
              {npcs.length === 0 && <p className="faint">No NPC slots yet — activate one from <a href="#/slots">slots</a>.</p>}
            </div>
          </details>

          {world && (
            <>
              <div className="sectionhead"><span className="eyebrow">World</span></div>
              <div className="slotgrid">
                <SlotCard slot={world} digit="9·0" lanes={table.lanes} armed={armed.slot === world.id}
                  veilName={false} veiled={veiled} onArm={() => armDigit('9')}
                  note="9 routine · 0 deep" />
              </div>
            </>
          )}
        </div>

        <aside>
          <div className="sectionhead"><span className="eyebrow">Session log</span>
            {veiled && <span className="chip warn">veiled — press . to lift</span>}
          </div>
          <div className="log">
            {log.length === 0 && <p className="faint" style={{ fontSize: '.8rem' }}>Draws land here. Results live only on this screen — a refresh forgets them, and recovering them is a logged reveal-all.</p>}
            {log.map((l) => (
              <div key={l.id} className={'line' + (l.kind === 'void' ? ' voided' : '') + (l.openLane ? ' openlane' : '')}>
                <span className="t">{l.t}</span>
                <span className="desc">
                  <span className={l.npc ? 'veilable' + (veiled ? ' veiled' : '') : ''}>{l.who}</span>
                  {l.lane !== undefined && <span className="faint"> · {l.lane} #{l.position}</span>}
                  <span className="dim"> · {l.desc}</span>
                  {l.mod !== undefined && <span className="dim"> {l.mod >= 0 ? `+${l.mod}` : l.mod}</span>}
                  {l.dcVal !== undefined && <span className="faint"> vs DC {l.dcVal}</span>}
                </span>
                {l.roll !== undefined && <span className={'roll veilable' + (veiled ? ' veiled' : '')}>{l.roll}</span>}
              </div>
            ))}
          </div>
        </aside>
      </div>

      <div className="armedbar">
        <span className="who">{armedSlot
          ? <span className={armedSlot.role === 'npc' ? 'veilable' + (veiled ? ' veiled' : '') : ''}>{armedSlot.display ?? armedSlot.id}</span>
          : <span className="faint">{HOTKEY_LEGEND}</span>}{armed.batch && <span className="brass"> ×{players.length} batch</span>}</span>
        {scopedTypes.map((t, i) => (
          <Fragment key={t.id}>
            {armedSlot?.role === 'player' && i > 0 && scopedTypes[i - 1].ritual && !t.ritual
              && <span className="type-divider" title="major / routine" aria-label="major / routine divider" />}
            <button className={'typechip' + (armed.type === t.id ? ' armed' : '')}
              onClick={() => applyArm({ ...armed, type: t.id })}>
              <span className="keycap">{t.key || '·'}</span>{t.id}{t.ritual && <span className="rubricdot" title="ritual: announce, then reveal" />}
            </button>
          </Fragment>
        ))}
        {armedSlot && (
          // A draw is refused outright without a modifier, so it must be
          // visible before Enter rather than discovered by the error.
          <span className={'typechip dcchip' + (displayedModifier === undefined ? ' armed' : '')}>
            <span className="keycap">,</span><span className="keycap">m</span>mod{' '}
            <span className="modifier-actions">
              {manualEditing
                ? <input autoFocus aria-label="manual modifier" defaultValue={pendingModifier?.kind === 'manual' ? pendingModifier.value : ''}
                    onBlur={() => setManualEditing(false)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const raw = (e.target as HTMLInputElement).value.trim();
                        const value = Number(raw);
                        if (raw !== '' && Number.isInteger(value)) {
                          setPendingModifier({ kind: 'manual', value }); setManualEditing(false);
                        } else say('manual modifier must be an integer');
                      }
                      if (e.key === 'Escape') setManualEditing(false);
                    }} />
                : <button className={'btn ghost' + (displayedModifier === undefined ? ' rubric' : '')}
                    disabled={armed.batch || !armed.type}
                    title={displayedModifier === undefined
                      ? 'no default profile modifier recorded — a draw will be refused'
                      : pendingModifier?.kind === 'manual' ? 'manual override'
                        : `${pendingModifier ? 'pending profile' : 'from profile'} ${displayedProfile}`}
                    onClick={() => armed.type && cycleProfile(armedSlot, armed.type)}>
                    {displayedModifier === undefined ? 'not set'
                      : pendingModifier?.kind === 'manual' ? `manual ${displayedModifier >= 0 ? `+${displayedModifier}` : displayedModifier}`
                        : `${displayedProfile} ${displayedModifier >= 0 ? `+${displayedModifier}` : displayedModifier}`}
                  </button>}
              {!manualEditing && <button className="btn ghost" disabled={armed.batch || !armed.type}
                onClick={() => setManualEditing(true)}>manual</button>}
              {pendingModifier?.kind === 'profile' && pendingModifier.name !== savedArmedProfile && !armed.batch
                && <button className="btn ghost" onClick={() => void makePendingDefault()}>make default</button>}
            </span>
          </span>
        )}
        {armedSlot && (
          <span className="typechip dcchip">
            <span className="keycap">d</span>DC{' '}
            {dcEditing
              ? <input autoFocus aria-label="DC" defaultValue={dc ?? ''}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => setDcEditing(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const raw = (e.target as HTMLInputElement).value;
                      const value = integerText(raw);
                      if (raw.trim() !== '' && value === null) { say('DC must be an integer'); return; }
                      setDc(value); setDcEditing(false);
                    }
                    if (e.key === 'Escape') { setDc(null); setDcEditing(false); }
                  }} />
              : <button className="btn ghost" onClick={() => setDcEditing(true)}>{dc ?? '—'}</button>}
          </span>
        )}
        {batchMissing.length > 0 && (
          <span className="flash">batch needs a modifier for {batchMissing.join(', ')}</span>
        )}
        {flash && <span className="flash">{flash}</span>}
        <span className="hint">Enter draws{armedType?.ritual ? ' → announce' : ''} · , profile · m manual · d DC · b batch · . veil · U correct · C close &amp; publish</span>
      </div>

      {overlay && <OverlayHost overlay={overlay} setOverlay={setOverlay} table={table} status={status}
        typeById={typeById} dc={dc} push={push} say={say}
        pendingModifier={pendingModifier} setPendingModifier={setPendingModifier} clearPending={clearPending}
        refresh={async () => { const next = await refreshTable(); await onChange(); return next; }} log={log} />}
    </div>
  );
}

/* ---------------- slot card with its colonnade of columns ----------------- */

function SlotCard({ slot, digit, lanes, armed, onArm, veiled, veilName, note, extra }: {
  slot: SlotInfo; digit: string; lanes: TableState['lanes']; armed: boolean;
  onArm: () => void; veiled: boolean; veilName: boolean; note?: string; extra?: any;
}) {
  return (
    <div className={'slotcard' + (armed ? ' armed' : '')}>
      <button className="slotarm" onClick={onArm}>
        <span className="colonnade">
        {slot.lanes.map((lane) => {
          const st = lanes[`${slot.id}/${lane}`] ?? { drawn: 0, remaining: 1, watermark: 0 };
          const total = st.drawn + st.remaining;
          const ash = total ? Math.max((st.drawn / total) * 100, st.drawn > 0 ? 4 : 0) : 0;
          return (
            <span key={lane} className="colgauge" style={{ ['--lane-color' as any]: laneColor(lane) }}
              title={`${lane}: ${st.drawn} drawn of ${total}, disclosed through ${st.watermark}`}>
              <span className="ashfill" style={{ height: `${ash}%` }} />
              {st.watermark > 0 && <span className="tick" style={{ top: `${(st.watermark / total) * 100}%` }} />}
            </span>
          );
        })}
        </span>
        <span className="body">
        <span className="name">
          <span className={veilName ? 'veilable' + (veiled ? ' veiled' : '') : ''}>{slot.display ?? slot.id}</span>
          <span className="eyebrow">{slot.role}</span>
        </span>
        <span className="lanes">
          {slot.lanes.map((lane) => (
            <span key={lane}>{lane} <span className="brass">{lanes[`${slot.id}/${lane}`]?.drawn ?? 0}</span></span>
          ))}
          {note && <span className="faint">{note}</span>}
        </span>
        </span>
        <span className="keycap">{digit}</span>
      </button>
      {extra}
    </div>
  );
}

/* ----------------------------- overlays ----------------------------------- */

function OverlayHost(props: {
  overlay: Overlay; setOverlay: (o: Overlay | null) => void; table: TableState;
  status: Status; typeById: Record<string, CheckType>;
  dc: number | null; push: (l: any) => void; say: (m: string) => void; refresh: () => Promise<TableState>;
  log: LogLine[]; pendingModifier: PendingModifier | null;
  setPendingModifier: (pending: PendingModifier | null) => void; clearPending: () => void;
}) {
  const { overlay, setOverlay, table, typeById, push, say, refresh, log } = props;
  const close = () => setOverlay(null);
  const slotName = (id: string) => table.slots.find((s) => s.id === id)?.display ?? id;

  if (overlay.mode === 'context') return <ContextSheet {...{ overlay, setOverlay, typeById, close, say, refresh, dc: props.dc }} slotName={slotName(overlay.slot)} />;
  if (overlay.mode === 'announced') return <Announced {...{ overlay, setOverlay, typeById, table, push, say, refresh, close,
    pendingModifier: props.pendingModifier, setPendingModifier: props.setPendingModifier, clearPending: props.clearPending }} slotName={slotName(overlay.slot)} />;
  if (overlay.mode === 'numeral') {
    const total = overlay.mod !== undefined ? overlay.roll + overlay.mod : null;
    const degree = total !== null && overlay.dcVal !== undefined
      ? (() => { let d = total >= overlay.dcVal! + 10 ? 3 : total >= overlay.dcVal! ? 2 : total <= overlay.dcVal! - 10 ? 0 : 1; if (overlay.roll === 20) d = Math.min(d + 1, 3); if (overlay.roll === 1) d = Math.max(d - 1, 0); return d; })()
      : null;
    return (
      <div className="overlay" tabIndex={-1} ref={(el) => el?.focus()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') close(); }} onClick={close}>
        <div className="ceremony">
          <div className="numeral">{total ?? overlay.roll}</div>
          <div className="sub">
            {overlay.label}
            {total !== null && <> · {overlay.roll} {overlay.mod! >= 0 ? `+${overlay.mod}` : overlay.mod} = {total}</>}
            {overlay.dcVal !== undefined && <> vs DC {overlay.dcVal}</>}
            {degree !== null && <> — <span className={`degree-${degree}`}>{DEGREES[degree]}</span></>}
          </div>
          <div className="sub faint">Enter to continue</div>
        </div>
      </div>
    );
  }
  if (overlay.mode === 'void') return <VoidSheet {...{ overlay, setOverlay, push, say, refresh, clearPending: props.clearPending }} slotName={slotName(overlay.announced.slot)} />;
  if (overlay.mode === 'correct') return <CorrectSheet {...{ log, table, push, say, refresh, close }} />;
  if (overlay.mode === 'closing') return <CloseSession {...{ status: props.status, close, say, refresh }} />;
  if (overlay.mode === 'publish') return <PublishSheet {...{ close, say, refresh }} />;
  return null;
}

function ContextSheet({ overlay, setOverlay, typeById, close, say, refresh, dc, slotName }: any) {
  const type = typeById[overlay.typeId];
  const [context, setContext] = useState<string>(type.label);
  const [initiator, setInitiator] = useState<'gm' | 'player'>('gm');
  const [dcVal, setDcVal] = useState<string>(dc !== null && dc !== undefined ? String(dc) : '');
  const announce = async () => {
    const parsedDc = integerText(dcVal);
    if (dcVal.trim() !== '' && parsedDc === null) { say('DC must be an integer'); return; }
    try {
      const entry = await api('/api/announce', { slot: overlay.slot, check_type: type.id, context, initiator });
      setOverlay({
        mode: 'announced', slot: overlay.slot, typeId: type.id,
        announceSeq: entry.seq, context,
        dcVal: parsedDc, initiator, recovered: false,
      });
      try { await refresh(); } catch (e: any) { say(`announced; refresh failed: ${e.message}`); }
    } catch (e: any) { say(e.message); close(); }
  };
  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="ceremony" style={{ width: 'min(92vw, 34rem)' }}>
        <div className="word" style={{ color: 'var(--ink-dim)', fontSize: '1rem' }}>RITUAL DRAW — {slotName}</div>
        <p className="sub">{type.label}</p>
        <input type="text" autoFocus value={context} onChange={(e) => setContext(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void announce(); }} />
        <div className="initiator">
          <button className={'btn' + (initiator === 'gm' ? ' primary' : '')} onClick={() => setInitiator('gm')}>GM asks</button>
          <button className={'btn' + (initiator === 'player' ? ' primary' : '')} onClick={() => setInitiator('player')}>Player asks</button>
          <span className="typechip dcchip">DC <input value={dcVal} onChange={(e) => setDcVal(e.target.value)} style={{ width: '3rem' }} /></span>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={close}>Esc — abandon quietly (nothing written)</button>
          <button className="btn rubric" onClick={announce}>Announce</button>
        </div>
      </div>
    </div>
  );
}

function Announced({ overlay, setOverlay, typeById, table, push, say, refresh, slotName,
  pendingModifier, setPendingModifier, clearPending }: any) {
  const type = typeById[overlay.typeId];
  const slot = table.slots.find((s: SlotInfo) => s.id === overlay.slot);
  const profiles: Record<string, number> = slot
    ? (slot.role === 'player' ? table.sheets : table.npc_sheets)[slot.id] ?? {} : {};
  const defaultName: string | undefined = table.profile_defaults[overlay.slot]?.[type.id];
  const names = Object.keys(profiles).filter((name) => Number.isInteger(profiles[name])).sort();
  const ordered = defaultName && names.includes(defaultName)
    ? [defaultName, ...names.filter((name) => name !== defaultName)] : names;
  const [manualEditing, setManualEditing] = useState(overlay.manualEditing ?? false);
  const [manualInput, setManualInput] = useState(
    overlay.manualInput ?? (pendingModifier?.kind === 'manual' ? String(pendingModifier.value) : ''),
  );
  const [dcInput, setDcInput] = useState(
    overlay.dcInput ?? (overlay.dcVal === null ? '' : String(overlay.dcVal)),
  );
  const overlayRef = useRef<HTMLDivElement>(null);
  // Give the keyboard ceremony its initial focus, and reclaim it whenever a
  // profile/manual choice finishes. The focused manual input unmounts on
  // Enter/Escape; without this handoff focus falls back to <body> and the
  // overlay-local m/,/v/Enter hotkeys appear dead until it is clicked. Do not
  // run while manual editing is active: controlled input renders must retain
  // their own focus.
  useEffect(() => {
    if (!manualEditing) overlayRef.current?.focus();
  }, [manualEditing, pendingModifier]);
  const manualValue = manualEditing ? integerText(manualInput) : null;
  const confirmed = manualEditing
    ? manualInput.trim() !== '' && manualValue !== null
    : !overlay.recovered || pendingModifier !== null;

  const chooseProfile = (name: string) => {
    if (!Number.isInteger(profiles[name])) { say(`profile ${name} has no integer modifier`); return; }
    setPendingModifier({ kind: 'profile', name, value: profiles[name] });
    setManualEditing(false);
    setManualInput('');
  };
  const cycle = () => {
    if (!ordered.length) { say('no saved profiles — press m for a manual modifier'); return; }
    const current = pendingModifier?.kind === 'profile' ? pendingModifier.name : defaultName;
    const at = current ? ordered.indexOf(current) : -1;
    chooseProfile(ordered[(at + 1 + ordered.length) % ordered.length]);
  };
  const enterVoid = () => setOverlay({
    mode: 'void',
    announced: { ...overlay, dcInput, manualInput, manualEditing },
  });
  const reveal = async () => {
    if (manualEditing && manualValue === null) { say('manual modifier must be an integer'); return; }
    if (!confirmed) { say('confirm a modifier before revealing this recovered announcement'); return; }
    const dcValue = integerText(dcInput);
    if (dcInput.trim() !== '' && dcValue === null) { say('DC must be an integer'); return; }
    try {
      const res = await api('/api/draw', {
        draw_id: uuid(), slot: overlay.slot, check_type: type.id,
        announce_seq: overlay.announceSeq, initiator: overlay.initiator,
        ...(dcValue !== null ? { dc: dcValue } : {}),
        ...(manualEditing ? { modifier: manualValue }
          : pendingModifier?.kind === 'profile' ? { profile: pendingModifier.name }
            : pendingModifier?.kind === 'manual' ? { modifier: pendingModifier.value } : {}),
      });
      push({ seq: res.entry.seq, who: slotName, lane: res.entry.lane, position: res.entry.position, desc: `${type.id} · ritual`, checkType: type.id, roll: res.roll, mod: res.modifier ?? res.entry.modifier, dcVal: dcValue ?? undefined, kind: 'draw', ritual: true });
      clearPending();
      refresh();
      setOverlay({ mode: 'numeral', roll: res.roll, mod: res.modifier ?? res.entry.modifier, dcVal: dcValue ?? undefined, label: `${slotName} · ${type.label}` });
    } catch (e: any) {
      // stay on ANNOUNCED: the announcement is public and still unresolved,
      // so the GM must keep both Reveal and Void within reach
      say(e.message);
    }
  };
  return (
    <div className="overlay" tabIndex={-1} ref={overlayRef}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
          if (e.key === 'Enter' && target.getAttribute('aria-label') === 'ritual DC') {
            e.preventDefault(); void reveal();
          }
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); void reveal(); }
        if (e.key === ',') { e.preventDefault(); cycle(); }
        if (e.key === 'm') { e.preventDefault(); setManualEditing(true); }
        if (e.key === 'v') { e.preventDefault(); enterVoid(); }
      }}>
      <div className="ceremony">
        <div className="word">ANNOUNCED</div>
        <div className="sealdisc">{type.label}</div>
        <p className="sub">{overlay.context}</p>
        {/* The DC is sealed by the draw, not the announcement, so it can be
            set or corrected here — which is also how a ritual recovered
            after a reload gets the DC its client-side state lost. */}
        <p className="sub">
          <span className="typechip dcchip">DC{' '}
            <input aria-label="ritual DC" style={{ width: '3.5rem' }} value={dcInput}
              onChange={(e) => setDcInput(e.target.value)} />
          </span>
        </p>
        <div className="modifier-actions" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          <span className="typechip">
            <span className="keycap">,</span>profile{' '}
            <select aria-label="ritual profile" value={pendingModifier?.kind === 'profile' ? pendingModifier.name : ''}
              onChange={(e) => e.target.value && chooseProfile(e.target.value)}>
              <option value="">— choose —</option>
              {ordered.map((name) => <option key={name} value={name}>{name} {profiles[name] >= 0 ? `+${profiles[name]}` : profiles[name]}</option>)}
            </select>
          </span>
          {manualEditing
            ? <span className="typechip"><span className="keycap">m</span>
                <input autoFocus aria-label="ritual manual modifier" value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault(); e.stopPropagation();
                      if (manualValue !== null && manualInput.trim() !== '') {
                        setPendingModifier({ kind: 'manual', value: manualValue });
                        setManualEditing(false);
                      } else say('manual modifier must be an integer');
                    }
                    if (e.key === 'Escape') { e.stopPropagation(); setManualEditing(false); }
                  }} />
              </span>
            : <button className="btn" onClick={() => setManualEditing(true)}>m — manual</button>}
          <button className="btn" disabled={!defaultName || !Number.isInteger(profiles[defaultName])}
            onClick={() => defaultName && chooseProfile(defaultName)}>use current default</button>
        </div>
        <p className={'sub ' + (confirmed ? 'open-c' : 'rubric')}>
          {pendingModifier?.kind === 'profile'
            ? `Selected ${pendingModifier.name} ${pendingModifier.value >= 0 ? `+${pendingModifier.value}` : pendingModifier.value}`
            : pendingModifier?.kind === 'manual'
              ? `Selected manual ${pendingModifier.value >= 0 ? `+${pendingModifier.value}` : pendingModifier.value}`
              : overlay.recovered ? 'Confirm a modifier before Reveal.'
                : `Current default: ${defaultName ?? 'not set'}${defaultName && Number.isInteger(profiles[defaultName]) ? ` ${profiles[defaultName] >= 0 ? '+' : ''}${profiles[defaultName]}` : ''}`}
        </p>
        <div className="actions">
          <button className="btn primary" disabled={!confirmed} onClick={reveal}>Reveal — Enter</button>
          <button className="btn rubric" onClick={enterVoid}>Void — v</button>
        </div>
        <p className="sub faint">The announcement is public. Only reveal or void can follow it.</p>
      </div>
    </div>
  );
}

function VoidSheet({ overlay, setOverlay, push, say, refresh, slotName, clearPending }: any) {
  const [reason, setReason] = useState('');
  const back = () => setOverlay(overlay.announced);
  const doVoid = async () => {
    try {
      await api('/api/void', { announce_seq: overlay.announced.announceSeq, reason: reason || 'abandoned' });
      push({ who: slotName, desc: `VOID — ${reason || 'abandoned'}`, kind: 'void' });
      // await before closing: the recovery effect reads open_announce, and a
      // stale read would resurrect ANNOUNCED for the ritual just voided
      await refresh();
      clearPending();
      setOverlay(null);
    } catch (e: any) {
      say(e.message);
      try {
        const next = await refresh();
        if (next.open_announce?.seq === overlay.announced.announceSeq) back();
        else { clearPending(); setOverlay(null); }
      } catch { back(); }
    }
  };
  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape') back(); }}>
      <div className="ceremony">
        <div className="word">VOID</div>
        <p className="sub">This writes a public void the table will see. The reserved position stays unconsumed.</p>
        <input type="text" autoFocus placeholder="why (public)" value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doVoid(); }} />
        <div className="actions">
          <button className="btn ghost" onClick={back}>back</button>
          <button className="btn rubric" onClick={doVoid}>Write the void</button>
        </div>
      </div>
    </div>
  );
}

function CorrectSheet({ log, table, push, say, refresh, close }: any) {
  const last = log.find((l: LogLine) => l.kind === 'draw' && l.seq !== undefined);
  const [reason, setReason] = useState('drew on the wrong slot');
  const [redraw, setRedraw] = useState<string>('');
  const [profile, setProfile] = useState('');
  const [manual, setManual] = useState('');
  const [replacementSeq, setReplacementSeq] = useState<number | null>(null);
  const [drawStarted, setDrawStarted] = useState(false);
  const [working, setWorking] = useState(false);
  const replacementDrawId = useRef(uuid());
  const type = last?.checkType ? table.registry.find((t: CheckType) => t.id === last.checkType) : null;
  const targets = type ? table.slots.filter((s: SlotInfo) => s.active && !s.retired
    && type.roles.includes(s.role ?? '') && s.lanes.includes(type.lane)) : [];
  const target = targets.find((s: SlotInfo) => s.id === redraw);
  const profiles: Record<string, number> = target
    ? (target.role === 'player' ? table.sheets : table.npc_sheets)[target.id] ?? {} : {};
  const manualValue = integerText(manual);
  const choiceValid = profile !== '' && Number.isInteger(profiles[profile])
    || manual.trim() !== '' && manualValue !== null;
  if (!last) return <div className="overlay" onClick={close}><div className="dialog"><p>No draw in this session's log to correct.</p></div></div>;
  const submit = async () => {
    if (redraw && !choiceValid) { say('explicitly choose a profile or enter an integer manual modifier'); return; }
    setWorking(true);
    let attemptedReplacement = replacementSeq ?? undefined;
    try {
      if (redraw && attemptedReplacement === undefined) {
        const typeId = last.checkType!;
        setDrawStarted(true);
        const res = await api('/api/draw', {
          draw_id: replacementDrawId.current, slot: redraw, check_type: typeId,
          ...(last.dcVal !== undefined ? { dc: last.dcVal } : {}),
          ...(profile ? { profile } : { modifier: manualValue }),
        });
        const replacement = res.entry.seq as number;
        attemptedReplacement = replacement;
        setReplacementSeq(replacement);
        if (!res.replay) push({ seq: res.entry.seq, who: target?.display ?? redraw, lane: res.entry.lane, position: res.entry.position, desc: `${typeId} · redraw`, checkType: typeId, roll: res.roll, mod: res.modifier, dcVal: last.dcVal, kind: 'draw' });
      }
      await api('/api/correction', { target_seq: last.seq, reason, ...(attemptedReplacement !== undefined ? { replacement_seq: attemptedReplacement } : {}) });
      push({ who: last.who, desc: `corrected seq ${last.seq} — the value stays burned`, kind: 'void' });
      await refresh(); close();
    } catch (e: any) {
      try {
        const ledger = await api<{ entries: any[] }>('/api/ledger');
        const landed = ledger.entries.find((entry) => entry.kind === 'correction'
          && entry.target_seq === last.seq
          && (attemptedReplacement === undefined || entry.replacement_seq === attemptedReplacement));
        if (landed) {
          push({ who: last.who, desc: `corrected seq ${last.seq} — the value stays burned`, kind: 'void' });
          await refresh(); close(); return;
        }
      } catch { /* retain the retryable dialog */ }
      if (attemptedReplacement === undefined && Number.isInteger(e?.status)) {
        setDrawStarted(false);
        replacementDrawId.current = uuid();
      }
      say(e.message);
    } finally { setWorking(false); }
  };
  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="dialog">
        <h2>Correct the last draw</h2>
        <p className="dim">seq {last.seq} · {last.who} · {last.desc}. The position is consumed and stays consumed — this marks it misattributed, publicly.</p>
        <div className="row"><label className="fld">reason (public)<input type="text" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></label></div>
        <div className="row">
          <span className="dim">redraw correctly on:</span>
          <select disabled={type?.ritual || drawStarted} value={redraw} onChange={(e) => { setRedraw(e.target.value); setProfile(''); setManual(''); }}>
            <option value="">— no redraw —</option>
            {targets.map((p: SlotInfo) => <option key={p.id} value={p.id}>{p.display ?? p.id}</option>)}
          </select>
        </div>
        {type?.ritual && <p className="rubric">Ritual corrections need a fresh announcement; this dialog can only mark the original draw.</p>}
        {redraw && <div className="row">
          <label className="fld">profile
            <select aria-label="correction profile" disabled={drawStarted} value={profile} onChange={(e) => { setProfile(e.target.value); setManual(''); }}>
              <option value="">— explicitly choose —</option>
              {Object.keys(profiles).sort().map((name) => <option key={name} value={name}>{name} {profiles[name] >= 0 ? '+' : ''}{profiles[name]}</option>)}
            </select>
          </label>
          <label className="fld">or manual modifier
            <input aria-label="correction manual modifier" disabled={drawStarted} value={manual}
              onChange={(e) => { setManual(e.target.value); setProfile(''); }} />
          </label>
        </div>}
        <footer>
          <button className="btn ghost" onClick={close}>cancel</button>
          <button className="btn rubric" disabled={working || !!redraw && !choiceValid} onClick={submit}>{replacementSeq === null ? 'Write correction' : 'Retry correction'}</button>
        </footer>
      </div>
    </div>
  );
}

function CloseSession({ status, close, say, refresh }: any) {
  const [dcless, setDcless] = useState<any[] | null>(null);
  const [stage, setStage] = useState<'review' | 'done'>('review');
  const [digest, setDigest] = useState<string | null>(null);
  const [dcInputs, setDcInputs] = useState<Record<number, string>>({});
  const [working, setWorking] = useState(false);
  const recovery = !!status.close_pending && !status.session_open;
  const targetSession = recovery ? status.close_pending_session : status.session;

  useEffect(() => {
    if (recovery) { setDcless([]); return; }
    (async () => {
      const ledger = await api('/api/ledger');
      const lates = new Set(ledger.entries.filter((e: any) => e.kind === 'dc-late').map((e: any) => e.target_seq));
      setDcless(ledger.entries.filter((e: any) =>
        e.kind === 'draw' && e.session === status.session && !('dc' in e) && !('dc_commit' in e) && !lates.has(e.seq)));
    })();
  }, [status.session, recovery]);

  const sealDc = async (seq: number) => {
    const raw = (dcInputs[seq] ?? '').trim();
    const v = Number(raw);
    if (raw === '' || !Number.isInteger(v)) return say('enter an integer DC first');
    setWorking(true);
    try {
      await api('/api/dc-late', { target_seq: seq, dc: v });
      setDcless((d) => d!.filter((e) => e.seq !== seq));
    } catch (e: any) { say(e.message); }
    finally { setWorking(false); }
  };

  const closeAndPublish = async () => {
    if (dcless === null) return say('still checking for missing DCs');
    const supplied: { seq: number; dc: number }[] = [];
    for (const entry of dcless) {
      const raw = (dcInputs[entry.seq] ?? '').trim();
      if (raw === '') continue;
      const dc = Number(raw);
      if (!Number.isInteger(dc)) return say(`DC for #${entry.seq} must be an integer`);
      supplied.push({ seq: entry.seq, dc });
    }
    setWorking(true);
    try {
      const pub = await api('/api/session/close-and-publish', {
        session: targetSession,
        late_dcs: supplied.map((item) => ({ target_seq: item.seq, dc: item.dc })),
      });
      const witness = pub.mirror === 'ok'
        ? 'mirror command succeeded — confirm the remote commit and post this head'
        : pub.mirror?.startsWith('failed')
          ? `WARNING: mirror command failed — post this head now (${pub.mirror})`
          : 'no mirror command configured — post this head now';
      setDigest(`${pub.digest}\n${witness}`);
      await refresh();
      setStage('done');
    } catch (e: any) { say(e.message); }
    finally { setWorking(false); }
  };

  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="dialog">
        <h2>{recovery ? `Recover publication for session ${targetSession}` : `Close session ${status.session} & publish`}</h2>
        {stage === 'review' && (
          <>
            {recovery
              ? <p className="dim">The session is already durably closed. Retry only the frozen export and mirror ceremony; no ledger values can be changed.</p>
              : <p className="dim">Draws still missing a DC — seal them now or leave them DC-less forever:</p>}
            {!recovery && (dcless === null ? <p className="faint">checking…</p> : dcless.length === 0
              ? <p className="open-c">Every draw this session has its DC.</p>
              : dcless.map((e) => (
                <div className="row" key={e.seq}>
                  <span className="mono">#{e.seq} {e.slot}/{e.lane} pos {e.position} · {e.check_type}</span>
                  <input aria-label={`DC for draw ${e.seq}`} style={{ width: '4rem' }} placeholder="DC"
                    disabled={working} value={dcInputs[e.seq] ?? ''}
                    onChange={(ev) => setDcInputs((d) => ({ ...d, [e.seq]: ev.target.value }))} />
                  <button className="btn" disabled={working} onClick={() => sealDc(e.seq)}>seal DC</button>
                </div>
              )))}
            <footer>
              <button className="btn ghost" disabled={working} onClick={close}>not yet</button>
              <button className="btn primary" disabled={dcless === null || working || !Number.isInteger(targetSession)} onClick={closeAndPublish}>{recovery ? 'Retry publication' : 'Close, disclose open lanes, publish'}</button>
            </footer>
          </>
        )}
        {stage === 'done' && (
          <>
            <p className="open-c">Published. Post this digest to the group chat — it is the external anchor:</p>
            <textarea readOnly rows={4} value={digest ?? ''} onFocus={(e) => e.target.select()} />
            <footer>
              <button className="btn" onClick={() => { navigator.clipboard?.writeText(digest ?? ''); say('digest copied'); }}>Copy</button>
              <button className="btn primary" onClick={close}>Done</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function PublishSheet({ close, say, refresh }: any) {
  const [digest, setDigest] = useState<string | null>(null);
  useEffect(() => {
    api('/api/publish', {}).then((pub) => {
      const witness = pub.mirror === 'ok'
        ? 'mirror command succeeded — confirm the remote commit and post this head'
        : pub.mirror?.startsWith('failed')
          ? `WARNING: mirror command failed — post this head now (${pub.mirror})`
          : 'no mirror command configured — post this head now';
      setDigest(`${pub.digest}\n${witness}`); refresh();
    })
      .catch((e) => { say(e.message); close(); });
  }, []);
  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); }}>
      <div className="dialog">
        <h2>Published</h2>
        <textarea readOnly rows={4} value={digest ?? '…'} onFocus={(e) => e.target.select()} />
        <footer>
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(digest ?? ''); say('digest copied'); }}>Copy digest</button>
          <button className="btn primary" onClick={close}>Done</button>
        </footer>
      </div>
    </div>
  );
}
