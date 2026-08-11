# Prophecy Dice — Implementation Spec

**A verifiable prerolled-die ledger for a tabletop campaign.**
Protocol identifier `wotw-column/1`. Ledger format `wotw-column-ledger/4`.
Target: a coding agent implementing from scratch.

---

## 0. Read this first

Sections 2–5 are **normative** and byte-exact. The standalone browser
JavaScript and Python implementations must agree on them, and the test vectors
in §9 are the arbiter. Sections 6–8 define the application; where they conflict
with §2–5, §2–5 wins.

**Do not "improve" the crypto.** Do not substitute a KDF, add a salt where none is specified, reorder concatenations, or change hash functions. Every constant is load-bearing for cross-implementation agreement.

**This is a dice roller.** It resolves and audits GM-side die rolls. It is not a campaign manager, and must not grow into one — no session notes, no faction tracking, no NPC stat blocks beyond a modifier number, no initiative tracker. The verifier's auditability — a programmer tracing any one disclosed roll from ledger entry to verified value in fifteen minutes — is the product's core property, and every feature that isn't dice custody erodes it. Reject scope additions on this ground.

Five constraints shape the design:

1. **Most drawn values stay hidden long after the draw.** Used for Pathfinder 2e secret checks, which the game requires the GM to roll unseen. A player who learns their Recall Knowledge was a 3 knows the answer was unreliable. Leaking a sealed value early is a defect regardless of what else verifies.
2. **Some values are public immediately** — rolls the table watched resolve. Handled by independent lanes (§2.7).
3. **Volume is high.** 25–50 draws per session. Ergonomics are a correctness requirement: a system the GM abandons in session six verifies nothing. §7.3 is as load-bearing as §2.
4. **Anything selectable after seeing values must be committed in advance.** Lane assignment, slot allocation, and check-type taxonomy are all committed for this reason. When adding any feature, ask what it lets the GM choose post-observation.
5. **Deployment is a shared server, not a laptop.** Two network interfaces, two processes, hard separation (§6.6).

---

## 1. Purpose and threat model

### 1.1 What this is

A GM runs a year-long campaign in which all secret GM-side checks are resolved from prerolled d20 values committed to before play begins. Players, significant NPCs, and the world each have columns. The GM draws when a qualifying check occurs and, for secret checks, does not reveal the number.

The players are professional programmers. The system exists so they can verify the GM's honesty rather than assume it — as much during play as the game's secrecy rules permit, and all of it afterwards.

### 1.2 What the system proves, and when

**Live:**

- **Fair generation, conditional on a witnessed ceremony.** Players first
  witness the secret commitment, then the exact configuration commitment, and
  only then reveal their nonces. At least one nonce must be unpredictable to
  the GM before the configuration is fixed and should be generated on a
  player-controlled device. The final ledger lets players recompute both
  commitments. The ledger alone cannot prove when the group-chat anchors were
  posted or how a nonce was generated.
- **Custody and count.** Every draw publishes a record naming the slot, lane, position, session, check type, and (for player slots) modifier. Positions run 1,2,3,… with no gaps.
- **Append-only history.** Hash-chained; published entries cannot be reordered, deleted, or relabelled.
- **Timing.** Timestamped, published on a stated cadence, fixing the record of *why* a roll happened while the table still remembers.
- **Open-lane values**, verified at the next publish.
- **Allocation discipline.** Slots activate in strict ascending order (§2.9), so the GM cannot shop among pre-read columns when a new player or NPC needs one.

The key insight: because a lane's tail was committed at session zero, publishing "slot-02, sealed, position 23" **already pins that value irrevocably**. Nobody but the GM can compute it; the GM cannot change it. A sealed record is a real commitment.

**At scheduled disclosure (§4.4) and final reveal:** value verification with DCs and degrees of success; then the master secret, every column recomputed, and all values — including those never drawn — inspectable.

### 1.3 What the system does NOT prove — implement verbatim in the player UI

The GM's machine computes the columns. **The GM can read every future value at any time**, and no software on GM-controlled hardware prevents this. Therefore:

- **Omission is undetectable.** Reading ahead, seeing an unfavourable value, and declining to call for that check produces a consistent ledger. Non-invocation consumes nothing and logs nothing.
- **Scheduling is undetectable.** Seeing high values queued and arranging a pivotal scene leaves no trace.
- **Under-reporting is not cryptographically detectable.** Nothing forces the GM to log a draw. What constrains it is prompt publication plus human memory — and **at this volume, memory is weak.** Five people will remember whether a climactic declared check happened; they will not remember whether session 14 held nine or eleven routine secret checks. The count guarantee is strong for ritual draws and weak for routine ones. The UI must say so rather than presenting one number for both.
- **Statistical audit is the compensating control.** Thousands of disclosed draws per player give chi-square and runs tests real power that ritual-only volume would not.
- `reveal-all` (§7.3.9), announce-before-draw (§7.3.4), and ordered allocation are **speed bumps and social ritual** except where explicitly verifier-enforced.
- **External witnessing is required.** A hash chain prevents changing history only relative to a head players already saved. Until a commitment or head is copied to player-controlled chat or a mirror, the GM can replace the whole unpublished artifact.
- **The bundled offline verifiers do not authenticate drand BLS signatures.** They verify that an exact activation declaration preceded a sufficiently future round and that the recorded randomness is bound into the column. A player must compare `(chain, round, randomness)` with an official drand explorer. Without that comparison, a GM-controlled beacon endpoint can fabricate randomness.

Closing the remaining holes requires removing the key from GM control entirely (§10.3). State all of this plainly; a tool that overclaims is worse than no tool.

---

## 2. Cryptographic specification (normative)

### 2.1 Primitives

SHA-256 throughout. HKDF-SHA256 (RFC 5869), extract-then-expand, full form. OS CSPRNG for randomness. All hex is lowercase, unpadded, no `0x`.

### 2.2 Constants

UTF-8 byte strings, no trailing NUL:

```
SALT        = "wotw-column/1/salt"
TAG_CHAIN   = "wotw-column/1/chain"
TAG_DIE     = "wotw-column/1/die/20"
TAG_CONTEXT = "wotw-column/1/context"
TAG_DC      = "wotw-column/1/dc"
TAG_MOD     = "wotw-column/1/mod"
TAG_LABEL   = "wotw-column/1/label"
TAG_ENTROPY = "wotw-column/1/genesis-entropy"
TAG_CONFIG  = "wotw-column/1/genesis-configuration"
INFO_PREFIX = "wotw-column/1/slot/"

TAG_SALT_DC  = "wotw-column/1/salt/dc"
TAG_SALT_MOD = "wotw-column/1/salt/mod"
TAG_SALT_CTX = "wotw-column/1/salt/context"
LABEL_INFO   = "/#label"        (HKDF info suffix; `#` cannot occur in a lane name)
```

**Die size is fixed at d20.** `TAG_DIE` is not parameterized. If other die sizes were ever supported, size would have to be a committed property of the check type, never a per-draw choice — otherwise one link could be read as a d20 or a d100 and the GM could select after seeing both.

### 2.3 Canonical JSON

Any hashed structure MUST serialize as: keys sorted ascending by Unicode code point; no insignificant whitespace; minimal JSON escaping (`"`, `\`, C0 controls as `\u00XX`), NFC-normalized; **integers only** (range −2⁵³…2⁵³, no exponent, decimal point, leading zeros, or `+`) with floats forbidden; `null`/`true`/`false` literal; UTF-8 output.

Share a `canonicalize()` and test against §9.

`decimal_string(n)` is the minimal signed decimal representation used wherever an integer is hashed: optional leading `-`, never `+`, no leading zeros, `"0"` for zero.

### 2.4 Master secret and commitment

```
S = 32 random bytes
C = hex(SHA256(S))
```

`C` is published **before** any player entropy is collected. This prevents the GM from searching over `S`, but is not the whole anti-grinding argument: configuration choices also select roots and routing. The separate configuration commitment in §2.6 must be witnessed before nonce entry.

At least one player nonce must have enough unpredictability that the GM could
not know it while choosing the configuration. A player should generate it on
their own device after the configuration commitment is visible, then type or
paste it at the table. The helper in the GM-controlled browser is convenient
but is not independent entropy against a malicious GM.

### 2.5 The check-type registry

Committed at genesis inside the transcript:

```json
{
  "id": "research-major",
  "label": "Major research check",
  "lane": "sealed",
  "roles": ["player"],
  "seal_dc": true,
  "seal_modifier": false,
  "ritual": true
}
```

- `lane` — which lane name the draw consumes. Must exist on the target slot.
- `roles` — subset of `["player", "npc", "world"]`; scopes which UI section offers this type and which slots may use it.
- `seal_dc` — DC committed rather than published at draw time.
- `seal_modifier` — modifier committed rather than published.
- `ritual` — `true` requires an `announce` followed by exactly one `draw` or `void`; the server and verifiers enforce it. `false` permits one-keystroke draws.

**Why committed rather than configured:** without it, "which lane does this check use" is a free parameter exercised after seeing both candidate values — a fresh instance of the omission problem, and an unusually legible one, being a binary choice between two known numbers. Committing the taxonomy makes lane assignment a property of the check type, not a per-roll decision.

The registry is frozen at genesis. Adding or amending a type after the GM can
read the lanes would let the GM reroute a check to a preferred value; the
server has no mutation route and verifiers reject `check-type` entries.

Entries are **check types, not skills.** PF2e's secret trait does not partition by skill: Recall Knowledge, Sense Motive, Decipher Writing, and Identify Magic carry it; Perception against undetected creatures is secret by GM judgement; and the same skill can split by action — recalling hidden information may be sealed while identifying an object everyone can inspect may be open.

Suggested starting registry (GM edits at ceremony):

| id | lane | roles | seal_dc | seal_mod | ritual |
|---|---|---|---|---|---|
| `research-major` | sealed | player | ✓ | — | **✓** |
| `lore-major` | sealed | player | ✓ | — | **✓** |
| `investigation-major` | sealed | player | ✓ | — | **✓** |
| `rk-general` | sealed | player | ✓ | — | — |
| `perception-secret` | sealed | player | ✓ | — | — |
| `sense-motive` | sealed | player | ✓ | — | — |
| `decipher-identify` | sealed | player | ✓ | — | — |
| `npc-public` | open | npc | — | ✓ | — |
| `npc-secret` | deep | npc | ✓ | ✓ | — |
| `world-routine` | routine | world | ✓ | ✓ | — |
| `world-major` | deep | world | ✓ | ✓ | **✓** |
| `public-gm-check` | open | player, npc, world | — | — | — |

### 2.6 The transcript

Fixed at the end of session zero:

```json
{
  "version": "wotw-column/1",
  "commitment": "<hex 64>",
  "chain_length": 20000,
  "created_at": "2026-08-14T19:32:11Z",
  "campaign": "Example Campaign",
  "context_privacy": "plain",
  "disclosure_policy": "Sealed and deep lanes: opened after a table-agreed delay. Open lane: opened at each session-close. Routine lane: opened every few sessions. Full reveal at campaign end.",
  "configuration_commitment": "<hex 64>",
  "check_types": [ … ],
  "slots": [
    { "id": "slot-01", "display": "Alice", "role": "player", "status": "active", "lanes": ["sealed","open"], "nonce": "correct horse battery staple" },
    { "id": "slot-02", "display": "Player Two", "role": "player", "status": "active", "lanes": ["sealed","open"], "nonce": "9f2c81..." },
    { "id": "slot-03", "display": "Carol", "role": "player", "status": "active", "lanes": ["sealed","open"], "nonce": "..." },
    { "id": "slot-04", "display": "Dave",  "role": "player", "status": "active", "lanes": ["sealed","open"], "nonce": "..." },
    { "id": "slot-05", "display": "Eve",   "role": "player", "status": "active", "lanes": ["sealed","open"], "nonce": "..." },
    { "id": "slot-06", "display": "the world", "role": "world", "status": "active", "lanes": ["open","routine","deep"], "nonce": "..." },
    { "id": "slot-07", "display": null, "role": null, "status": "deferred", "lanes": null, "nonce": null },
    …
    { "id": "slot-64", "display": null, "role": null, "status": "deferred", "lanes": null, "nonce": null }
  ],
  "beacon": null
}
```

Rules:

- `slots` ordered by `id` ascending, `slot-NN` zero-padded, contiguous from `slot-01`.
- `status` ∈ `active` (fully specified now) | `deferred` (reserved; role, lanes, display, and nonce all supplied at activation).
- **Reserve generously. Default: 64 slots**, 6 active: five players plus the world. Slots cost a few kilobytes of transcript and milliseconds of derivation; exhaustion is a real operational failure and reservation is nearly free.
- `context_privacy` ∈ `plain` | `sealed`. Default `plain`.
- `disclosure_policy` is free text with no machine meaning; it commits the GM's stated cadence.
- `chain_length` (N): **default 20000** (§5.7).
- `beacon` is exactly `null`; only later activation uses a beacon.

Before nonce entry, form `genesis_configuration` from the prospective
transcript by omitting `created_at` and `configuration_commitment` and
replacing every slot's `nonce` with `null`. All other transcript fields remain,
including `C`, chain length, roster order and names, lane sets, registry,
privacy mode, policy, reserved slots, and `beacon: null`.

```
configuration_commitment =
  hex(SHA256(TAG_CONFIG || canonical_json(genesis_configuration)))
```

Players copy that value to player-controlled chat and only then type nonces.
The final transcript includes it, and every verifier recomputes it. As with
`C`, the ledger proves equality but the chat timestamp/witness proves order.

Two hashes are then derived:

```
T = SHA256(canonical_json(transcript))        // audit fingerprint only
E = SHA256(TAG_ENTROPY || canonical_json(player_nonces))
```

`player_nonces` is the multiset of non-empty NFC-normalized nonces from
genesis-active player slots, sorted by UTF-8 bytes. At least one is required.
World and NPC nonces are recorded but do not enter `E`; including GM-controlled
text or nonces would let the GM vary them after seeing player entropy and grind
for favorable columns. `T` fingerprints the exact public transcript but is not
KDF input.

**What the nonce fields are and are not.** The configuration commitment
deliberately nulls every nonce, because it is witnessed before nonces exist.
Three cases, stated precisely:

- **Genesis player nonces** feed `E` and therefore every genesis lane root.
  Like every transcript byte they are bound by the genesis entry's hash, so a
  crude in-place edit fails hash recomputation immediately. What no verifier
  can detect before final reveal is a **fully rehashed replacement ledger**
  built around a different nonce — no implementation knows what a nonce was
  *supposed* to be. At final reveal the substitution surfaces (the original
  `E` no longer reproduces the published tails), and before then it is caught
  only by comparing against the genesis head players saved at session zero.
  Every player should record their own nonce and that head.
- **Genesis world/NPC nonces** enter neither `E` nor the configuration
  commitment, and final reveal performs no semantic recheck on them. They are
  byte-bound by the witnessed genesis head like everything else in the
  transcript, but nothing derives from them; their unpredictability duty is
  carried entirely by `S`. Treat them as a record, not a commitment.
- **Later-activation nonces are real commitments.** An activation nonce is
  part of the public declaration, is hashed into `A`, and `A` enters every
  lane root of that slot (§2.7–§2.8). Changing it changes the columns and
  breaks the declare/activate byte-equality that verifiers enforce.

### 2.7 Lanes and root derivation

Each slot has a **declared list of lanes**, each an independent chain:

```
IKM  = S || E                    (slot active at genesis)
IKM  = S || E || A               (slot activated later; A per §2.8)

info = INFO_PREFIX || utf8(slot_id) || "/" || utf8(lane_name)
       e.g. "wotw-column/1/slot/slot-02/sealed"

root = HKDF-SHA256(ikm = IKM, salt = SALT, info = info, length = 32)
```

Lane names are free-form lowercase identifiers matching `[a-z][a-z0-9-]{0,31}`.

**Why lanes are independent chains:** disclosure is a prefix operation (§2.13) — revealing position 23 opens 1–22. Lanes with different disclosure schedules must not share a chain, or one publicly-verified roll retroactively unseals every secret check since session one. The world column needs three: `open` (rolls the party watched), `routine` (low-stakes secret rolls, short lag), and `deep` (sensitive rolls whose early disclosure could reveal that an unseen event occurred).

**Why lanes are frozen:** the lane name enters the HKDF `info` string. Letting
the GM add or rename lanes after seeing columns would create a search and
routing surface. Genesis-active lane sets are in the witnessed configuration;
a later slot's complete lane set is in its public activation declaration.
There is no `lane-add` operation.

### 2.8 Activation records

One protocol for every later addition — a joining player, a newly-significant NPC, the world column if not created at genesis. First append and immediately publish an `activation-declare` entry whose `declaration` is:

```json
{
  "version": "wotw-column/1",
  "slot": "slot-07",
  "lanes": ["sealed", "open"],
  "label_commit": "<hex 64>",
  "nonce": "supplied string",
  "declared_at": "2027-01-09T18:00:00Z",
  "beacon": { "chain": "drand:8990e7a9…", "round": 5931004,
              "genesis_time": 1595431050, "period": 30 }
}
```

No other ledger entry may follow while the declaration is pending. After the
round publishes, `activate` must be the immediately adjacent entry. Its
`activation_record` is byte-for-byte the declaration except that `beacon`
also contains `"randomness": "<hex 64>"`.

```
label_commit = hex(SHA256(TAG_LABEL || salt_label || canonical_json({display, role})))
A            = SHA256(canonical_json(activation_record))

salt_label   = HKDF-SHA256(ikm = S || E, salt = SALT,
                           info = INFO_PREFIX || utf8(slot_id) || "/#label", length = 32)
```

`salt_label` is **derived, not stored**: its only job is blinding the low-entropy `{display, role}`, and secrecy needs only `S`. `#` cannot occur in a lane name, so the info string cannot collide with any lane derivation. The IKM deliberately excludes `A` — `A` hashes the activation record, which contains `label_commit`, which needs `salt_label`; including `A` would be circular. At final reveal, `labels` are published and each verifier re-derives the salt itself (§3.2). Hand a joining player their derived salt privately so they can verify their column is theirs.

- **`beacon` is REQUIRED**, and `beacon.round` MUST publish at least 10 minutes after `declared_at`. Activation beacons carry the chain's `genesis_time` and `period` (integers, Unix seconds), so any verifier can compute `round_time = genesis_time + (round − 1) × period` offline and check `round_time ≥ declared_at + 600`. Verifiers embed parameters for well-known drand chains and fail when a recognized chain hash carries mismatched parameters.
- **Authenticity is a separate manual check.** The bundled offline verifiers do not implement BLS verification and the ledger does not carry a signature. A player must compare the recorded chain, round, and randomness with an official drand explorer. The GM service checks the API response's round, format, and `SHA256(signature) == randomness`, which catches malformed responses but does not make a GM-selected endpoint trustworthy.
- **`nonce` is REQUIRED regardless of who supplies it.** A joining player brings their own; for an NPC or world slot the GM generates one. It is cryptographically redundant — the beacon carries the unpredictability — but its presence must not vary, or the field becomes a tell distinguishing player activations from NPC ones. Because the nonce is committed in the pending activation *before* the beacon publishes, there is no grinding either way.
- **Labels seal uniformly.** If NPC labels sealed and player labels published, the difference would reveal which kind of activation just occurred — and an unrevealed NPC name appearing beside a slot would tell the table that character is mechanically special. Hand a joining player their own `salt_label` privately so they can verify their column is theirs.

Slots active at genesis publish `display` and `role` in plaintext; everyone at the table already knows the founding roster, and sealing it would only make the ledger unreadable. Only *later* activations seal.

### 2.9 Ordered allocation

An activation MUST target the **lowest-numbered slot with `status: "deferred"` and no prior activation.** The verifier enforces this: activation entries, in `seq` order, must reference strictly ascending slot ids with no gaps in the deferred sequence.

**Why:** a free pool of pre-read reserved columns would let the GM choose which one a new player or NPC receives after having seen all of them — label-grinding at coarser granularity. It also hollows out the fiction: "these instincts were written before anyone knew him" is much weaker if the GM picked which pre-written column to use.

With an authentic beacon this is technically redundant, since the column does not exist to be shopped among until the round publishes. Keep both because it is cheap to check and makes allocation intent unambiguous.

**Activate in small batches** where possible, so activation timing does not correlate with plot events.

### 2.10 The hash chain

Per slot per lane:

```
link[0] = root
link[i] = SHA256(TAG_CHAIN || link[i-1])       for i = 1 .. N
tail    = hex(link[N])
```

One tail published per lane at genesis or activation.

### 2.11 Consumption and value derivation

Positions are per `(slot, lane)`, numbered `k = 1, 2, 3, …`, consuming backward: `draw k` consumes `p_k = link[N - k]`. Drawing beyond `N` is a hard error (§10.2).

```
d    = SHA256(TAG_DIE || p_k)
roll = 1 + (int_be(d) mod 20)
```

`int_be` reads 32 bytes as an unsigned big-endian integer. Modulo bias ≈2⁻²⁵⁰ is explicitly accepted; do **not** implement rejection sampling — it would break cross-implementation agreement.

### 2.12 Sealed DCs, modifiers, and contexts

```
p   = preimage of the concerned position (below)
seq = the committing entry's seq

salt_dc  = SHA256(TAG_SALT_DC  || p || utf8(decimal_string(seq)))
salt_mod = SHA256(TAG_SALT_MOD || p || utf8(decimal_string(seq)))
salt_ctx = SHA256(TAG_SALT_CTX || p || utf8(decimal_string(seq)))

dc_commit      = hex(SHA256(TAG_DC      || salt_dc  || utf8(decimal_string(dc))))
mod_commit     = hex(SHA256(TAG_MOD     || salt_mod || utf8(decimal_string(modifier))))
context_commit = hex(SHA256(TAG_CONTEXT || salt_ctx || utf8(nfc(context))))
```

Salts are **derived, not random**. DCs, modifiers, and contexts are low-entropy and would be brute-forceable unsalted — but before disclosure nobody except the GM knows `p`, so nobody can derive the salt; after disclosure everyone derives it for free. `disclose` therefore ships opened values and no salt material at all (§3.2), the salt-present-but-value-missing desync failure mode cannot exist, and the GM stores no per-draw salt state that could be lost independently of the links. Commitment unlinkability rests on `p` being unique per `(slot, lane, position)` — which holds, positions never repeat — and binding `seq` into the derivation makes salt uniqueness structural even across entries that concern the *same* position: a voided `announce` and a later re-announce or draw at that position can never share a salt, even with identical plaintexts. Context strings are NFC-normalized before hashing so the commitment preimage matches the canonical-JSON form of the later-disclosed value.

**Concerned position:** a `draw` commits against its own `position`; a `dc-late` against its target draw's `position`; an `announce` against the position it reserves — 1 + the number of draws of that slot and lane with smaller `seq`. GM-side this is always computable at write time, since the GM holds every chain.

**Player modifiers publish in plaintext** (`seal_modifier: false`). A player already knows their own bonus, so publishing it leaks nothing and buys the one check cryptography cannot provide: verification against a source of truth the GM does not control. If the ledger says `+3` and the sheet says `+8`, the player catches it. In practice this catches honest arithmetic errors — PF2e modifier stacking is error-prone — far more often than anything adversarial. It also solves the archival problem of reconstructing an old bonus after many sessions and level changes.

**NPC and world modifiers seal** (`seal_modifier: true`). Publishing a large hidden-character modifier can reveal that character's approximate level or capabilities.

Every `draw` has exactly one modifier form: `modifier` or `mod_commit`,
according to its registry type. A modifier is mandatory even when it is zero.
For player slots the server may fill it from the latest public sheet; NPC and
world values come from private sheet state and open through disclosure.

**DCs seal for all secret checks.** This is the worst available live leak: a player knows their bonus is +8, sees `DC 30` the next morning, and can infer whether their character probably succeeded before a single value is disclosed. Even `DC 12` reveals too much. Sealing also pins difficulty at draw time, making DCs comparable in aggregate at reveal: an unusual run such as `18, 18, 18, 18, 31` on one check type becomes visible and answerable.

DCs may be **omitted** at draw time and supplied later in the same session via `dc-late` (§3.2). A draw with no DC yields no degree of success.

### 2.13 The prefix disclosure property

Backward consumption means revealing one preimage opens every earlier draw in that lane and nothing later:

```
p_{k-1} = SHA256(TAG_CHAIN || p_k)
```

A disclosure of `(slot, lane, k, p)` verifies by hashing forward exactly `k` times and checking the published tail:

```
chain_step^k (p) == tail          where chain_step(x) = SHA256(TAG_CHAIN || x)
```

One 32-byte value opens an entire lane's history to position k. This makes rolling disclosure cheap and nightly open-lane disclosure free.

### 2.14 Degree of success (derived, never trusted)

```
total = roll + modifier
if   total >= dc + 10 : degree = 3   (critical success)
elif total >= dc      : degree = 2   (success)
elif total <= dc - 10 : degree = 0   (critical failure)
else                  : degree = 1   (failure)

if roll == 20: degree = min(degree + 1, 3)
if roll ==  1: degree = max(degree - 1, 0)
```

Compare the total first, then apply the natural-20/natural-1 shift. The verifier **computes** the degree and never trusts a logged one. A GM-logged degree may be recorded for cross-checking; a mismatch is **advisory, not a failure** — it usually means an unrecorded circumstance modifier or deliberate fiat, both legitimate.

---

## 3. The ledger

### 3.1 Entry format

```json
{
  "seq": 0,
  "ts": "2026-11-06T21:14:03Z",
  "session": 14,
  "kind": "draw",
  "prev": "<hex 64, or 64 zeros for seq 0>",
  "hash": "<hex 64>"
}
```

`hash = hex(SHA256(canonical_json(entry_without_hash_field)))`. `seq` monotonic from 0; `ts` RFC 3339 UTC, `Z`, second precision.

**The hash covers the public entry only.** Drawn values are never fields of a draw entry; they live in private state and arrive later in a `disclose` entry. Nothing is rewritten; the ledger is strictly append-only (§5.5).

### 3.2 Entry kinds

| kind | additional fields | meaning |
|---|---|---|
| `genesis` | `transcript`, `tails` (slot → lane → tail hex; deferred slots omitted) | always `seq: 0` |
| `session-open` / `session-close` | — | session boundaries |
| `announce` | `slot`, `lane`, `check_type`, `context`\|`context_commit`, `initiator` | ritual draw declared, unresolved |
| `draw` | `slot`, `lane`, `position`, `check_type`, `initiator`; `modifier`\|`mod_commit`; optional `context`\|`context_commit`, `dc`\|`dc_commit`, `announce_seq`, `batch`, `paired_with`, `pair_rule`, `gm_degree` | a value was consumed. **No `link`, no `result`.** |
| `void` | `slot`, `lane`, `announce_seq`, `reason` | announced ritual draw abandoned; nothing consumed |
| `correction` | `target_seq`, `reason`, optional `replacement_seq` | a draw was misfired (§5.8) |
| `dc-late` | `target_seq`, `dc`\|`dc_commit` | supplies a DC for an earlier draw in the same session |
| `out-of-band` | `check_type`, optional `slot`, `result`, `reason` | a physical-dice roll made while the system was unavailable; **consumes no position** |
| `disclose` | `slot`, `lane`, `through_position`, `preimage`, `opened` — array of `{seq, dc?, modifier?, context?}` sorted ascending by `seq` | opens that lane to `through_position` |
| `sheet-update` | `slot`, `effective_from`, `modifiers` (map check_type → int) | records a **player** PC's modifiers |
| `activation-declare` | `declaration` (§2.8, beacon without randomness) | exact later-slot inputs and a future round are public and frozen |
| `activate` | `activation_record` (§2.8), `tails` (lane → tail hex) | a deferred slot became live |
| `retire-slot` | `slot`, `reason` | no further draws for that slot |
| `note` | `text` | GM annotation, no cryptographic effect |
| `reveal-all` | `scope` | GM used the peek function |
| `final-reveal` | `secret` (hex 64), `labels` — array of `{slot, display, role}`, one per sealed activation, ascending by `slot` | campaign end |
| `closed` | `reason` | ledger terminated (§10.4) |

**Paired draws (fortune / misfortune).** Effects rolling twice consume two positions. The *later* draw carries `paired_with` (the earlier position) and `pair_rule` (`fortune`\|`misfortune`); the earlier entry is never modified. The verifier derives which value was used — higher for fortune, lower for misfortune — at disclosure.

**Batches.** A party-wide check writes one `draw` per slot sharing a `batch` id, identical `check_type` and DC treatment, written atomically: all entries land or none do.

**Field notes.** `initiator` ∈ `"gm"` | `"player"`. `effective_from` is `YYYY-MM-DD`. `session` is `0` for `genesis` and any entry before the first `session-open`. An `opened` element is `{seq, dc?, modifier?, context?}` where `seq` names the entry that carried the commitment — usually a `draw`, but an `announce` or `dc-late` too, which is why it keys by entry rather than position.

### 3.3 Ledger invariants (the verifier MUST check all)

**Structural:** (1) `seq` 0,1,2,… no gaps or duplicates. (2) Entry 0 is `genesis`, uniquely. (3) Each `prev` equals the previous `hash`; entry 0's is 64 zeros. (4) Each `hash` recomputes. (5) `ts` non-decreasing. (6) `commitment` is 64 hex chars.

**Custody:** (7) For each `(slot, lane)`, `position` values across draws are exactly 1,2,3,…m in increasing `seq` order and never exceed `N`. (8) Every draw with an `announce_seq` references an existing preceding `announce` of the same slot, lane, check type, **and initiator**; every `void` references the same slot and lane; each announcement is referenced by exactly one draw or void. (9) Ritual types require announce-before-draw; no `announce` may remain unresolved when a session closes. Draws, announces, and voids occur only in an open session, whose number must match ledger state. (10) Every draw's `check_type` exists in the genesis registry, its `lane` matches the registry, the target slot declares that lane, and the slot's `role` is in the type's `roles`; registry and lanes cannot change later. (11) Every `paired_with` references an earlier draw of the same slot, lane, and batch-or-session, and each draw belongs to at most one pair. (12) Every `dc-late` targets an earlier DC-less draw in the same session; at most one per draw. (13) Batch members are `seq`-contiguous and share `session` and `check_type`. (14) Every `correction` targets an earlier `draw` not already corrected. (15) No draw references a slot after its `retire-slot`.

**Allocation:** (16) Every `activate` targets the lowest deferred slot not yet activated; activation slot ids strictly ascend with no gaps (§2.9). (17) Every `activate` is immediately preceded by its exact public `activation-declare`; the only added field is 64-hex beacon randomness. The declaration's integer `genesis_time` and `period` satisfy `genesis_time + (round − 1) × period ≥ epoch(declared_at) + 600`; recognized chain parameters must match known values. (18) No draw for a slot precedes its `activate`. (19) Check types and a slot's lane set are frozen; verifiers reject `check-type` and `lane-add` entries.

**Leak check (hard failure):** (20) No public entry contains a `link` or any `salt` field at any nesting depth. `result` is allowed only as the root field of an `out-of-band` entry. Publication of a column value outside `disclose` or `final-reveal` is a spec violation and must be reported loudly. (`out-of-band` entries carry `result` by design — physical dice, no position — and MUST NOT carry any `*_commit` field; a sealed commitment is only well-formed on an entry with a concerned position.)

**Disclosure:** (21) For each `disclose`, `chain_step^through_position(preimage) == tail` for that slot and lane. (22) `through_position` strictly increases per `(slot, lane)` and never exceeds the highest concerned position (§2.12) of that slot and lane — draws' positions plus `announce` reservations, so a trailing voided announce can still be opened at final reveal. (23) Derived values: for each draw at position `j ≤ through_position`, `p_j = chain_step^(k-j)(preimage)`, result per §2.11, degree per §2.14 — computed, never trusted. (24) For each `disclose`: `opened` is strictly ascending by `seq` with no duplicates; it contains exactly one element for every commitment-carrying entry (`draw`, `announce`, `dc-late`) of that slot and lane with `seq` before the disclose whose concerned position is ≤ `through_position` and that no earlier `disclose` opened — and no other elements; each element supplies exactly the fields its entry committed (`dc` ↔ `dc_commit`, `modifier` ↔ `mod_commit`, `context` ↔ `context_commit`) and no others; each commitment recomputes from the derived salt (§2.12) and the supplied value.

**Final:** (25) If `final-reveal` exists: the session is closed; `SHA256(secret) == commitment`; the genesis configuration commitment and `E` recompute; every published tail and every consumed roll recomputes from the secret; every previously disclosed preimage matches; `labels` contains exactly one element per sealed activation (none for genesis-active slots), ascending by `slot`, and every `label_commit` recomputes from the derived `salt_label` (§2.8) and `canonical_json({display, role})`. (26) Only `closed` may follow `final-reveal`; `closed` requires final reveal and is the last entry.

All entry kinds also have exact allowed-field schemas. Unknown top-level fields,
malformed dates/timestamps, non-integer protocol numbers, impossible session
transitions, wrong seal forms, and nested forbidden leak fields are hard
failures rather than ignored extensions.

### 3.4 Published file

```json
{ "format": "wotw-column-ledger/4", "head": "<hex 64>", "entries": [ … ] }
```

`head` is redundant and exists so the GM can paste one short string as an out-of-band anchor.

---

## 4. Protocol phases

### 4.1 Phase 0 — Pre-commit (night before session zero)

GM generates `S`; app computes `C`; GM publishes `C` to the group chat with a timestamp. `S` persists encrypted (§6.4). **The app MUST refuse player nonces until a pre-commit is at least 1 hour old**, displaying its timestamp during the ceremony. Optional: anchor `C` with OpenTimestamps.

### 4.2 Phase 1 — Ceremony (at the table, session zero)

1. GM displays the published `C`; players confirm against the earlier chat message.
2. GM sets `N`, exact slot order and roster (default 64 slots, 6 active: five players plus the world), lane sets, `context_privacy`, `disclosure_policy`, and the complete **check-type registry**.
3. App validates those choices, computes `configuration_commitment`, displays the exact committed projection, and the players post that commitment to chat.
4. Only now does each player enter their own nonce. At least one player
   generates an unpredictable value on a player-controlled device after seeing
   the configuration commitment. The GM-browser CSPRNG helper is convenience,
   not independent entropy; never pre-fill.
5. App builds the final transcript, confirms the configuration commitment is unchanged, computes `T` and `E`, derives all active lanes, and displays **tails only**.
6. Players review their own nonce, slot, lanes, both hashes, and the exact transcript. App writes genesis; GM publishes and pastes the full `head` into chat.

Numbered wizard, "the players are watching" framing, everything legible across a table. **Rehearse first** (§7.8) — this ceremony happens once and cannot be repeated.

### 4.3 Phase 2 — Play

Per §7.3. Each session: `session-open`, draws, `session-close`, then **open-lane disclosure through the current position**, then export, publish, and post the digest (§7.7).

**Publish at session end, not during play.** Live publication would let a player watching the repo infer that a secret check just happened — the exact leak PF2e's secret-check rule exists to prevent.

### 4.4 Phase 3 — Rolling disclosure

At the cadence recorded in `disclosure_policy`, open a prefix of each lagged lane: pick a watermark far enough back that knowing the roll cannot change how players read a live situation, and write a `disclose` entry with its preimage and all covered opened values. Salts are derived and never published. Recommended: end of each arc, disclosing through the arc-before-last. The app records the policy and shows current lag per lane; it must not enforce a specific lag.

### 4.5 Phase 4 — Activation (new players and new NPCs)

One flow for all cases. Between sessions, the GM opens `/slots`, selects the next deferred slot (the app offers only that one), sets role and its complete lane set, enters or generates a nonce, and the app picks a drand round ≥10 minutes out, appends `activation-declare`, and immediately publishes it. The full declaration head must be witnessed before the round. For a player activation, the app displays `salt_label` for private delivery to that player so they can check their own hidden label immediately; it is never written to the ledger. No other ledger event may occur until completion. After the round publishes, the app fetches and sanity-checks the API response, writes the adjacent `activate`, and derives roots and tails. A player then compares the recorded randomness with the official drand round; the offline verifier does not perform this authenticity check.

Implement as two steps even though collapsing is tempting: the wait is what removes the GM's ability to reject an unfavourable outcome. Significant NPCs are visible at least a session ahead, so activate during prep. For a genuinely unplanned mid-session roll, do **not** mint a slot — use the world column's routine lane.

### 4.6 Phase 5 — Final reveal

Two halves, both required: (1) a `disclose` per slot per lane at its highest concerned position, with all remaining opened values; (2) a `final-reveal` containing `S` and all sealed `labels`, proving roots were derived honestly and unlocking every unconsumed remainder. If Shamir splitting was used (§10.3), reconstruct `S` from shares first.

---

## 5. Design notes the implementer needs

### 5.1 Why the chain runs backward

A forward chain seals everything until the last day. The backward chain gives the prefix property (§2.13): one revealed preimage opens all earlier draws and nothing later — exactly the shape rolling disclosure needs, and it makes nightly open-lane publication a single 32-byte value. This is the S/KEY construction and the core reason the scheme is worth building.

### 5.2 Why activation needs a beacon

Deriving a reserved slot from `S || E` would mean **the GM has known that
column since session zero**, exactly what a joining player wants to avoid.
Mixing `A`, which contains a future beacon value, means the column does not
exist until that value publishes. The public declare-then-wait sequence prevents
rejection grinding only when (a) the declaration head was independently
witnessed before the round and (b) the randomness is authentic. The first is a
hash-chain/chat check; because the bundled verifiers do not implement BLS, the
second is a manual comparison with official drand data.

There is no no-beacon fallback for activation. If drand is unavailable, wait or
use an already-active world lane for the unplanned roll.

### 5.3 Why announce-before-draw exists, and only for ritual types

The `announce` entry timestamps the decision separately from consumption, making every abandoned check a publicly visible `void`. That is real social control at low volume — voids should be rare and each is a conversation. At routine volume it is worthless and harmful: nobody scrutinises the ninth secret Perception check of the evening, and the ceremony cost would get the system abandoned. Hence `ritual: false` skips it. Both kinds verify identically.

### 5.4 Slot ids vs. display names

Derivation uses `slot_id` and `lane_name` only, never `display`. Allowing a chosen name into the KDF info would give a grinding surface (`"Alex"`, `"alex"`, `"Alex Example"`, …). Display names are cosmetic and sealed at activation; slot ids are structural and immutable. For genesis, the player-to-slot mapping and lane names are covered by the configuration commitment witnessed before nonce entry.

### 5.5 Why sealed draws need no seal field

Adding `sealed = H(link)` to a draw entry is redundant: the tail published at genesis commits to the *entire* column, so `(slot, lane, position)` uniquely determines the link and hence the result. **Publishing the position is the commitment.** Therefore the public draw entry simply omits the value; the entry hash covers the public form so players verify the chain knowing no values; disclosure appends rather than modifying; and a GM cannot swap a value later, since any published preimage must hash forward to a tail fixed at session zero.

### 5.6 What players see live

Who rolled, which lane, when, in which session, for what check type, with what modifier (player slots), how many times, and that the sequence has no gaps — plus open-lane values from the previous publish. Not live: sealed values, sealed DCs, sealed NPC modifiers, activation labels.

This is a commitment scheme with delayed opening, and the player UI should say so in those words. Players who do not follow the tail-commits-everything argument will badly undervalue the mid-campaign ledger.

### 5.7 Sizing

At 25–50 draws per session across ~50 sessions, a player's sealed lane may consume 1,500–2,500 positions; the world's routine lane may run higher. **Default `N = 20000`**: 20,000 SHA-256 operations per lane to derive (milliseconds), 640 KB per lane if cached — caching optional, recomputation from root is fast enough on demand. Warn at 80% consumption.

With 64 slots the transcript is a few kilobytes. Full-reveal audit recomputes only lanes that were actually created. Deferred slots that never activate have no `A`, no roots, and no columns to recompute — see §8.6 for the performance requirement.

Ledger size at 50 sessions × 40 draws ≈ 2,000 draw entries plus overhead, on the order of 1 MB of JSON.

### 5.8 Misfires are inevitable; design for them

One-keystroke draws at forty a session means firing on the wrong slot or check type. `void` only covers announced ritual draws, so a fumbled routine draw would otherwise consume a position with no honest way to say so.

The `correction` entry solves it: **the value stays burned.** It was consumed, the position is logged, it cannot be unspent. The entry marks it misattributed and optionally points at the replacement draw. Burned values surface at reveal as drawn-in-error, which is the honest presentation. Without this, the first fumble forces a choice between a corrupted ledger and lying in it.

---

## 6. Architecture and deployment

### 6.1 Two applications, deliberately unequal

| | GM app | Player verifier |
|---|---|---|
| Audience | one person, holds the secret | five skeptics |
| Complexity budget | normal | **severe** |
| Dependencies | may use a framework | **zero** |
| Form | server-hosted web app, private network | single self-contained HTML file |

The verifier's most important property is that a skeptical programmer can, in fifteen minutes, trace one disclosed roll from its ledger entry through the chain check to the verified value and be satisfied that path isn't lying. (Reading every invariant takes longer; the full check suite grew with the threat model, and correctness outranks the original whole-file reading target.) This outranks features, styling, and code reuse. **Do not share a bundled module**; duplicate the crypto into the verifier as readable, commented, dependency-free code. Duplication is the point.

### 6.2 Stack

- **GM app:** TypeScript + Vite + React. Backend a single Node service using `node:http` and `node:fs` only — no Express, no ORM, no database.
- **Player verifier:** one `verify.html`, vanilla JS, no build step, works from `file://` and static hosting. Includes a compact synchronous SHA-256 (§8.6).
- **Independent verifier:** `verify.py`, Python 3.11+, stdlib only. Identical verdicts. HKDF in ~12 lines of `hmac`.

### 6.3 Persistence

The GM service owns and is the sole writer of:

- `state/private.enc` — encrypted: `S`, drawn results and sealed field values, activation labels, private sheets, pending activation, bench/pin UI state, idempotency maps, and publication state. Roots, chains, cursors, and registry state are re-derived on unlock. (No salts — all salts are derived, §2.12/§2.8.)
- `state/ledger.json` — the unpublished working ledger used by the GM process.
- `public/ledger.json` — the published artifact.

Atomic writes (temp file in the same directory, `fsync`, `rename`). Append-only: reject any request modifying or removing an existing entry; verify the full chain on load; refuse to start on failure. Rotating backups of the last 20 ledger states in `state/backups/`.

**A single function owns the private→public projection.** Before projection or serialization, a recursive leak assertion rejects links, salts, and column results at any nesting depth; `out-of-band.result` is the one explicit exemption. Every write path goes through it. Unit-test both raw published bytes and nested-field rejection.

### 6.4 Secret at rest, and the locked/unlocked server

`state/private.enc` is encrypted with AES-256-GCM under a key derived from a GM passphrase via **scrypt** (N=2¹⁷, r=8, p=1).

The service is a **two-state machine**:

- **Locked** (on boot): no key in RAM. The GM app serves an unlock screen; `/ledger` and read-only history of already-published data remain available; **drawing is impossible**. This is the correct state after an unattended reboot — the app is alive and visibly locked rather than dead.
- **Unlocked**: passphrase submitted through the GM web UI over TLS; key held in memory only. Auto-relock after 12 hours idle, on explicit lock, and on SIGHUP.

Rate-limit the unlock endpoint (5 attempts per 15 minutes) and log attempts.
Unlock or pre-commit mints a random 256-bit administration token, returned in
an HttpOnly, SameSite=Strict cookie and held by the React client in memory only.
Every private read and every mutation requires it; locking clears it. Cross-site
POSTs and non-JSON POSTs are rejected. An unauthenticated `/api/ledger` serves
only the last explicit `public/ledger.json`, never the working ledger, so a
network peer cannot infer unpublished secret-check timing.

**Do not auto-unlock from a NixOS secret** (sops-nix, agenix) by default. It makes disk compromise total, and manual unlock is one action per boot on a machine that reboots monthly. Provide the option, off by default, with a warning in the module description.

Never log `S`; never write it to `public/` except in `final-reveal`.

### 6.5 Idempotent draws

Every draw is now a network round-trip, and one-keystroke draws over a flaky link can double-consume a position or leave the GM unsure whether a draw landed. **Positions are unrecoverable, so this must be solved properly:**

- The client generates a `draw_id` (UUIDv4) at keypress.
- The server persists `draw_id → entry seq` in private state.
- A retry with the same `draw_id` returns the original entry rather than consuming another position.
- Batches are idempotent as a unit under a single `batch_id`, atomically.
- `draw_id` is transport-level and does **not** appear in the ledger.

All mutations serialize through one server-side queue. Multiple concurrent GM clients are permitted (laptop plus tablet), but the UI shows a banner when another session is active, and cursor state is pushed over SSE so clients agree.

**No offline replay.** If the client cannot reach the server, fail loudly and fall back to physical dice logged afterward as `out-of-band` (§10.5). Client-side queueing of draws is the one thing that could corrupt position accounting.

### 6.6 Network topology (two interfaces, two processes)

**Hard separation, not just route separation.**

- **GM service** binds loopback behind `tailscale serve` (preferred), or a Tailscale interface directly behind equivalent TLS. Never bind a public interface. It holds every sealed value in the campaign; if `gm.<host>` resolves publicly, someone will poke it. TLS is required so the unlock passphrase is never sent in cleartext.
- **Public ledger + verifier** are served by a **separate static file server** (Caddy recommended, TLS via Let's Encrypt) bound to the public interface, serving `public/` read-only. This process holds **no key material and has no code path to private state**, so compromising it yields nothing beyond already-public data.

Additionally, the deployment may mirror `public/` to a git remote (for
example, GitHub Pages). It strengthens the audit only if players can inspect
the remote and its history cannot be quietly rewritten by the GM. A successful
configured shell command proves neither fact; the UI therefore reports
“command succeeded,” not “mirror confirmed.” Ledger timestamps are otherwise
GM-machine-generated and trivially forgeable, so player-controlled chat heads
remain the primary external anchors.

### 6.7 Backups

Losing `state/private.enc` and all usable backups **permanently destroys the
audit**, even if campaign play continues: sealed fields become unopenable and
the year-long payoff evaporates. Ship automated encrypted off-box backups,
keep the passphrase in a password manager, compare any restored head with the
newest player-witnessed head, and document a tested restore procedure in the
README. A timer-based remote backup can lag; an older pair must never be
silently resumed after players witnessed a newer head.

### 6.8 NixOS deployment

Ship a flake with a NixOS module providing:

- `services.column.gm` — the Node service, systemd unit, `bindAddress` (default `127.0.0.1`, suitable for `tailscale serve`), state directory with `0700`, a dedicated user, and hardening (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`, `RestrictAddressFamilies`).
- `services.column.public` — a Caddy virtual host serving `public/` on the public interface.
- A backup timer unit for §6.7.
- Options for the git mirror push command and the drand endpoint.

Development on macOS must work without Nix (`npm run dev` against a local state directory).

---

## 7. GM application — views

### 7.1 Shell

Routes: `/setup`, `/table`, `/slots`, `/sheets`, `/ledger`, `/disclose`, `/reveal`. Persistent status bar: campaign, session number, session-open state, lock state, entries since last publish, **red banner if unpublished entries exist**, and a banner if another client is connected.

### 7.2 `/setup` — the ceremony wizard

Linear and non-skippable per §4.1–4.2: Pre-commit → wait → confirm `C` → roster and lanes → registry → parameters → validate and post configuration commitment → collect nonces → review exact transcript, `T`, and `E` → write genesis. Once nonce collection begins, configuration controls are no longer reachable; correcting configuration requires restarting before entropy entry.

Presentation mode uses large type and high contrast. Nonce entry has one field
per player and a CSPRNG helper, never auto-filled. The review shows the exact
transcript values, its canonical hash `T`, and `E`; public tails appear in the
written genesis ledger. **Roots must never appear anywhere in the UI.** The
server refuses to proceed if the pre-commit is under one hour old.

### 7.3 `/table` — in-session play

**This screen is a correctness requirement.** At 25–50 draws per session, every avoidable interaction is a reason the GM abandons the system. Design target: **a routine draw costs one keystroke and zero typing.**

1. **Three sections**, because their selection axes differ: **Players** (five stable cards, digits 1–5, modifiers auto-filled from sheets, batch draw lives here); **NPCs** (a roster growing to dozens of which two or three matter per scene — needs a **scene bench**: pin the NPCs in play, only pinned ones get hotkeys 6–8, persisted in private state); **World** (one slot, several lanes — no person to select, so the card picks lane-plus-purpose, keys 9 and 0).
2. **Keyboard-first.** Digit selects a slot or lane; a letter selects a check type, scoped automatically to the selected slot's role; `Enter` draws. Dedicated keys handle batch, DC, veil, correction, session, and publication actions. Mouse-only must work but is not the design target.
3. Cards show positions consumed and remaining per lane, plus current disclosure lag.
4. **Ritual draws** (`ritual: true`): select → context sheet with picker and initiator toggle → **Announce** → large "ANNOUNCED" state offering only **Reveal** and **Void** → Reveal writes the draw, stores link and result privately, displays one very large numeral. **Voids are visually loud.**
5. **Routine draws** (`ritual: false`): one keystroke. No announce, no void. Context auto-fills from the type's label; modifier auto-fills from the sheet; DC optional. Result appears as a compact log line, not a full-screen numeral.
6. **Batch draw**: one action for all active player slots — the most common event in play. Two interactions total, written atomically with a shared `batch` id.
7. **Deferred DC**: any draw may be made without a DC and given one later in the same session; a session-end review list shows every DC-less draw for a quick pass. Never force DC entry mid-scene.
8. **Misfire**: an undo affordance on the last draw writes a `correction` (§5.8), states plainly that the position stays consumed, and offers to immediately re-draw correctly and link the two.
9. **Peek (`reveal-all`)**: behind a confirmation stating *"This writes a public `reveal-all` entry your players will see"*, writing the entry **before** displaying anything; if the write fails, show nothing. It is desirable for this to feel bad to use.
10. **Privacy key.** Results display on a machine five people may see. One keystroke blanks **all results and all NPC names** — the roster may include characters the players have not met yet, and a glance at one name can spoil an introduction. The NPC section defaults collapsed.
11. **Publish**: exports, writes the open-lane disclosure, copies `head`, generates the digest (§7.7), and optionally runs the configured git mirror push.

### 7.4 `/slots` — roster and activation

Lists all slots: active (role, lanes, positions, retired state), pending activation (with the awaited beacon round, full declaration head, and a countdown), and the next available deferred slot. Activation is the two-step flow of §4.5; the UI offers **only** the lowest deferred slot, making ordered allocation structural rather than a rule to remember. Also hosts `retire-slot`. Lanes are complete at slot creation and cannot be added later.

### 7.5 `/sheets` — modifiers

Editable per-slot modifier table keyed by check type. **Player** slots write a public `sheet-update` entry on save with an `effective_from` date, including players activated later. **NPC and world** sheets remain private; each modifier actually used in a draw is committed and opens with that draw at disclosure/final reveal (§2.12). The unused private sheet table itself is not a ledger artifact.

This is the highest-value ergonomic feature in the app: it removes typing from the hot path and produces a better archival record than manual entry would.

### 7.6 `/ledger` and `/disclose`

`/ledger`: filterable by kind, slot, session, and text (which also finds lane, check type, and batch); histogram with chi-square against uniform(1,20) **over disclosed draws only, with undisclosed count shown**; CSV export; read-only.

`/disclose`: per slot and lane, the highest logged position, current watermark, lag in draws, and the genesis `disclosure_policy` as a standing reminder. GM enters a target position. **Mandatory preview** lists exactly what becomes public — every covered draw with contexts, DCs, modifiers, results, and derived degrees. Getting this wrong is unrecoverable.

### 7.7 The publish digest

Nobody will read raw JSON after session three, and the memory-based count guarantee dies with it. Each publish emits a short human-readable block for the group chat:

```
Session 14 — 23 draws (19 sealed, 4 open), 0 voids, 1 correction
head 7f3a9c… (full 64 hexadecimal characters)
mirror command succeeded — confirm the remote commit and post this head
```

Posting it gives the timestamps an externally-witnessed anchor and makes "felt like more than nine Perception checks" a thing someone might actually say.

### 7.8 Rehearsal mode

Session zero happens once, in front of five people, on software that has never been run in anger. Rehearsal mode writes to its own state directory against a throwaway secret, has an unmistakable persistent banner, and is **structurally unable to be promoted to the real ceremony** (the flag rides inside the authenticated ciphertext, so the files cannot be reopened as a real campaign).

It **publishes into its own separate directory by default**, because the session-close wizard publishes and the player verifier reads a published artifact: a rehearsal that cannot publish cannot rehearse either of them, which is most of what a dress run is for. The development defaults isolate both state and publication from a real run, while explicitly configured directories are used exactly as supplied. A configured git mirror makes publishing a hard error, and the digest labels itself as a rehearsal, since the chat digest is the one artifact that travels without its context.

Delete that separate directory while the service is stopped when rehearsal is no longer needed. The same mode covers practice draws before session 1, which would otherwise burn real positions.

### 7.9 `/reveal` — the final ceremony

Behind a typed confirmation phrase. Requires a closed session, performs both halves of §4.6, then presents a **paced walkthrough** rather than a table dump: player by player, their disclosed history and statistics, then a bounded remainder preview; then NPCs, with labels finally opened; then the world; finally the ids of slots never activated. Never-activated slots have no beacon-derived `A`, so they never had columns. The public verifier can export every value of every created column's remainder.

This screen is the product's climax: every unused value from every column that came into existence, plus the ordered reservations for slots that never activated.

---

## 8. Player verifier — `verify.html`

Single file, no build. Opens a ledger by URL parameter (`?ledger=…`), file picker, or paste. **Must be readable on a phone** — that is where players will actually open it.

### 8.1 Verdict panel

One large verdict: **VERIFIED** / **FAILED** / **INCOMPLETE**, plus a checklist of every §3.3 invariant with pass/fail and, on failure, the exact `seq` and reason. Never a generic "verification failed".

Three states, and **sealed is never presented as a deficiency**: **Sealed** (structure and custody verified, values not yet openable — the normal mid-campaign state); **Partially disclosed**; **Fully revealed**.

Show: total entries, head fingerprint, timestamp of the last ledger entry and its age (explicitly not a publication timestamp), per-slot per-lane draw and void counts, correction count, `out-of-band` count, `reveal-all` count, disclosure lag, activation count, stated policy, and the frozen registry. If activations exist, show the drand-authenticity manual-check warning prominently.

### 8.2 Per-player history

One row per draw: date, session, lane, check type, position, modifier, initiator, batch. Sealed rows render plainly as sealed, not as errors or blanks. Disclosed rows add result, DC, total, and derived degree with expandable arithmetic:

```
2026-11-06 │ s.14 │ Player Two │ sealed #23 │ Major research check │ 17 +3 = 20 vs DC 22 → failure ✓
```

Corrected draws are visibly flagged as drawn-in-error. Paired draws render as a linked pair showing both values and which the rule selected. Histogram and running mean over disclosed draws, 10.5 marked.

### 8.3 Disclosure panel

Permanently visible, non-collapsible, titled "What this proves and what it doesn't", reproducing §1.2 and §1.3. Four things stated explicitly and unsoftened: sealed values are withheld because the game requires secret checks, and this protects the *player*; omission and scheduling are undetectable; the count guarantee is strong for ritual draws and weak for routine ones because it rests on players' memory; statistical audit at reveal is the compensating control. Include a plain-language version of §5.5 — why a sealed draw is nonetheless a real commitment. Most of the system's live value is in that argument.

### 8.4 Modifier cross-check

Every draw's published modifier grouped by check type and date range, alongside `sheet-update` history, so a player can compare against their own sheet in one pass. Flag disagreements — advisory, not a failure.

### 8.5 Post-reveal audit

With `final-reveal` present: check `SHA256(S)` against the commitment; recompute the configuration commitment and `E`; recompute every created root, chain, and tail and check all published tails and previously disclosed preimages; recompute all consumed values independently of disclosed preimages; open all activation labels; run **statistical tests** per slot (chi-square against uniform, runs test, streak extremes) with p-values and plain-language readings; preview the unconsumed remainder of every created column and provide a download containing every unconsumed value. List never-activated slot ids separately; they have no columns.

The last item is a feature, not a debug view.

### 8.6 Performance

Full-reveal audit may recompute tens of lanes × 20,000 links. `crypto.subtle.digest` is promise-based, and hundreds of thousands of sequential awaits will hang the tab. **Include a compact synchronous SHA-256 (~60 lines, a well-known construction)** for bulk chain walking, use WebCrypto for one-off digests, and cross-check the two at startup against a fixed vector. Show progress, run bulk work off the main thread where practical. A 10,000-entry ledger must verify in a few seconds; full reveal must complete without hanging, including on a phone.

### 8.7 `verify.py`

Same checks, CLI, exit 0/1, `--json`, `--vectors`, including the independent vector self-check. Comment the crypto and favor readable duplication over artificial line-count targets.

---

## 9. Test vectors and testing

### 9.1 `spec/vectors.json` (generated once, then frozen)

1. **Canonical JSON**: ≥8 objects covering key ordering, escaping, NFC, nesting, integer bounds — with expected bytes and SHA-256.
2. **Toy ceremony**: `S` = 32 zero bytes, fixed transcript, 2 player slots (lanes `sealed`,`open`) + 1 world slot (lanes `open`,`routine`,`deep`) + 2 deferred, `chain_length = 64`, `beacon: null`, fixed `created_at`, and a complete registry. Expected `T`, `E`, configuration commitment, and per-slot/per-lane roots and tails.
3. **First 10 draws** per slot per lane: position, preimage, result.
4. **Lane independence**: all roots differ; disclosing `sealed` at position 7 yields nothing about any `open` preimage.
5. **Prefix disclosure**: disclosure at position 7 with derived preimages and results for 1–6 and the forward-hash check reaching the tail.
6. **Degrees of success**: ≥16 cases covering all four degrees, both natural-20 and natural-1 shifts, and shifts clamping at the extremes.
7. **Commitments**: derived salts (fixed preimage and `seq`) and values for `dc_commit`, `mod_commit`, `context_commit`, `label_commit`.
7b. **Salt derivation**: one preimage yielding all three domain-separated salts, and two different `seq` values yielding distinct salts, so implementations cannot silently disagree on domain separation or `seq` binding.
8. **Paired draws**: a fortune pair and a misfortune pair with expected selected values.
9. **Activation**: a record with fixed beacon — expected `A`, all lane roots and tails, first 5 draws per lane.
10. **A complete 80-entry ledger** exercising genesis, sessions, ritual and routine draws, a batch, a paired draw, two voids, a correction, a `dc-late`, an `out-of-band`, a `sheet-update`, an adjacent public activation declaration and activation, a `retire-slot`, a `reveal-all`, rolling and nightly disclosures, final reveal, and `closed` — with every hash and the final head.
11. **Twenty-four negative cases**, each with its expected specific failure message: reordered entries; broken `prev`; skipped `position`; unmatched `announce_seq`; disclosure preimage not reaching the tail; decreasing watermark; a draw containing a `result` field; lane/type mismatch; role/type mismatch; activation skipping a deferred slot; a draw for a retired slot; wrong final secret; draw beyond `N`; impossible timestamp; invalid initiator; ritual draw without announce; activation changed after its declaration; unknown entry field; configuration changed after player entropy; an unknown ledger-envelope field; final reveal during an open session; a ritual draw whose purpose differs from its announcement; reuse of one draw in two paired rolls; and a ritual draw whose initiator differs from its announcement.

### 9.2 Tests

**Diagnostic-parity contract.** For every frozen §9.1 vector — the complete
ledger and each negative case — all three implementations must produce the
same verdict *and* the same named failure. For arbitrary malformed input, all
three must agree on the verdict and must never raise an unhandled exception,
but their diagnostic cascades may differ: the implementations bail out of
malformed structures at different depths, and chasing identical cascade
ordering under garbage buys no security. Accept/reject agreement is the
security property; message identity is promised only where the vectors pin it.

The checked-in automated suite currently covers:

- §2 primitives against shared vectors in TypeScript, with the complete ledger and all negative vectors independently checked by Python and the browser verifier.
- **Leak test (highest priority):** 300 draws are serialized and searched for every private link, result, and salt; recursively nested forbidden fields are also rejected before projection.
- Lane isolation, ordered activation, 50-way draw replay, batch replay and rollback, append-only startup validation, HTTP lock/auth behavior, restore from backup, and final-reveal concurrency.
- Three verifier implementations against a complete 80-entry ledger and twenty-four named negative ledgers.
- 300 randomly mutated ledgers through TypeScript, with a sample also passed to Python; degenerate inputs must fail cleanly rather than throw.
- A generated 10,000-entry, `N = 20000`, 20-slot fully revealed ledger through TypeScript, Python, and the browser verifier. This is a desktop CI performance check, not a claim about every phone.

Two worthwhile tests are not yet present: process-kill fault injection at each
filesystem-write boundary, and automated BLS verification of drand signatures.
The storage code uses temp-file + fsync + rename + directory-fsync, while beacon
authenticity remains the explicit player comparison described in §2.9.

---

## 10. Operational rules

### 10.1 Scope discipline

The registry defines scope; the boundary worth holding is **physical dice for anything in initiative order**. Attack rolls, damage, and NPC saves in combat are high-volume and mostly public; routing them through a laptop wrecks tempo for no audit benefit. Warn if a check type's draw rate suggests combat rolls are being funnelled into it.

Scope is a policy choice, not a structural one: narrowing mid-campaign costs nothing — stop drawing for routine types and the lanes keep working. The registry itself remains frozen; record a public `note` if the table changes its scope policy.

### 10.2 Exhaustion

Drawing beyond `N` is a hard error; warn at 80%. No epoch-extension protocol is implemented. Choose `N` generously at the witnessed configuration ceremony. If a lane is nevertheless exhausted, stop using the system, run final reveal, and close cleanly rather than improvising an unauditable continuation.

### 10.3 Optional hardening

The following ideas are **not implemented or bundled**:

- **Shamir split of `S`** (3-of-5) at ceremony end, with the GM wiping their copy and reveal requiring reassembly. The wipe would still be an unverifiable ceremony.
- **OpenTimestamps** anchoring of `C` and each published `head`.

*(Timelocked per-session batch unlock was considered and rejected as too tedious for a campaign whose sessions slip. It is the only option that would genuinely blind the GM; the §1.3 caveats stand permanently and player-facing text must not imply otherwise.)*

### 10.4 Exit ramps

- **`retire-slot`** for a departing player or a finished NPC: no further draws, remaining column disclosed at final reveal like any other.
- **`retire-system`**: if the GM stops using the tool mid-campaign, run Phase 5 in full and append a `closed` entry with a reason. Abandonment leaving a half-verified artifact is worse than a clean close, and the exit ramp should be one button.

### 10.5 Degraded mode

Server down, network out, drink spilled. The defined fallback is physical dice, logged afterward as `out-of-band` entries that are visibly **not** column draws and consume no position. A documented gap is far better than an undocumented one.

---

## 11. Repository layout

```
/spec/
  protocol.md                 ← this document
  vectors.json                ← frozen test vectors
/gm/
  src/                        ← React + TS
  server/index.ts             ← node:http, sole writer, private→public projection
  test/
/verifier/
  verify.html                 ← single file, zero deps, sync SHA-256 included
  verify.py                   ← stdlib only
/public/                      ← served by Caddy on the public interface; mirrored to git
  ledger.json
  verify.html                 ← copy, so players audit from the serving URL
flake.nix                     ← at the repo root: a flake cannot reference
                                paths outside its own tree
/nix/
  module.nix                  ← services.column.{gm,public}, backup timer
/state/                       ← gitignored, 0700; encrypted private state + backups
README.md                     ← includes the tested restore procedure
```

---

## 12. Acceptance criteria

1. TypeScript, Python, and browser JavaScript pass all shared §9 vectors. The
   complete generated ledger and every negative ledger receive the same verdict
   and named failure across all three.
2. A separate rehearsal is structurally unpromotable. The real lifecycle is:
   pre-commit → witnessed configuration → player entropy → genesis with a
   frozen registry → sessions mixing ritual, routine, batch, paired, corrected,
   and disclosed draws → ordered NPC/player activation with a public declaration
   and future drand round → `retire-slot` → final reveal with opened labels →
   post-reveal audit and complete remainder export.
3. Leak test, lane isolation test, ordered-allocation test, and idempotency test all pass.
4. **A routine draw is one keystroke with zero typing; a party-wide batch is two interactions.** Verified by a scripted interaction test, not by inspection.
5. `verify.html` is a single dependency-free file including its sync SHA-256,
   makes no external request other than fetching a ledger URL explicitly
   selected by the user, has a responsive layout intended for phones, and lets
   a reader trace a disclosed value from ledger entry to verified result.
6. Mid-campaign sealed state renders as **VERIFIED (sealed)**, never as an error or warning.
7. The §1.3 disclosure text, including the weak-count caveat, is present in the player view and not collapsible.
8. Any semantic change to a hashed entry, or any unknown schema field, causes
   a specific, correctly located failure. Insignificant JSON whitespace is
   intentionally not part of the canonical entry hash.
9. Roots and undisclosed values appear nowhere in the GM UI except behind the logged `reveal-all`, the disclosure preview, and the post-reveal audit.
10. The GM service defaults to loopback for `tailscale serve`; the NixOS public service is a separate static Caddy root containing only `public/`. HTTP integration tests assert that unauthenticated clients cannot reach private routes and can read only the last explicitly published artifact. Deployment-level Caddy permissions still require operator review.
11. After an unattended reboot the service comes up **locked**, serves the public ledger, and refuses to draw until unlocked.
12. Scale test passes at 10,000 entries, `N = 20000`, 20 activated slots.
13. **The restore test passes**: wipe `state/`, restore from an automated encrypted backup, resume with correct cursors, and disclose a historical position successfully.
