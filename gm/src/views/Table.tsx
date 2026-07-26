/**
 * /table — in-session play (§7.3). This screen is a correctness requirement:
 * a routine draw is one keystroke with zero typing (acceptance criterion 4).
 *
 * Keyboard model: digits 1–4 arm players, 5–8 the NPC bench, 9/0 the world
 * (routine / deep purpose); a lowercase letter arms a check type scoped to
 * the armed slot's role; Enter draws. Arming is sticky, so repeating the
 * same check is Enter alone. `b` arms a party-wide batch, `d` edits the DC,
 * `m` records the missing modifier without leaving the table, `.` veils
 * results and NPC names, `U` corrects the last draw, `O`/`C` open and close
 * the session, `P` publishes.
 *
 * Sealed results live only in this component's memory: after a refresh they
 * are gone, and recovering them requires the logged reveal-all (criterion 9).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, CheckType, DEGREES, laneColor, SlotInfo, Status, TableState, uuid } from '../api';

const RESERVED_KEYS = new Set(['b', 'd', 'm']);

interface LogLine {
  id: number; t: string; seq?: number; who: string; lane?: string; position?: number;
  desc: string; roll?: number; mod?: number; dcVal?: number; kind: 'draw' | 'void' | 'note';
  openLane?: boolean; ritual?: boolean; npc?: boolean;
}

type Overlay =
  | { mode: 'context'; slot: string; typeId: string; }
  | { mode: 'announced'; slot: string; typeId: string; announceSeq: number; context: string; dcVal: number | null; initiator: 'gm' | 'player' }
  | { mode: 'numeral'; roll: number; mod?: number; dcVal?: number; label: string }
  | { mode: 'void'; slot: string; announceSeq: number }
  | { mode: 'correct' }
  | { mode: 'closing' }
  | { mode: 'publish' };

let logId = 0;
const nowT = () => new Date().toTimeString().slice(0, 5);

export function Table({ status, onChange }: { status: Status & { session_open?: boolean }; onChange: () => void }) {
  const [table, setTable] = useState<TableState | null>(null);
  const [armed, setArmed] = useState<{ slot: string | null; type: string | null; batch: boolean }>({ slot: null, type: null, batch: false });
  const [dc, setDc] = useState<number | null>(null);
  const [dcEditing, setDcEditing] = useState(false);
  const [modEditing, setModEditing] = useState(false);
  // the last announcement seq the server was observed to be holding open
  const seenAnnounce = useRef<number | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [veiled, setVeiled] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refreshTable = useCallback(async () => setTable(await api<TableState>('/api/table')), []);
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
    });
  }, [table, overlay, typeById]);
  const slots = table?.slots ?? [];
  const players = useMemo(() => slots.filter((s) => s.active && !s.retired && s.role === 'player').slice(0, 4), [slots]);
  const world = useMemo(() => slots.find((s) => s.active && !s.retired && s.role === 'world') ?? null, [slots]);
  const npcs = useMemo(() => slots.filter((s) => s.active && !s.retired && s.role === 'npc'), [slots]);
  const bench = useMemo(() => (table?.ui_state?.bench ?? []).filter((id) => npcs.some((n) => n.id === id)).slice(0, 4), [table, npcs]);

  const armedSlot = slots.find((s) => s.id === armed.slot) ?? null;

  /** check types the armed slot can use, with stable hotkey letters. */
  const scopedTypes = useMemo(() => {
    if (!armedSlot) return [] as (CheckType & { key: string })[];
    const used = new Set(RESERVED_KEYS);
    return registry
      .filter((t) => t.roles.includes(armedSlot.role ?? '') && armedSlot.lanes.includes(t.lane))
      .map((t) => {
        let key = '';
        for (const ch of t.id) if (/[a-z]/.test(ch) && !used.has(ch)) { key = ch; break; }
        if (key) used.add(key);
        return { ...t, key };
      });
  }, [registry, armedSlot]);

  const push = (line: Omit<LogLine, 'id' | 't'>) => setLog((l) => [{ id: ++logId, t: nowT(), ...line }, ...l].slice(0, 200));
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 2600); };

  const armDigit = useCallback((key: string) => {
    const worldType = (lane: string) =>
      registry.find((t) => t.roles.includes('world') && t.lane === lane && world?.lanes.includes(t.lane))
      ?? registry.find((t) => t.roles.includes('world') && world?.lanes.includes(t.lane));
    if (key >= '1' && key <= '4') {
      const p = players[Number(key) - 1];
      if (p) setArmed((a) => ({ slot: p.id, type: a.type && typeById[a.type]?.roles.includes('player') ? a.type : null, batch: false }));
    } else if (key >= '5' && key <= '8') {
      const n = npcs.find((x) => x.id === bench[Number(key) - 5]);
      if (n) setArmed((a) => ({ slot: n.id, type: a.type && typeById[a.type]?.roles.includes('npc') ? a.type : null, batch: false }));
      else say('no NPC pinned on that key — pin from the bench');
    } else if (key === '9' && world) {
      setArmed({ slot: world.id, type: worldType('routine')?.id ?? null, batch: false });
    } else if (key === '0' && world) {
      setArmed({ slot: world.id, type: worldType('deep')?.id ?? null, batch: false });
    }
  }, [players, npcs, bench, world, registry, typeById]);

  /**
   * Record the armed slot's modifier for the armed check type. Player slots
   * write a public sheet-update; NPC and world values stay private until
   * reveal (§7.5). Sent as a single-key map so it merges with what is there.
   */
  const saveModifier = useCallback(async (raw: string) => {
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v)) { setModEditing(false); return say('enter a whole number'); }
    if (!armed.slot || !armed.type) { setModEditing(false); return; }
    try {
      await api('/api/sheet-update', {
        slot: armed.slot,
        effective_from: new Date().toISOString().slice(0, 10),
        modifiers: { [armed.type]: v },
      });
      setModEditing(false);
      await refreshTable();
      onChange();
      say(`${armed.type} ${v >= 0 ? `+${v}` : v} recorded`);
    } catch (e: any) { setModEditing(false); say(e.message); }
  }, [armed, refreshTable, onChange]);

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
          dcVal: dc ?? undefined, kind: 'draw', openLane: e.lane === 'open',
        }));
        setArmed((a) => ({ ...a, batch: false }));
      } else if (type.ritual) {
        // an announcement is public and can only be resolved by a draw or a
        // void, so never write one we already know the draw will refuse
        if (armedModifier === undefined) {
          say('no modifier recorded — press m before announcing');
          return;
        }
        setOverlay({ mode: 'context', slot: armed.slot, typeId: type.id });
        return;
      } else {
        const res = await api('/api/draw', {
          draw_id: uuid(), slot: armed.slot, check_type: type.id, ...(dc !== null ? { dc } : {}),
        });
        push({
          seq: res.entry.seq, who: armedSlot?.display ?? armed.slot, lane: res.entry.lane,
          position: res.entry.position, desc: type.id, roll: res.roll,
          mod: res.modifier ?? res.entry.modifier, dcVal: dc ?? undefined, kind: 'draw',
          openLane: res.entry.lane === 'open', npc: armedSlot?.role === 'npc',
        });
      }
      refreshTable(); onChange();
    } catch (e: any) { say(e.message); }
  }, [armed, typeById, dc, players, armedSlot, refreshTable, onChange]);

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
        if (e.key === 'Escape') { setArmed({ slot: null, type: null, batch: false }); return true; }
        if (e.key === 'b') {
          if (armed.type && typeById[armed.type]?.roles.includes('player')) setArmed((a) => ({ ...a, batch: true }));
          else say('arm a player check type, then b for the party batch');
          return true;
        }
        if (e.key === 'd') { setDcEditing(true); return true; }
        if (e.key === 'm') {
          if (armed.slot && armed.type) setModEditing(true);
          else say('arm a slot and a check type first');
          return true;
        }
        if (e.key === 'U') { setOverlay({ mode: 'correct' }); return true; }
        if (e.key === 'P') { setOverlay({ mode: 'publish' }); return true; }
        if (e.key === 'C') { setOverlay({ mode: 'closing' }); return true; }
        if (e.key === 'O') {
          void api('/api/session/open', {}).then(() => { onChange(); say('session opened'); }).catch((er) => say(er.message));
          return true;
        }
        if (/^[a-z]$/.test(e.key)) {
          const t = scopedTypes.find((x) => x.key === e.key);
          if (t) { setArmed((a) => ({ ...a, type: t.id })); return true; }
        }
        return false;
      };
      if (handled()) e.preventDefault();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [overlay, armDigit, fire, armed, scopedTypes, typeById, onChange]);

  if (!table) return <p className="dim">reaching the table…</p>;

  const armedType = armed.type ? typeById[armed.type] : null;
  // mirrors the server's sourcing: by the slot's role, not the seal flag
  const modifierFor = (slot: SlotInfo, typeId: string): number | undefined =>
    (slot.role === 'player' ? table.sheets : table.npc_sheets)[slot.id]?.[typeId];
  const armedModifier: number | undefined = armedSlot && armed.type
    ? modifierFor(armedSlot, armed.type) : undefined;
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
            {!status.session_open && <button className="btn" onClick={() => api('/api/session/open', {}).then(onChange).catch((e) => say(e.message))}>Open session [O]</button>}
          </div>
          <div className="slotgrid players">
            {players.map((p, i) => (
              <SlotCard key={p.id} slot={p} digit={String(i + 1)} lanes={table.lanes}
                armed={armed.slot === p.id} veilName={false} veiled={veiled}
                onArm={() => armDigit(String(i + 1))} />
            ))}
          </div>

          <details className="npcs">
            <summary className="sectionhead"><span className="eyebrow">NPCs — bench {bench.length}/{npcs.length}</span></summary>
            <div className="slotgrid" style={{ marginTop: '.4rem' }}>
              {npcs.map((n) => {
                const pin = bench.indexOf(n.id);
                return (
                  <SlotCard key={n.id} slot={n} digit={pin >= 0 ? String(5 + pin) : '·'} lanes={table.lanes}
                    armed={armed.slot === n.id} veilName veiled={veiled}
                    onArm={() => setArmed({ slot: n.id, type: null, batch: false })}
                    extra={
                      <button className="btn ghost" onClick={(e) => {
                        e.stopPropagation();
                        const next = pin >= 0 ? bench.filter((b) => b !== n.id) : [...bench, n.id].slice(0, 4);
                        api('/api/ui-state', { ...(table.ui_state ?? {}), bench: next }).then(refreshTable);
                      }}>{pin >= 0 ? 'unpin' : 'pin'}</button>
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
        <span className="who">{armedSlot ? (armedSlot.display ?? armedSlot.id) : <span className="faint">press 1–4, 5–8, 9/0</span>}{armed.batch && <span className="brass"> ×{players.length} batch</span>}</span>
        {scopedTypes.map((t) => (
          <button key={t.id} className={'typechip' + (armed.type === t.id ? ' armed' : '')}
            onClick={() => setArmed((a) => ({ ...a, type: t.id }))}>
            <span className="keycap">{t.key || '·'}</span>{t.id}{t.ritual && <span className="rubricdot" title="ritual: announce, then reveal" />}
          </button>
        ))}
        {armedSlot && (
          // A draw is refused outright without a modifier, so it must be
          // visible before Enter rather than discovered by the error.
          <span className={'typechip dcchip' + (armedModifier === undefined ? ' armed' : '')}>
            <span className="keycap">m</span>mod{' '}
            {modEditing
              ? <input autoFocus defaultValue={armedModifier ?? ''} onBlur={() => setModEditing(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { void saveModifier((e.target as HTMLInputElement).value); }
                    if (e.key === 'Escape') setModEditing(false);
                  }} />
              : <button className={'btn ghost' + (armedModifier === undefined ? ' rubric' : '')}
                  title={armedModifier === undefined ? 'no modifier recorded — a draw will be refused' : 'from the sheet'}
                  onClick={() => setModEditing(true)}>
                  {armedModifier === undefined ? 'not set' : (armedModifier >= 0 ? `+${armedModifier}` : armedModifier)}
                </button>}
          </span>
        )}
        {armedSlot && (
          <span className="typechip dcchip">
            <span className="keycap">d</span>DC{' '}
            {dcEditing
              ? <input autoFocus defaultValue={dc ?? ''} onBlur={() => setDcEditing(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { const v = parseInt((e.target as HTMLInputElement).value, 10); setDc(Number.isFinite(v) ? v : null); setDcEditing(false); }
                    if (e.key === 'Escape') { setDc(null); setDcEditing(false); }
                  }} />
              : <button className="btn ghost" onClick={() => setDcEditing(true)}>{dc ?? '—'}</button>}
          </span>
        )}
        {batchMissing.length > 0 && (
          <span className="flash">batch needs a modifier for {batchMissing.join(', ')}</span>
        )}
        {flash && <span className="flash">{flash}</span>}
        <span className="hint">Enter draws{armedType?.ritual ? ' → announce' : ''} · m mod · d DC · b batch · . veil · U correct · C close &amp; publish</span>
      </div>

      {overlay && <OverlayHost overlay={overlay} setOverlay={setOverlay} table={table} status={status}
        typeById={typeById} dc={dc} push={push} say={say}
        refresh={async () => { await refreshTable(); onChange(); }} log={log} />}
    </div>
  );
}

/* ---------------- slot card with its colonnade of columns ----------------- */

function SlotCard({ slot, digit, lanes, armed, onArm, veiled, veilName, note, extra }: {
  slot: SlotInfo; digit: string; lanes: TableState['lanes']; armed: boolean;
  onArm: () => void; veiled: boolean; veilName: boolean; note?: string; extra?: any;
}) {
  return (
    <button className={'slotcard' + (armed ? ' armed' : '')} onClick={onArm}>
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
      {extra}
      <span className="keycap">{digit}</span>
    </button>
  );
}

/* ----------------------------- overlays ----------------------------------- */

function OverlayHost(props: {
  overlay: Overlay; setOverlay: (o: Overlay | null) => void; table: TableState;
  status: Status & { session_open?: boolean }; typeById: Record<string, CheckType>;
  dc: number | null; push: (l: any) => void; say: (m: string) => void; refresh: () => Promise<void>;
  log: LogLine[];
}) {
  const { overlay, setOverlay, table, typeById, push, say, refresh, log } = props;
  const close = () => setOverlay(null);
  const slotName = (id: string) => table.slots.find((s) => s.id === id)?.display ?? id;

  if (overlay.mode === 'context') return <ContextSheet {...{ overlay, setOverlay, typeById, close, say, dc: props.dc }} slotName={slotName(overlay.slot)} />;
  if (overlay.mode === 'announced') return <Announced {...{ overlay, setOverlay, typeById, push, say, refresh, close }} slotName={slotName(overlay.slot)} />;
  if (overlay.mode === 'numeral') {
    const total = overlay.mod !== undefined ? overlay.roll + overlay.mod : null;
    const degree = total !== null && overlay.dcVal !== undefined
      ? (() => { let d = total >= overlay.dcVal! + 10 ? 3 : total >= overlay.dcVal! ? 2 : total <= overlay.dcVal! - 10 ? 0 : 1; if (overlay.roll === 20) d = Math.min(d + 1, 3); if (overlay.roll === 1) d = Math.max(d - 1, 0); return d; })()
      : null;
    return (
      <div className="overlay" tabIndex={-1} ref={(el) => el?.focus()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') close(); }} onClick={close}>
        <div className="ceremony">
          <div className="numeral">{overlay.roll}</div>
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
  if (overlay.mode === 'void') return <VoidSheet {...{ overlay, push, say, refresh, close }} slotName={slotName(overlay.slot)} />;
  if (overlay.mode === 'correct') return <CorrectSheet {...{ log, table, push, say, refresh, close }} />;
  if (overlay.mode === 'closing') return <CloseSession {...{ status: props.status, close, say, refresh }} />;
  if (overlay.mode === 'publish') return <PublishSheet {...{ close, say, refresh }} />;
  return null;
}

function ContextSheet({ overlay, setOverlay, typeById, close, say, dc, slotName }: any) {
  const type = typeById[overlay.typeId];
  const [context, setContext] = useState<string>(type.label);
  const [initiator, setInitiator] = useState<'gm' | 'player'>('gm');
  const [dcVal, setDcVal] = useState<string>(dc !== null && dc !== undefined ? String(dc) : '');
  const announce = async () => {
    try {
      const entry = await api('/api/announce', { slot: overlay.slot, check_type: type.id, context, initiator });
      setOverlay({
        mode: 'announced', slot: overlay.slot, typeId: type.id,
        announceSeq: entry.seq, context,
        dcVal: dcVal === '' ? null : parseInt(dcVal, 10), initiator,
      });
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

function Announced({ overlay, setOverlay, typeById, push, say, refresh, close, slotName }: any) {
  const type = typeById[overlay.typeId];
  const reveal = async () => {
    try {
      const res = await api('/api/draw', {
        draw_id: uuid(), slot: overlay.slot, check_type: type.id,
        announce_seq: overlay.announceSeq, initiator: overlay.initiator,
        ...(overlay.dcVal !== null ? { dc: overlay.dcVal } : {}),
      });
      push({ seq: res.entry.seq, who: slotName, lane: res.entry.lane, position: res.entry.position, desc: `${type.id} · ritual`, roll: res.roll, mod: res.modifier ?? res.entry.modifier, dcVal: overlay.dcVal ?? undefined, kind: 'draw', ritual: true });
      refresh();
      setOverlay({ mode: 'numeral', roll: res.roll, mod: res.modifier ?? res.entry.modifier, dcVal: overlay.dcVal ?? undefined, label: `${slotName} · ${type.label}` });
    } catch (e: any) {
      // stay on ANNOUNCED: the announcement is public and still unresolved,
      // so the GM must keep both Reveal and Void within reach
      say(e.message);
    }
  };
  return (
    <div className="overlay" tabIndex={-1} ref={(el) => el?.focus()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void reveal(); }
        if (e.key === 'v') { e.preventDefault(); setOverlay({ mode: 'void', slot: overlay.slot, announceSeq: overlay.announceSeq }); }
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
            <input style={{ width: '3.5rem' }} defaultValue={overlay.dcVal ?? ''}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setOverlay({ ...overlay, dcVal: Number.isFinite(v) ? v : null });
              }} />
          </span>
        </p>
        <div className="actions">
          <button className="btn primary" onClick={reveal}>Reveal — Enter</button>
          <button className="btn rubric" onClick={() => setOverlay({ mode: 'void', slot: overlay.slot, announceSeq: overlay.announceSeq })}>Void — v</button>
        </div>
        <p className="sub faint">The announcement is public. Only reveal or void can follow it.</p>
      </div>
    </div>
  );
}

function VoidSheet({ overlay, push, say, refresh, close, slotName }: any) {
  const [reason, setReason] = useState('');
  const doVoid = async () => {
    try {
      await api('/api/void', { announce_seq: overlay.announceSeq, reason: reason || 'abandoned' });
      push({ who: slotName, desc: `VOID — ${reason || 'abandoned'}`, kind: 'void' });
      // await before closing: the recovery effect reads open_announce, and a
      // stale read would resurrect ANNOUNCED for the ritual just voided
      await refresh();
      close();
    } catch (e: any) { say(e.message); close(); }
  };
  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="ceremony">
        <div className="word">VOID</div>
        <p className="sub">This writes a public void the table will see. The reserved position stays unconsumed.</p>
        <input type="text" autoFocus placeholder="why (public)" value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doVoid(); }} />
        <div className="actions">
          <button className="btn ghost" onClick={close}>back</button>
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
  const players = table.slots.filter((s: SlotInfo) => s.active && !s.retired);
  if (!last) return <div className="overlay" onClick={close}><div className="dialog"><p>No draw in this session's log to correct.</p></div></div>;
  const submit = async () => {
    try {
      let replacement: number | undefined;
      if (redraw) {
        const typeId = last.desc.split(' ·')[0];
        const res = await api('/api/draw', { draw_id: uuid(), slot: redraw, check_type: typeId, ...(last.dcVal !== undefined ? { dc: last.dcVal } : {}) });
        replacement = res.entry.seq;
        push({ seq: res.entry.seq, who: table.slots.find((s: SlotInfo) => s.id === redraw)?.display ?? redraw, lane: res.entry.lane, position: res.entry.position, desc: `${typeId} · redraw`, roll: res.roll, mod: res.modifier, dcVal: last.dcVal, kind: 'draw' });
      }
      await api('/api/correction', { target_seq: last.seq, reason, ...(replacement !== undefined ? { replacement_seq: replacement } : {}) });
      push({ who: last.who, desc: `corrected seq ${last.seq} — the value stays burned`, kind: 'void' });
      refresh(); close();
    } catch (e: any) { say(e.message); close(); }
  };
  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="dialog">
        <h2>Correct the last draw</h2>
        <p className="dim">seq {last.seq} · {last.who} · {last.desc}. The position is consumed and stays consumed — this marks it misattributed, publicly.</p>
        <div className="row"><label className="fld">reason (public)<input type="text" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></label></div>
        <div className="row">
          <span className="dim">redraw correctly on:</span>
          <select value={redraw} onChange={(e) => setRedraw(e.target.value)}>
            <option value="">— no redraw —</option>
            {players.map((p: SlotInfo) => <option key={p.id} value={p.id}>{p.display ?? p.id}</option>)}
          </select>
        </div>
        <footer>
          <button className="btn ghost" onClick={close}>cancel</button>
          <button className="btn rubric" onClick={submit}>Write correction</button>
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

  useEffect(() => {
    (async () => {
      const ledger = await api('/api/ledger');
      const lates = new Set(ledger.entries.filter((e: any) => e.kind === 'dc-late').map((e: any) => e.target_seq));
      setDcless(ledger.entries.filter((e: any) =>
        e.kind === 'draw' && e.session === status.session && !('dc' in e) && !('dc_commit' in e) && !lates.has(e.seq)));
    })();
  }, [status.session]);

  const sealDc = async (seq: number) => {
    const v = parseInt(dcInputs[seq] ?? '', 10);
    if (!Number.isFinite(v)) return say('enter a DC first');
    try { await api('/api/dc-late', { target_seq: seq, dc: v }); setDcless((d) => d!.filter((e) => e.seq !== seq)); }
    catch (e: any) { say(e.message); }
  };

  const closeAndPublish = async () => {
    try {
      if (status.session_open) await api('/api/session/close', {});
      // nightly open-lane disclosure through the current position (§4.3)
      const t = await api('/api/table');
      for (const [key, lane] of Object.entries<any>(t.lanes)) {
        if (key.endsWith('/open') && lane.drawn > lane.watermark) {
          const [slot, laneName] = key.split('/');
          await api('/api/disclose', { slot, lane: laneName, through_position: lane.drawn });
        }
      }
      const pub = await api('/api/publish', {});
      const witness = pub.mirror === 'ok'
        ? 'mirror command succeeded — confirm the remote commit and post this head'
        : pub.mirror?.startsWith('failed')
          ? `WARNING: mirror command failed — post this head now (${pub.mirror})`
          : 'no mirror command configured — post this head now';
      setDigest(`${pub.digest}\n${witness}`);
      setStage('done');
      refresh();
    } catch (e: any) { say(e.message); }
  };

  return (
    <div className="overlay" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="dialog">
        <h2>Close session {status.session} &amp; publish</h2>
        {stage === 'review' && (
          <>
            <p className="dim">Draws still missing a DC — seal them now or leave them DC-less forever:</p>
            {dcless === null ? <p className="faint">checking…</p> : dcless.length === 0
              ? <p className="open-c">Every draw this session has its DC.</p>
              : dcless.map((e) => (
                <div className="row" key={e.seq}>
                  <span className="mono">#{e.seq} {e.slot}/{e.lane} pos {e.position} · {e.check_type}</span>
                  <input style={{ width: '4rem' }} placeholder="DC" value={dcInputs[e.seq] ?? ''}
                    onChange={(ev) => setDcInputs((d) => ({ ...d, [e.seq]: ev.target.value }))} />
                  <button className="btn" onClick={() => sealDc(e.seq)}>seal DC</button>
                </div>
              ))}
            <footer>
              <button className="btn ghost" onClick={close}>not yet</button>
              <button className="btn primary" onClick={closeAndPublish}>Close, disclose open lanes, publish</button>
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
