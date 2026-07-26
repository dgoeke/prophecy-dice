/**
 * /setup — the ceremony wizard (§7.2). Linear and state-machine enforced:
 * pre-commit → (wait ≥1h) → configure routing → publicly witness that
 * configuration → collect player entropy → review → write genesis.
 */
import { useEffect, useState } from 'react';
import { api, Status } from '../api';

// §2.5 suggested starting registry — the GM edits at the ceremony
const SUGGESTED_REGISTRY = [
  { id: 'rk-cosmology', label: 'Recall Knowledge — cosmology', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: true },
  { id: 'lore-mystery', label: 'Lore — the central mystery', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: true },
  { id: 'divination', label: 'Divination and omens', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: true },
  { id: 'rk-general', label: 'Recall Knowledge — general', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'perception-secret', label: 'Secret Perception', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'sense-motive', label: 'Sense Motive', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'decipher-identify', label: 'Decipher Writing / Identify Magic', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'npc-public', label: 'NPC check the table watched', lane: 'open', roles: ['npc'], seal_dc: false, seal_modifier: true, ritual: false },
  { id: 'npc-secret', label: 'NPC secret check', lane: 'deep', roles: ['npc'], seal_dc: true, seal_modifier: true, ritual: false },
  { id: 'world-routine', label: 'World — routine', lane: 'routine', roles: ['world'], seal_dc: true, seal_modifier: true, ritual: false },
  { id: 'world-plot', label: 'World — plot', lane: 'deep', roles: ['world'], seal_dc: true, seal_modifier: true, ritual: true },
  { id: 'public-gm-check', label: 'Public GM check', lane: 'open', roles: ['player', 'npc', 'world'], seal_dc: false, seal_modifier: false, ritual: false },
];

const STEPS = ['pre-commit', 'roster & lanes', 'registry', 'parameters', 'player entropy', 'review', 'genesis'];

const randHex = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

export function Setup({ status, onChange }: { status: Status; onChange: () => void }) {
  const [step, setStep] = useState(status.phase === 'empty' ? 0 : 1);
  const [present, setPresent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [commitment, setCommitment] = useState<{ commitment: string; precommit_at: string } | null>(
    () => status.precommit ?? JSON.parse(localStorage.getItem('column-precommit') ?? 'null'),
  );
  const [players, setPlayers] = useState([
    { display: '', nonce: '', lanes: 'sealed,open' },
    { display: '', nonce: '', lanes: 'sealed,open' },
    { display: '', nonce: '', lanes: 'sealed,open' },
    { display: '', nonce: '', lanes: 'sealed,open' },
  ]);
  const [withWorld, setWithWorld] = useState(true);
  const [worldNonce, setWorldNonce] = useState('');
  const [registry, setRegistry] = useState(SUGGESTED_REGISTRY.map((r) => ({ ...r, roles: r.roles.join(',') })));
  const [params, setParams] = useState({
    campaign: '', chain_length: 20000, reserve_total: 64,
    context_privacy: 'plain', disclosure_policy:
      'Sealed and deep lanes: opened no less than two story arcs after the draw. Open lane: opened at each session-close. Routine lane: opened at each arc-close. Full reveal at campaign end.',
  });
  const [preview, setPreview] = useState<{
    transcript: any; transcript_hash: string; entropy: string; configuration: any;
  } | null>(null);
  const [frozenConfig, setFrozenConfig] = useState<{
    commitment: string; configuration: any;
  } | null>(null);

  // The nonce-free configuration is encrypted in private state. Recovering it
  // after a refresh is safe and essential: the hash alone would make a
  // partially completed ceremony practically impossible to resume exactly.
  useEffect(() => {
    if (status.phase !== 'precommitted' || !status.configuration_frozen || frozenConfig) return;
    api('/api/setup/configuration').then((saved) => {
      const cfg = saved.configuration;
      const active = (cfg.slots ?? []).filter((s: any) => s.status === 'active');
      const playerSlots = active.filter((s: any) => s.role === 'player');
      const worldSlot = active.find((s: any) => s.role === 'world');
      setPlayers(playerSlots.map((s: any) => ({
        display: s.display, nonce: '', lanes: s.lanes.join(','),
      })));
      setWithWorld(!!worldSlot);
      setWorldNonce('');
      setRegistry(cfg.check_types.map((r: any) => ({ ...r, roles: r.roles.join(',') })));
      setParams({
        campaign: cfg.campaign, chain_length: cfg.chain_length,
        reserve_total: cfg.slots.length, context_privacy: cfg.context_privacy,
        disclosure_policy: cfg.disclosure_policy,
      });
      setFrozenConfig({
        commitment: saved.configuration_commitment,
        configuration: cfg,
      });
      setStep(4);
    }).catch((e: any) => setMsg(e.message));
  }, [status.phase, status.configuration_frozen, frozenConfig]);

  const genesisInput = (configurationPreview = false) => ({
    campaign: params.campaign,
    chain_length: Number(params.chain_length),
    reserve_total: Number(params.reserve_total),
    context_privacy: params.context_privacy,
    disclosure_policy: params.disclosure_policy,
    check_types: registry.map((r) => ({ ...r, roles: r.roles.split(',').map((s) => s.trim()).filter(Boolean) })),
    active_slots: [
      ...players.filter((p) => p.display.trim()).map((p) => ({
        display: p.display.trim(), role: 'player',
        lanes: p.lanes.split(',').map((s) => s.trim()).filter(Boolean),
        nonce: configurationPreview ? 'configuration-preview-player' : p.nonce,
      })),
      ...(withWorld ? [{
        display: 'the world', role: 'world', lanes: ['open', 'routine', 'deep'],
        nonce: configurationPreview ? 'configuration-preview-world' : worldNonce,
      }] : []),
    ],
  });

  const doPrecommit = async () => {
    if (pass.length < 8) return setMsg('passphrase must be at least 8 characters');
    if (pass !== pass2) return setMsg('passphrases differ');
    try {
      const res = await api('/api/setup/precommit', { passphrase: pass });
      setCommitment(res);
      localStorage.setItem('column-precommit', JSON.stringify(res));
      setMsg(null); onChange();
    } catch (e: any) { setMsg(e.message); }
  };

  const freezeConfiguration = async () => {
    try {
      const checked = await api('/api/setup/configuration', genesisInput(true));
      setFrozenConfig({
        commitment: checked.configuration_commitment,
        configuration: checked.configuration,
      });
      setMsg(null); setStep(4);
    } catch (e: any) { setMsg(e.message); }
  };

  const doPreview = async () => {
    try {
      const checked = await api('/api/setup/genesis-preview', genesisInput());
      if (!frozenConfig || checked.transcript.configuration_commitment !== frozenConfig.commitment) {
        throw new Error('configuration changed after it was witnessed; restart the ceremony before collecting nonces');
      }
      setPreview(checked); setMsg(null); setStep(5);
    }
    catch (e: any) { setMsg(e.message); }
  };

  const doGenesis = async () => {
    try {
      await api('/api/setup/genesis', { ...genesisInput(), created_at: preview!.transcript.created_at });
      localStorage.removeItem('column-precommit');
      setMsg(null); setStep(6); onChange();
    } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div className={present ? 'presentation' : ''}>
      <main className="view wizard">
        <div className="sectionhead">
          <h1 className="wordmark" style={{ fontSize: '1.3rem' }}>THE CEREMONY</h1>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost" onClick={() => setPresent((p) => !p)}>{present ? 'exit presentation' : 'presentation mode'}</button>
        </div>
        <div className="steps">
          {STEPS.map((s, i) => <span key={s} className={'step' + (i === step ? ' now' : i < step ? ' done' : '')}>{i + 1} · {s}</span>)}
        </div>
        {msg && <p className="rubric">{msg}</p>}

        {step === 0 && (
          <section className="pane">
            <h2>Pre-commit — the night before session zero</h2>
            <p className="dim">A 32-byte secret is generated and sealed under your passphrase. Its hash — the commitment — goes to the group chat <em>now</em>, before any player contributes entropy. The later column roots combine that already-committed secret with the players’ nonces.</p>
            {!commitment ? (
              <>
                <div className="row" style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
                  <label className="fld">passphrase<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
                  <label className="fld">again<input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} /></label>
                </div>
                <p><button className="btn primary" onClick={doPrecommit}>Generate S and commit</button></p>
                <p className="faint">Losing this passphrase after session zero permanently destroys the audit. Put it in a password manager tonight.</p>
              </>
            ) : (
              <>
                <p>Commitment <code>C</code> — post this to the group chat with a timestamp:</p>
                <div className="commitment">{commitment.commitment}</div>
                <p className="dim">committed at {commitment.precommit_at} · the ceremony may begin one hour later</p>
                <p>
                  <button className="btn" onClick={() => navigator.clipboard?.writeText(commitment.commitment)}>Copy C</button>{' '}
                  <button className="btn primary" onClick={() => setStep(1)}>Continue to the table →</button>
                </p>
              </>
            )}
          </section>
        )}

        {step === 1 && (
          <section className="pane">
            <h2>Roster &amp; lanes — configure before entropy</h2>
            {commitment && <>
              <p className="dim">First: display the commitment and have everyone confirm it against the chat message.</p>
              <div className="commitment">{commitment.commitment}</div>
            </>}
            <p className="dim" style={{ marginTop: '.8rem' }}>Set the exact player-to-slot order and lane names now. Nobody enters a nonce yet: roster mapping, lanes, check routing, and chain length can all select different committed values, so players will witness those choices first.</p>
            <table className="grid"><thead><tr><th>player / slot order</th><th>lanes</th></tr></thead><tbody>
              {players.map((p, i) => (
                <tr key={i}>
                  <td><input type="text" placeholder={`player ${i + 1}`} value={p.display} onChange={(e) => setPlayers((ps) => ps.map((x, j) => j === i ? { ...x, display: e.target.value } : x))} /></td>
                  <td><input type="text" value={p.lanes} style={{ width: '9rem' }} onChange={(e) => setPlayers((ps) => ps.map((x, j) => j === i ? { ...x, lanes: e.target.value } : x))} /></td>
                </tr>
              ))}
              <tr>
                <td><label><input type="checkbox" checked={withWorld} onChange={(e) => setWithWorld(e.target.checked)} /> the world</label></td>
                <td><span className="mono faint">open,routine,deep</span></td>
              </tr>
            </tbody></table>
            <footer className="wz"><button className="btn ghost" onClick={() => setStep(0)}>← back</button><button className="btn primary" onClick={() => setStep(2)}>registry →</button></footer>
          </section>
        )}

        {step === 2 && (
          <section className="pane">
            <h2>Check-type registry — committed at genesis</h2>
            <p className="dim">Which lane each kind of check consumes is fixed here, forever — lane choice can never be a per-roll decision. The registry cannot be amended after genesis because changing routing after seeing columns would be a grinding surface.</p>
            <table className="grid"><thead><tr><th>id</th><th>label</th><th>lane</th><th>roles</th><th>seal DC</th><th>seal mod</th><th>ritual</th><th /></tr></thead><tbody>
              {registry.map((r, i) => {
                const up = (patch: any) => setRegistry((rs) => rs.map((x, j) => j === i ? { ...x, ...patch } : x));
                return (
                  <tr key={i}>
                    <td><input type="text" value={r.id} style={{ width: '9rem' }} onChange={(e) => up({ id: e.target.value })} /></td>
                    <td><input type="text" value={r.label} style={{ width: '100%' }} onChange={(e) => up({ label: e.target.value })} /></td>
                    <td><input type="text" value={r.lane} style={{ width: '5rem' }} onChange={(e) => up({ lane: e.target.value })} /></td>
                    <td><input type="text" value={r.roles} style={{ width: '8rem' }} onChange={(e) => up({ roles: e.target.value })} /></td>
                    <td><input type="checkbox" checked={r.seal_dc} onChange={(e) => up({ seal_dc: e.target.checked })} /></td>
                    <td><input type="checkbox" checked={r.seal_modifier} onChange={(e) => up({ seal_modifier: e.target.checked })} /></td>
                    <td><input type="checkbox" checked={r.ritual} onChange={(e) => up({ ritual: e.target.checked })} /></td>
                    <td><button className="btn ghost" onClick={() => setRegistry((rs) => rs.filter((_, j) => j !== i))}>×</button></td>
                  </tr>
                );
              })}
            </tbody></table>
            <p><button className="btn" onClick={() => setRegistry((rs) => [...rs, { id: '', label: '', lane: 'sealed', roles: 'player', seal_dc: true, seal_modifier: false, ritual: false }])}>+ add type</button></p>
            <footer className="wz"><button className="btn ghost" onClick={() => setStep(1)}>← back</button><button className="btn primary" onClick={() => setStep(3)}>parameters →</button></footer>
          </section>
        )}

        {step === 3 && (
          <section className="pane">
            <h2>Parameters</h2>
            <div style={{ display: 'flex', gap: '.8rem', flexWrap: 'wrap' }}>
              <label className="fld">campaign<input type="text" value={params.campaign} onChange={(e) => setParams((p) => ({ ...p, campaign: e.target.value }))} /></label>
              <label className="fld">chain length N (default 20000)<input type="number" value={params.chain_length} onChange={(e) => setParams((p) => ({ ...p, chain_length: Number(e.target.value) }))} /></label>
              <label className="fld">reserved slots (default 64 — reserve generously)<input type="number" value={params.reserve_total} onChange={(e) => setParams((p) => ({ ...p, reserve_total: Number(e.target.value) }))} /></label>
              <label className="fld">context privacy<select value={params.context_privacy} onChange={(e) => setParams((p) => ({ ...p, context_privacy: e.target.value }))}><option value="plain">plain</option><option value="sealed">sealed</option></select></label>
            </div>
            <label className="fld" style={{ marginTop: '.8rem' }}>disclosure policy — your stated cadence, committed in the transcript
              <textarea rows={3} value={params.disclosure_policy} onChange={(e) => setParams((p) => ({ ...p, disclosure_policy: e.target.value }))} />
            </label>
            <p className="dim">The next action validates and freezes all of these choices. The app will show a configuration commitment for the players to post to the group chat <em>before</em> entering any nonce.</p>
            <footer className="wz"><button className="btn ghost" onClick={() => setStep(2)}>← back</button><button className="btn primary" onClick={freezeConfiguration}>freeze configuration →</button></footer>
          </section>
        )}

        {step === 4 && frozenConfig && (
          <section className="pane">
            <h2>Player entropy — configuration is frozen</h2>
            <p className="dim">Post this configuration commitment to the group chat now. It binds the roster order, lanes, registry, chain length, and every other setup choice shown below. The final verifier recomputes it, so those choices cannot be changed after seeing player entropy without detection.</p>
            <div className="commitment">{frozenConfig.commitment}</div>
            <p><button className="btn" onClick={() => navigator.clipboard?.writeText(frozenConfig.commitment)}>Copy configuration commitment</button></p>
            <details><summary>Exact committed configuration</summary>
              <textarea readOnly rows={12} value={JSON.stringify(frozenConfig.configuration, null, 2)} />
            </details>
            <p className="dim">After the chat message is visible, each player types their own nonce. For the anti-grinding claim, at least one player must generate an unpredictable value on a player-controlled device only now, then type or paste it here. This page’s CSPRNG button is a convenience, not independent entropy against a malicious GM. Fields are never pre-filled. The world nonce is recorded for a uniform transcript but does not contribute to the entropy hash.</p>
            <table className="grid"><thead><tr><th>player</th><th>frozen lanes</th><th>nonce</th><th /></tr></thead><tbody>
              {players.filter((p) => p.display.trim()).map((p, i) => (
                <tr key={i}>
                  <td>{p.display}</td>
                  <td><span className="mono faint">{p.lanes}</span></td>
                  <td><input type="text" placeholder="typed by the player" style={{ width: '100%' }} value={p.nonce} onChange={(e) => setPlayers((ps) => ps.map((x) => x === p ? { ...x, nonce: e.target.value } : x))} /></td>
                  <td><button className="btn ghost" title="insert 16 CSPRNG bytes at the player's request" onClick={() => setPlayers((ps) => ps.map((x) => x === p ? { ...x, nonce: x.nonce + randHex() } : x))}>csprng</button></td>
                </tr>
              ))}
              {withWorld && <tr>
                <td>the world</td>
                <td><span className="mono faint">open,routine,deep</span></td>
                <td><input type="text" placeholder="GM-supplied nonce" style={{ width: '100%' }} value={worldNonce} onChange={(e) => setWorldNonce(e.target.value)} /></td>
                <td><button className="btn ghost" onClick={() => setWorldNonce((n) => n + randHex())}>csprng</button></td>
              </tr>}
            </tbody></table>
            <footer className="wz"><span className="dim">Configuration changes now require restarting before entropy.</span><button className="btn primary" onClick={doPreview}>derive &amp; review →</button></footer>
          </section>
        )}

        {step === 5 && preview && (
          <section className="pane">
            <h2>Review — the exact transcript that will bind everything</h2>
            <p className="dim">Players should check their nonce, slot, lanes, and the unchanged configuration commitment in this exact transcript before genesis. The full transcript hash is an audit fingerprint; the player-entropy hash is what combines with the already-committed secret.</p>
            <p className="faint">configuration commitment (must match the earlier chat message)</p>
            <div className="commitment">{preview.transcript.configuration_commitment}</div>
            <p className="faint">transcript hash</p>
            <div className="commitment">{preview.transcript_hash}</div>
            <p className="faint">player entropy hash</p>
            <div className="commitment">{preview.entropy}</div>
            <textarea readOnly rows={14} style={{ marginTop: '.6rem' }} value={JSON.stringify(preview.transcript, null, 2)} />
            <footer className="wz">
              <button className="btn ghost" onClick={() => setStep(4)}>← correct a nonce</button>
              <button className="btn rubric" onClick={doGenesis}>Write genesis — irreversible</button>
            </footer>
          </section>
        )}

        {step === 6 && (
          <section className="pane" style={{ textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--font-ceremony)', letterSpacing: '.2em' }}>THE COLUMNS ARE FIXED</h2>
            <p className="dim">Genesis is written. Publish the ledger and paste its head into the chat.</p>
            <p><a className="btn primary" href="#/table" onClick={onChange}>to the table →</a></p>
          </section>
        )}
      </main>
    </div>
  );
}
