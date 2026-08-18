# Prophecy Dice

**A verifiable prerolled-die ledger for a tabletop campaign.**
Protocol `wotw-column/1` · ledger format `wotw-column-ledger/4` · spec: [`spec/protocol.md`](spec/protocol.md)

Every genesis-active secret GM-side d20 is fixed before session zero; later
slots are fixed by a witnessed declaration plus a future randomness-beacon
round. The GM commits to a master secret, the table freezes and witnesses the
roll-routing configuration, players contribute entropy, and every check
consumes the next position of a committed hash chain. Players can verify
custody, count, and order live — and every fixed value, including thousands
never drawn, at the end.

Be clear about the limits before trusting it: **omission and scheduling are
undetectable, and the count guarantee is weak for routine draws**. Fair
genesis also depends on the players witnessing two group-chat anchors in the
shown order (secret commitment, then configuration commitment, then nonces),
and on at least one player generating an unpredictable nonce on a
player-controlled device only after the configuration is fixed.
The offline verifier does not authenticate drand's BLS signatures, so players
must compare every later activation's round and randomness with an official
drand explorer. The verifier says these limits plainly (§1.3). A tool that
overclaims is worse than no tool.

## Layout

```
spec/protocol.md      the normative spec — §2–§5 are byte-exact
spec/vectors.json     frozen test vectors: the cross-implementation arbiter
gm/                   GM app: React UI (src/), node:http service (server/),
                      shared normative core (core/), tests (test/)
verifier/verify.html  player verifier: ONE file, zero deps, works from file://
verifier/verify.py    independent verifier: Python 3.11+, stdlib only
public/               published artifacts (ledger.json + verify.html copy)
flake.nix             nix build + NixOS module (nix/module.nix)
```

The server-side TypeScript verifier shares the normative crypto primitives
with the producer. The standalone Python and browser-JavaScript verifiers
reimplement them independently; all three are held to `spec/vectors.json`,
including byte-identical failure messages for 24 adversarial cases.

## Development

```sh
cd gm
npm install
npm test              # vectors, leak, auth, idempotency, restore, scale, fuzz, UI
npm run serve         # GM service on 127.0.0.1:7777 (boots locked)
npm run dev           # vite dev server for the UI, proxying /api
```

Verify any ledger independently:

```sh
python3 verifier/verify.py public/ledger.json
python3 verifier/verify.py --vectors spec/vectors.json
# or open verifier/verify.html in a browser and point it at the ledger
```

## Deployment (NixOS)

```nix
{
  inputs.column.url = "github:dgoeke/prophecy-dice";
  # ...
  imports = [ column.nixosModules.default ];

  services.column.gm = {
    enable = true;
    bindAddress = "127.0.0.1";    # behind `tailscale serve`; never public
    gitMirrorCommand = "git add ledger.json && git commit -m publish && git push";
  };
  services.column.rehearsal.enable = true; # isolated :7778 service, no mirror
  services.column.public = {
    enable = true;                 # Caddy vhost: publicDir read-only, no keys
    domain = "column.example.org";
  };
  services.column.backup = {
    enable = true;
    command = "rsync -a /var/lib/column/state/backups/ backups@offbox:column/";
  };
}
```

Front the loopback-bound GM UI with
`tailscale serve https / http://127.0.0.1:7777` so the
unlock passphrase never crosses the tailnet in cleartext (§6.6). The service
**boots locked** after any reboot: the ledger stays readable, drawing is
impossible until the passphrase is entered (§6.4). `autoUnlock` exists and is
off by default — read its warning before enabling.

## Backups and the tested restore procedure

Losing both `state/` and every usable backup **permanently destroys the
audit**, even if the tabletop campaign continues with physical dice: sealed
fields become unopenable forever (§6.7). The service snapshots the last 20
`(ledger.json, private.enc)` pairs into `state/backups/` after every ledger
write; the backup timer ships them off-box.
`private.enc` is AES-256-GCM under your passphrase — the passphrase lives in
your password manager, not on this machine.

**Restore procedure** (exercised automatically in
`gm/test/server.test.ts › restore from backup` — run it before you need it):

1. Stop the service: `systemctl stop column-gm`.
2. In your backup destination, find the newest pair by prefix:
   `NNNNNNNN-ledger.json` and `NNNNNNNN-private.enc`.
3. Recreate the state directory and put the pair in place, dropping prefixes:
   ```sh
   install -d -m 700 -o column -g column /var/lib/column/state
   cp NNNNNNNN-ledger.json  /var/lib/column/state/ledger.json
   cp NNNNNNNN-private.enc  /var/lib/column/state/private.enc
   chown column:column /var/lib/column/state/*
   ```
4. Start the service and unlock with your passphrase.
5. Confirm: the status bar shows the right session and entry counts, and a
   disclosure of an already-drawn position succeeds. On unlock the service
   re-verifies the entire chain and re-derives every column from the secret,
   refusing to start on any mismatch — a successful unlock **is** the
   integrity check.
6. Before resuming play, compare the restored head with the newest head the
   players witnessed and with the public artifact. If the backup is older,
   recover a newer matching pair; do not silently continue from a rolled-back
   ledger.

Cursors, chains, and registry state are all re-derived from the ledger plus
the secret, so a matching restored pair is internally complete. A remote
backup may lag by its timer interval, however. Entries after that snapshot are
lost with the live state, and continuing from an older head would be visible
to anyone who saved the newer one.

## Operational rules worth repeating

- **Physical dice for anything in initiative order** (§10.1). This tool is for
  secret checks, not combat tempo.
- Rehearse the ceremony first: `COLUMN_REHEARSAL=1 npm run serve` gives a
  throwaway development campaign, while `services.column.rehearsal.enable`
  provides the same isolation as a persistent NixOS service on port 7778.
  Both publish into separate state and public directories and refuse mirrors
  (§7.8).
- Post the publish digest to the group chat every session — it is the external
  timestamp anchor, and human memory is the only count control for routine
  draws (§7.7).
- Treat a mirror failure as an audit warning, not merely an ops warning. A
  successful mirror command is an independent witness only when the remote is
  externally visible and its history is protected from quiet rewrites. A
  local hash chain proves continuity only from a head the players witnessed.
- For each later activation, post the declaration head before its drand round,
  then have a player compare the recorded randomness with the official round.
- If you stop using the tool mid-campaign, run the final reveal and close the
  ledger. A clean close beats a half-verified artifact (§10.4).
