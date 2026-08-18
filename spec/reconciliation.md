# Prophecy Dice: Check Model and Campaign Reconciliation

## Status

Pre-genesis change plan for *The Wake of the World*. Two goals, in priority order:

1. **Correct and group the check types** so they match the campaign as it now
   exists (roots Lore, the mystery structure, Remaster secret actions).
2. **Remove the tedious stat bookkeeping** — the per-check-type modifier
   matrix that currently forces either a wall of numbers on `/sheets` or a
   wrong auto-filled bonus at the table.

The central move is to fix goal 2 **first**. The modifier store is currently
keyed by `(slot, check_type)`, which is the root cause of most registry
bloat: every time two skills share a check type, the sheet can hold only one
bonus, so the workaround has been to mint more check types. Decouple the
modifier from the check type and the registry shrinks back to what the
protocol says it should be — an audit-and-routing taxonomy, not a skill list.

Everything here happens before the configuration is frozen and before player
entropy is entered. The registry is immutable after genesis.

## Explicitly dropped from the earlier draft

| Dropped | Why |
|---|---|
| Raw draws / padding mode | Serves neither goal; weakens the count guarantee the digest depends on; a protocol change for a use case the campaign doesn't have. |
| 20-type registry (`lore-specialty`, `identify-alchemy`, `deception-secret`, `stealth-secret`, split `decipher-writing`/`identify-magic`) | All existed only as workarounds for the check-type-keyed modifier sheet. With profiles they are a skill selection, not a registry entry. |
| Committed group metadata on registry entries | Grouping is presentation; no committed metadata — a thin client-side major/routine divider derived from `ritual` suffices (see Hotkeys). |
| DC preset machinery (level tables, rank presets) | Polish, unrelated to either goal. The DC field is already sticky across draws. Revisit after a few real sessions if wanted. |

## Part 1 — Modifier profiles (the substantive change)

Profile identifiers are NFC-normalized before duplicate detection and
emission, then compared exactly and case-sensitively. A save validates its
defaults against the hypothetical appended history under the same greatest
`(effective_from, seq)` rule used by draws; a backdated snapshot therefore
cannot validate a dangling current default. `/api/table.scheduled_sheets`
lists every future transition, deduplicated by date at greatest sequence and
sorted chronologically.

### Model

- A **profile** is a named final bonus: `"Society": 5`, `"Perception": 7`,
  `"Brokhold Lore": 5`. The character sheet remains authoritative for the
  calculation behind the number. Each character needs ~6–9 profiles, updated
  at level-up. No proficiency ranks, no attributes, no decomposition.
- **Profile names are exact, case-sensitive identifiers**: trimmed,
  non-empty, ≤ 64 chars, no control characters or newlines; reject
  `prototype` and every own-property name of `Object.prototype`
  (`__proto__`, `constructor`, `toString`, …). This is strictly stronger
  than the existing `validRequestId` pattern
  (`gm/server/campaign.ts:38-40`), which does not catch `prototype`.
- `sheet-update.modifiers` is re-specified as a **complete profile snapshot**
  (profile name → int), not a patch. With 6–9 numbers snapshots are cheap,
  and they are the only clean deletion/rename semantics: a later snapshot
  that omits a name removes it. `/sheets` prefills the current set and
  submits it whole. Player sheet-updates stay public; NPC/world stay private.
- **Resolution rule for public player snapshots, shared by server and
  verifiers**: the applicable sheet
  for a draw is, among snapshots with `sheet-update.seq < draw.seq` **and**
  `effective_from ≤ draw-date`, the one with the greatest
  `(effective_from, seq)` pair. The `seq` restriction matters only to
  verifiers (the server never sees later entries at draw time), but without
  it a backdated snapshot written *after* a draw would retroactively become
  its applicable sheet — `verify.html:1020` has exactly this bug-shape
  today, filtering all snapshots by date with no sequence check, while
  `playerSheetMod` (`gm/server/campaign.ts:1187-1193`) ignores
  `effective_from` entirely. Both converge on this rule. If no snapshot is
  applicable, no modifier resolves and the draw is refused as today.
- **One clock read per draw**: the server captures a single timestamp used
  for both snapshot resolution and the draw entry's `ts`. Otherwise a draw
  straddling UTC midnight could resolve against one date while the verifier
  reasons from another.
- **NPC/world sheets are a dateless private complete current-value map** —
  no ledger entries exist for them, so no `seq` exists to sort by, and
  nothing ever verifies against them: NPC/world draws are proven by their
  per-draw `mod_commit`, and the private sheet table is not a ledger
  artifact (spec §7.5). Scope rules:
  - Saving **replaces the whole map**, so omission still means deletion —
    the same semantics as player snapshots (the current implementation
    merges, `gm/server/campaign.ts:671`).
  - `effective_from` applies **only** to public player snapshots. `/sheets`
    hides the field for NPC/world saves and the server rejects it there —
    never silently ignores it.
  - Default or selected NPC/world profiles resolve against the current
    private map at draw time; no date logic.
  - Verifier cross-checking and the `(effective_from, seq)` rule apply to
    player snapshots only.
  - Future-dated private changes would require the revisioned
    `{effective_from, revision, modifiers}` history — deliberately not
    built now.
- Each slot gets a **default profile per check type** — a pointer, not a
  copy: `slot-01: { "rk-general": "Society", "lore-roots": "Brokhold Lore",
  "perception-secret": "Perception", ... }`. This is what keeps a routine
  draw at one keystroke. Stored in private state (the server reads it to
  auto-fill draws); it is GM convenience data, not a commitment.
- At draw time the server resolves profile name → value under the resolution
  rule and writes the **final number** on the draw exactly as today. Field
  form follows the check type's committed `seal_modifier`, not the slot's
  role: ordinary player types publish `modifier`, NPC/world types seal it as
  `mod_commit`, and `public-gm-check` publishes it for every role — matching
  the existing implementation (`gm/server/campaign.ts:487`). The ledger draw
  format does not change. Which profile was used is recorded via the `@mod`
  context directive below.

### One pending modifier (`m` and `,`)

Two current traps, one fix. Today `m` writes a public `sheet-update`, so a
one-off skill silently overwrites the saved value and poisons the next
auto-fill. And a profile selection made with `,` would be ephemeral client
state: lost across a ritual reload, it would **silently substitute the
default profile's number** — worse than `m`'s failure mode (visible refusal),
because a plausible wrong value gets committed publicly.

Both operations therefore create the same client-side object with one
lifecycle:

```ts
type PendingModifier =
  | { kind: 'profile'; name: string; value: number }   // value is preview-only
  | { kind: 'manual'; value: number };
```

- Created by `,` (cycle the armed type's profile, e.g. `rk-general`
  Society → Occultism) or `m` (manual number).
- Visible before Enter, beside the armed bar's mod chip.
- Retained after a refused draw.
- Cleared on re-arm (slot **or** check type change), on entering batch mode,
  after a successful draw, and on ritual void.
- Re-enterable on the ANNOUNCED screen — the same recovery path the DC
  already uses there — since a reload loses client memory while the
  announcement survives on the server.
- **On a *recovered* announcement, Reveal is disabled** until the GM selects
  a profile, enters a manual modifier, or explicitly chooses "use current
  default." Re-enterability alone is not enough: after a reload the UI
  cannot know whether the original selection was the default, an alternate
  profile, or manual, and an immediately-enabled Reveal would still silently
  use the default. (The normal, non-recovered flow keeps Reveal immediately
  enabled.)

`PendingModifier` is **client state — `Table.tsx` React state, nothing
else**. It is deliberately lost on reload; the recovered-announcement rule
above is what makes that loss safe. Profile defaults live in private server
state; name validation and resolution are server-side.

**The wire carries the name, not the number.** A draw request sends
`{profile: "Occultism"}` or `{modifier: 7}`; the server resolves the name to
its current value under the resolution rule and composes the context
directive itself. The client's `value` is display preview only. This removes
the stale-snapshot edge (a sheet-update landing between selection and draw)
and puts context composition in exactly one place server-side. Request
exclusivity is strict:

- neither `profile` nor `modifier` → resolve the default profile;
- `profile` only → resolve that profile;
- `modifier` only → manual override;
- both → reject the request.

`m` and `,` are disabled during batch mode; batches resolve each player's
own default profile for the shared check type, and a player with no matching
profile blocks the batch with the same visible warning as today. Per-player
batch overrides would need a batch editor, not one number — out of scope.

Editing saved profiles and defaults lives on `/sheets`, outside the hot
path. A second action on `,` offers "make this the default."

### Audit encoding — the `@mod` directive

"Append the profile name to context" is too loose to parse. One canonical
directive, always the **final line** of a draw's context, parsed only there:

```text
Recall Knowledge — general
@mod "Society"
```

or, for a manual override:

```text
@mod manual
```

Rules:

- The profile name is a JSON string (JSON escaping; the name rules above
  already forbid newlines). `@mod manual` is literal.
- **Canonical composition, server-side**: trim trailing whitespace from the
  narrative base, then append exactly `\n@mod …`. GM-supplied context (draw
  or announce) is rejected if any of its lines matches the directive shape,
  so parse-only-the-final-line stays unambiguous.
- The directive appears in **draw contexts only, never announce contexts**.
  The announcement commits the spoken purpose; resolution details bind at
  the draw, which commits its own separate context. (Verified safe against
  the frozen "ritual purpose differs" negative vector — inv 8 compares
  slot/lane/check_type/initiator, never context text.)
- Riding inside `context` means the selection automatically inherits
  context's sealing and disclosure schedule — a dedicated ledger field would
  need its own seal treatment mirroring context's.
- **Emission vs. compatibility.** The frozen `/4` vectors predate the
  directive, so it cannot be a hard verifier invariant. Two rules:
  - *Server emission (hard)*: every draw context emitted by the updated
    server contains exactly one final `@mod` line.
  - *Verifier compatibility (advisory)*: a disclosed draw context with no
    directive is reported as legacy/unattributed — the old check-type-keyed
    cross-check may serve as fallback — and multiple or malformed
    directives are an advisory warning, never a verdict change.
- The verifier's modifier cross-check parses the directive after disclosure:
  `@mod "Society"` is checked against the applicable snapshot under the
  resolution rule; `@mod manual` renders as a deliberate override, not a
  mismatch.

**Hard requirement**: `buildDraw` returns the exact resolved context string
and `storeDrawPrivates` stores that string byte-identically. Today
`storeDrawPrivates` recomputes `req.context ?? type.label`
(`gm/server/campaign.ts:533`) — harmless while both expressions match, but
once the server composes label + directive, recomputation diverges from the
committed string and the sealed context commitment **fails to reopen at
disclosure**, unrecoverably. Batches resolve a separate context per player.

### Batch construction is two-phase and transactional

This fixes a bug that is **live today**, not merely exposed by sealed
contexts. `batch()` builds every draft via `buildDraw` before appending any
entry, and `buildDraw` takes its commitment sequence from
`this.entries.length` (`gm/server/campaign.ts:467`) — so every draft gets
the same seq while `append` then assigns `base, base+1, base+2, …`. Members
after the first carry commitments salted with the wrong seq. Since the
standard player types have `seal_dc: true`, **any multi-player batch drawn
with a DC already commits unverifiable `dc_commit`s**; the failure surfaces
only at disclosure (inv 24), and no existing test discloses a batch. Sealed
per-player contexts would multiply the same defect.

Requirement:

> Before building, capture the base ledger sequence and one timestamp.
> Member `i` is assigned planned sequence `baseSeq + i`, and each commitment
> is computed with the exact sequence and timestamp `append` will preserve.
> Draft construction must not mutate cursors, `maxConcerned`, private
> values, or ledger state. Only after every member validates are all state
> effects and entries applied. Any failure leaves the ledger and all
> derived/private state unchanged.

Note: partial-failure rollback currently works by `mutate()`'s
resync-from-disk (`gm/server/campaign.ts:148-161`). Two-phase construction
makes atomicity structural rather than recovery-based; the resync remains as
the outer safety net.

### Code map

| Change | Where |
|---|---|
| `sheet-update` key validation: registry id → hardened profile name; snapshot semantics | `gm/server/campaign.ts:658`, `gm/core/verify.ts:397-399`, `verifier/verify.py:708-711`, `verifier/verify.html:521-522` |
| Modifier resolution: `(slot, check_type)` lookup → default-profile → snapshot value under the `(effective_from, seq)` rule, one clock read per draw | `gm/server/campaign.ts:479-486`, `playerSheetMod` at `:1187` (ignores `effective_from`; `verify.html:1020` is date-aware but lacks the seq restriction); `npc_sheets` stay a dateless current-value map |
| Batch: two-phase transactional build — planned seq `baseSeq + i`, one timestamp, no state mutation before full validation | `gm/server/campaign.ts` `batch` `:403-435`, `buildDraw` seq at `:467` |
| Draw API: `{profile: name}` xor `{modifier: n}` xor neither (default); both → reject; server composes context + `@mod` directive | `gm/server/campaign.ts` `buildDraw` `:438-524`, context at `:494` |
| `storeDrawPrivates` stores the exact resolved context from `buildDraw`, never recomputes | `gm/server/campaign.ts:526-535` (the `:533` recomputation) |
| Profile defaults as first-class private state (not opaque `ui_state`); `PendingModifier` is `Table.tsx` React state only; name validation and resolution server-side | `Priv` in `gm/server/campaign.ts:43-57`; expose defaults via `/api/table` |
| `/sheets` becomes profile editor (full-snapshot save, both roles) + per-type default picker; `effective_from` shown for player slots only | `gm/src/views/Sheets.tsx` (NPC save currently merges and shares the date field) |
| Table: `PendingModifier` (`m` / `,`), lifecycle per above, label visible on the mod chip, ANNOUNCED re-entry | `gm/src/views/Table.tsx:152-167` (saveModifier goes away), armed bar `:360-377`, `Announced` overlay `:523-571` |
| Modifier cross-check parses `@mod`; keyed by profile name; `manual` shown as override | `verifier/verify.html` §8.4 panel (~`:1014-1021`), `verifier/verify.py` equivalent |
| Spec text | `spec/protocol.md` §3.2 (`sheet-update` field note), §7.5, §8.4; §2.12 wording ("latest public sheet") |
| `public/verify.html` | byte-copy of `verifier/verify.html` — update both |

### Why this is cheap, and the format policy

Verified against the frozen vectors: `spec/vectors.json` has **no negative
case** pinning the sheet-update key rule, and the positive 80-entry ledger's
sheet-updates (keyed by toy registry ids) remain valid strings under the
relaxed rule. Snapshot-vs-patch resolution affects only the advisory
cross-check, never a verdict, so the frozen verdicts and named failures are
untouched. **No vector regeneration.**

**Ledger format stays `wotw-column-ledger/4`.** This is a declared policy
choice, not an oversight: the change is technically a verifier-language
change (old builds reject profile-keyed sheet-updates), but no supported
real `/4` campaign ledger exists yet, and the format string is embedded 25×
across the frozen vector ledgers — a bump would churn the frozen artifact
more than the change it marks. Pre-genesis verifier builds are declared
unsupported; ship the updated `verify.html` (both copies) before session
zero.

### Tests

Existing tests to update (they assume check-type-keyed sheets and
auto-fill): `gm/test/ui-interaction.test.tsx`, `gm/test/server.test.ts`.
New coverage, even though the frozen vectors are unchanged:

- profile removal via a later snapshot (omitted name stops resolving), for
  both player snapshots and NPC/world full-map replacement;
- an NPC/world save carrying `effective_from` is rejected, not ignored;
- future-dated player snapshots are ignored until effective; all-future →
  refusal;
- a backdated snapshot written *after* a draw is not that draw's applicable
  sheet (the `seq < draw.seq` restriction, verifier-side);
- a recovered announcement keeps Reveal disabled until an explicit profile /
  manual / use-default choice;
- a legacy draw context with no `@mod` line verifies with an advisory
  legacy/unattributed note, not a failure;
- blank, oversized, control-character, and `__proto__`-family profile names
  rejected;
- `m` and `,` never produce a `sheet-update`;
- ritual reload with a pending override: ANNOUNCED re-entry, no silent
  fallback to the default profile;
- a batch where players resolve different profiles and different contexts;
- a multi-player batch under `context_privacy: sealed` (and with a sealed
  DC) is disclosed and every independently composed commitment verifies —
  the regression test for the planned-sequence fix;
- a later batch member missing its profile rejects the entire batch: ledger
  length, cursors, and `maxConcerned` unchanged, and a retry begins at the
  original positions;
- committed draw context (label + `@mod` line) reopens byte-identically at
  disclosure — the `storeDrawPrivates` regression test;
- cross-check: `@mod "X"` verified against the snapshot in force at draw
  date; `@mod manual` rendered as override, not mismatch.

## Part 2 — The registry (15 types)

Replaces `SUGGESTED_REGISTRY` in `gm/src/views/Setup.tsx:10-23` and the §2.5
suggested-registry table in `spec/protocol.md` (kept in sync — the current
divergence between them is exactly the drift this fixes). Unless noted:
`lane: sealed`, `roles: [player]`, `seal_dc: true`, `seal_modifier: false`,
`ritual: false`.

### Major / announced (`ritual: true`)

| id | label | notes |
|---|---|---|
| `cosmology-major` | Major cosmology inquiry | Subject-based, not skill-based: Religion, Occultism, Society, a Lore, or Research depending on the declared approach — the profile picker handles this naturally. The label is announced aloud anyway, so it leaks nothing the table didn't witness; rename to `lore-major` if a more neutral label is preferred. |
| `research-major` | Major research check | Archival, documentary, experimental, Research-subsystem work. |
| `investigation-major` | Major investigation check | Other consequential, table-witnessed investigations. |

### Routine player

| id | label | typical profiles |
|---|---|---|
| `rk-general` | Recall Knowledge | Arcana, Crafting, Medicine, Nature, Occultism, Religion, Society, any Lore |
| `lore-roots` | Recall Knowledge — roots Lore | each player's origin Lore (see Part 3) |
| `perception-secret` | Secret Perception | Perception |
| `sense-motive` | Sense Motive | Perception |
| `decipher-identify` | Decipher / Identify | Society or a Lore (writing); Arcana/Nature/Occultism/Religion (magic); Crafting (alchemy) |
| `gather-information` | Gather Information | Diplomacy |
| `secret-skill-other` | Other secret skill check | anything — Deception (Lie/Impersonate), Stealth (out-of-initiative), forgery, rare feats. Listed last, visually quiet. |

`lore-roots` earns its registry slot despite the decoupling because the
*label* is campaign-meaningful: it is the deliberate delivery channel for
each character's origin knowledge, and its draw counts are worth seeing
distinctly in the ledger. Everything else that was skill-shaped collapses
into a profile choice on these seven.

### NPC & world (one rename, one reorder)

| id | label | lane | roles | seal_dc | seal_mod | ritual |
|---|---|---|---|---|---|---|
| `npc-secret` | NPC secret check | deep | npc | ✓ | ✓ | — |
| `npc-public` | NPC check the table watched | open | npc | — | ✓ | — |
| `world-routine` | World — routine | routine | world | ✓ | ✓ | — |
| `world-major` | World — major | deep | world | ✓ | ✓ | ✓ |
| `public-gm-check` | Public GM check | open | player, npc, world | — | — | — |

`world-major` replaces the stale `world-plot` label (the spec already says
`world-major`; only `Setup.tsx` drifted).

**The `npc-secret`-before-`npc-public` order is load-bearing.** Registry
order drives hotkey allocation (first unused letter of the id), and with
`npc-public` first the keys come out `n` = public, `p` = secret — inviting
the GM to press `p` for *public*. Those two types differ in lane (open vs
deep) and sealing, and a misfire burns a position and forces a public
`correction`. Listing `npc-secret` first yields `n` = **n**pc-secret,
`p` = npc-**p**ublic.

### Removed from the current `Setup.tsx` defaults

| Current | Action |
|---|---|
| `rk-cosmology` | → `cosmology-major` (the concept survives; PCs recall doctrine/folklore/revised history, not hidden truth) |
| `lore-mystery` | Remove — no such skill exists on any sheet, and the label telegraphs the campaign structure |
| `divination` | Remove — divination is setting behavior; any associated check uses a real knowledge/research type |
| `decipher-identify` | Keep merged; alchemy is the Crafting profile, not a new type |
| `world-plot` | → `world-major` |

### Hotkeys

The existing first-free-letter allocator (`Table.tsx:111-122`, reserving
`b`/`d`/`m`) assigns a stable distinct key to every type in this registry,
per armed role. `,` needs only a keydown handler — the allocator assigns
letters exclusively, so no reservation. Verified by running the allocator
against the tables above, in this order:

| Role | Keys |
|---|---|
| player | `c` cosmology-major · `r` research-major · `i` investigation-major · `k` rk-general · `l` lore-roots · `p` perception-secret · `s` sense-motive · `e` decipher-identify · `g` gather-information · `t` secret-skill-other · `u` public-gm-check |
| npc | `n` npc-secret · `p` npc-public · `u` public-gm-check |
| world | `w` world-routine · `o` world-major · `p` public-gm-check (9/0 pre-arm routine/deep as today) |

No explicit key map, no committed grouping; sticky arming keeps the common
flows at `Enter` (repeat), `digit Enter` (next player), `p b Enter` (party
batch). The player role shows eleven chips (3 major + 7 routine +
`public-gm-check`): render a thin client-side divider between major and
routine, derived from the `ritual` flag — presentation only, nothing in the
committed registry. Ritual types keep their existing visual distinction
(announce → reveal-or-void workflow).

Known compromises, accepted: `decipher-identify` lands on `e` because `d`
is permanently owned by DC entry; the same letter can mean different types
under different armed roles (`p` = perception / npc-public / public-gm-check),
which is safe — the wrong type cannot fire — but crosses muscle memory. If
rehearsal shows `,`-cycling through `rk-general`'s many profiles is tedious,
upgrade `,` to a one-letter mini-picker; decide from playtest, not now.

### Other setup defaults

- `context_privacy`: default **sealed** for this campaign. The check type
  stays public per draw; skill/profile labels and narrative context open on
  the disclosure schedule. Major checks are additionally announced aloud —
  phrase spoken context at the level the table has witnessed.
- Checks in initiative order remain physical dice (unchanged policy, §10.1).

## Part 3 — Campaign mapping

### Roots Lore: one type, four meanings

| Player | Character | `lore-roots` default profile |
|---|---|---|
| Giddeon | Sam / Apex | Brokhold Lore |
| Laura | — | Millbridge Lore |
| Matt | Bern | Aldermere Lore |
| Devon | — | Dunholm Lore |

Ceilings (roots Lore returns what a native remembers, recognizes, and
believes — never the hidden grain):

- **Brokhold**: Sett customs, ancestor practices, stonework, wrestling,
  local families, routes, the Wakes caravan. Not general Minotaur knowledge
  or true cosmology.
- **Millbridge**: local people, markets, bridge and tolls, institutions,
  rumors. Technical certification stays with Ungraven Lore.
- **Aldermere**: families, parish customs, paths, oral history, common
  village belief. Not private truths or revised-history mechanics.
- **Dunholm**: neighborhoods, institutions, capital customs, civic
  reputation. Not a substitute for Society or professional skills. **Needs
  wiki prep** — Dunholm has little established surface lore; write enough
  ordinary city knowledge to adjudicate consistently before heavy use.

`cosmology-major` stays subject-based: the declared approach picks the
profile (Religion for Canopy doctrine, Occultism for anomalies, Society for
institutional practice, a Lore, Research, …). It returns doctrine, folklore,
remembered anomalies, and revised history — never manufactured truth.
Correct player deduction stands without a confirmation roll. Rolls establish
what characters remember, notice, extract from evidence, or persuade someone
to disclose — not whether the players' theory becomes true.

### Choosing a type (precedence)

The check type says what audit ceremony is happening; the profile says what
PF2e statistic resolves it. Pick in this order:

1. **Table-announced major inquiry** → a major type: cosmological question →
   `cosmology-major`; formal non-cosmological Research work →
   `research-major`; other consequential investigation →
   `investigation-major`. The underlying skill is free — an announced major
   attempt to crack a cosmological question through interviews is
   `cosmology-major` with the Diplomacy profile.
2. **Otherwise the specific routine type** — casual canvassing about church
   doctrine is `gather-information` with Diplomacy, not a major.
3. **Fallback**: `secret-skill-other`, with whatever profile applies.

## Implementation sessions

Three coding sessions, each an independently safe checkpoint, then a
rehearsal/acceptance session. **Every coding session ends with the same
non-negotiable gate:**

> Entire repository suite green; all frozen vectors passing unmodified in
> all three verifiers; HTML verifier copies byte-identical; no
> diagnostic-parity regressions.

### Session 1 — backend and draw pipeline

The heavyweight session; blast radius is `campaign.ts` plus the minimal
validation slice of all verifiers. It must include that slice because the
server re-verifies the ledger via `gm/core/verify.ts` on every unlock
(`load()` refuses to start on failure), and `fuzz.test.ts` / `scale.test.ts`
run *generated* ledgers through Python and the HTML verifier — without the
slice, session 1 cannot end green.

- Full backend work from Part 1: player snapshot and NPC/world current-map
  models, profile defaults, name validation, `(effective_from, seq)`
  resolution, `{profile}`/`{modifier}` request exclusivity, canonical `@mod`
  composition with exact private storage, one timestamp per draw,
  transactional two-phase batch. Server/unit tests throughout.
- The **identical hardened profile-name predicate** in `gm/core/verify.ts`,
  `verifier/verify.py`, `verifier/verify.html`, and `public/verify.html`.
- Relax public player `sheet-update` keys: registry id → valid profile name.
- **Preserve** the existing rule that ledger `sheet-update` entries are
  player-only and require `effective_from` (no verifier change there).
- Server **API** rejection of `effective_from` on private NPC/world save
  requests; immediate full-map replacement for NPC/world saves.
- Byte-identical HTML verifier copies even at this intermediate milestone.

*Exit criterion*: all backend behavior works through API tests, including
disclosure of a sealed multi-player batch; gate passes.

### Session 2 — GM UI and registry

- `/sheets` profile editor: full-snapshot saves, per-type default picker,
  `effective_from` shown for player slots only.
- `PendingModifier` with `m` and `,`; the full clear/retain lifecycle.
- Recovered-ANNOUNCED confirmation gate, with a reload-simulation test (the
  existing `ui-interaction.test.tsx` announce-recovery pattern is the
  template).
- Batch restrictions (`m`/`,` disabled) and missing-profile warnings.
- Fifteen-type registry in `Setup.tsx`, major/routine divider, hotkeys,
  sealed-context default.

*Exit criterion*: the complete table flow works in rehearsal mode without
raw API calls; gate passes.

### Session 3 — verifier semantics and specification parity

- `@mod` parsing in all three verifiers; dated snapshot selection in the
  cross-check panels; legacy/unattributed compatibility; manual-override
  display.
- Protocol text: §2.5 suggested registry, §3.2 `sheet-update` field note,
  §7.5, §8.4, §2.12 wording.
- Byte-identical verifier copies; full frozen-vector suite and complete
  test suite.

*Exit criterion*: every verifier agrees, all vectors pass unchanged, and a
newly generated disclosed ledger cross-checks correctly; gate passes.

### Session 4 — campaign acceptance and rehearsal

1. **Rehearse** the full flow with the real roster in rehearsal mode:
   routine draw, alternate profile (`,`), manual (`m`), refused draw,
   batch, ritual reload with the recovered-ANNOUNCED gate, void,
   disclosure, and the full published-artifact path (close → disclose open
   lanes → publish → open `verify.html` against the published ledger).
   Decide the deferred `,`-mini-picker question from playtest. Fix only
   discovered defects.
2. **Wiki reconciliation**, before entering final modifiers:
   - Session Zero run-sheet: Devon's roots Lore is Dunholm Lore (currently
     "to declare").
   - Record the four roots-Lore mappings and ceilings in clue-routing, and
     consistently on all four player entries (none records the assignment
     today).
   - Players page: Giddeon's character is Swashbuckler (Acrobat/Wrestler),
     not Monk — this matters when loading profile values.
   - Players page: record Matt's background decision and the Aldermere/Bern
     assignment (currently undecided/unrecorded).
   - Add the Dunholm surface-lore entry (scattered capital mentions exist;
     no adjudication-grade surface lore).
   - Finalize each character's profile values and default mappings
     **externally** (notes, a spreadsheet). `/sheets` writes ledger entries
     and therefore requires a live campaign — real entry cannot precede
     genesis.
3. Real precommit → witnessed configuration → nonces → genesis. Players
   verify the exact committed registry before entering entropy.
4. Immediately after genesis, before session-1 play: enter the finalized
   profiles and defaults through `/sheets`. Sheet-updates need a live
   campaign but not an open session, so this fits between genesis and the
   first `session-open`.

### Rehearsal follow-up invariants

Session close is a persisted three-state ceremony:
`OPEN(n) → CLOSED_PENDING(n) → CLOSED_PUBLISHED(n)`. The close request names
the session, and an encrypted frozen receipt makes response-loss retries
return the original head, digest, count, and mirror result. No session or
ledger mutation may begin while recovery is pending, and standalone publish
is unavailable during play. Between-session standalone publication also
persists its frozen range, head, and digest before export, so an interrupted
retry cannot reuse a stale receipt or omit the mirror attempt.

Ordinary disclosure stops at the consumed draw cursor. Only final reveal may
extend through a trailing voided reservation; producers and all three
verifiers reject a later carrier at or below a disclosure watermark. A final
reveal is valid only after every lane reaches its highest concerned position
and every earlier commitment carrier has been opened.

Every new activation publishes only `role_class: player|non-player`. Exact
NPC/world role and display remain sealed, while the class supports pre-reveal
player sheet and check-type validation. Modifier reports use explicit
`private` and `role_sealed` statuses instead of renderer-side role inference;
legacy activations without `role_class` remain accepted.

## Acceptance criteria

- The setup wizard presents exactly these 15 types by default; spec §2.5 and
  `Setup.tsx` agree.
- A player's `/sheets` holds named profiles (~6–9 numbers), not a per-type
  matrix; `rk-general` can use Society on one draw and Occultism on the next
  without touching either saved value.
- A routine draw is still one keystroke; the selected profile and its
  current preview value are visible before Enter (the committed number is
  resolved server-side at draw time); a draw with no resolvable modifier is
  refused with the same visible warning as today.
- `m` and `,` never write a `sheet-update`; the pending modifier follows the
  single lifecycle above (cleared on re-arm/batch/success/void, retained on
  refusal); a recovered announcement disables Reveal until an explicit
  modifier choice, so a ritual reload can never silently fall back to the
  default profile.
- Server and all three verifiers share the resolution rule for public
  player snapshots: greatest `(effective_from, seq)` among snapshots with
  `seq < draw.seq` and `effective_from ≤ draw-date`. NPC/world modifiers
  resolve against the dateless current private map; the private NPC/world
  save **API** rejects `effective_from` (ledger `sheet-update` entries
  remain player-only with `effective_from` required — existing verifier
  rule, unchanged).
- Every draw emitted by the updated server carries exactly one final `@mod`
  line; verifiers treat missing directives as legacy/unattributed and
  malformed ones as advisory, never a verdict change; committed contexts
  reopen byte-identically at disclosure.
- All frozen `spec/vectors.json` vectors pass unmodified in all three
  verifiers; ledger format remains `wotw-column-ledger/4`, with pre-genesis
  verifier builds declared unsupported.
- The published draw format is unchanged: field form follows the check
  type's committed `seal_modifier` (`public-gm-check` publishes for every
  role); degree of success reproducible at disclosure.
- Both `verify.html` copies (`verifier/`, `public/`) are identical.
