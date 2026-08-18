# Rehearsal UX smoke test

This is a human-operated smoke test for the reconciliation features. It is
written for the isolated rehearsal service at
<https://dice-rehearsal.condor.ts.dgoeke.io/>. Do not run it against a real
campaign: the close, disclosure, correction, and final-reveal actions are
durable.

Record `PASS`, `FAIL`, or `SKIP` beside each numbered check. For a failure,
capture the visible message, the current ledger head, and (when relevant) the
entry sequence number.

Sections 1–6 are the core pass (roughly 20–30 minutes). Section 7 needs shell
access to the rehearsal host, section 9 adds a drand wait of at least ten
minutes, and section 10 permanently ends the throwaway campaign.

## Test data

Use these values consistently so that the resulting ledger is easy to read:

| Item | Value |
|---|---|
| Campaign | `Reconciliation UX smoke` |
| Players | `Ada`, `Bert` |
| Active lanes | `sealed,open` for both players; keep World enabled |
| Chain length / reserve | `64` / `6` |
| Context privacy | `sealed` |
| Ada profiles | `Society +8`, `Occultism +6` |
| Bert profile | `Society +5` |
| Ordinary type | `Recall Knowledge` (`rk-general`) |
| Ritual type | `Major cosmology inquiry` (`cosmology-major`) |

Use the suggested registry without editing it. Generate random nonces with the
UI and save the campaign passphrase somewhere temporary; a page reload during
this test is intentional.

## 1. Confirm isolation and create the campaign

1. Open the rehearsal URL and confirm that the red **REHEARSAL** banner is
   visible. Stop immediately if it is absent or the hostname is different.
2. Complete the setup ceremony with the test data above. Generate the GM
   precommit, freeze the configuration, generate player and World nonces,
   review the transcript, and write genesis.
3. Reload the page and unlock it with the passphrase.
4. Open **Ledger**. Confirm genesis exists and note the displayed ledger head.
5. Open **Table**. Confirm Ada, Bert, and World are present, lane positions are
   zero, and **Open session** is available.

Expected: setup survives reload, every configured lane begins at position
zero, and rehearsal data contains no production campaign names or entries.

## 2. Exercise profiles, normalization, and scheduled sheets

1. Open **Sheets**. For Ada, add `Society +8` and `Occultism +6`. For Bert,
   add `Society +5`.
2. Set both players' `rk-general` default to `Society`, and Ada's
   `cosmology-major` default to `Occultism`. Save each player's card with
   today's effective date.
3. Add these two visually identical Ada profiles by copying the values exactly:
   `Café` and `Café`. Attempt to save.
4. Confirm the save is rejected as a duplicate profile name. Remove both test
   rows. No partial sheet update should appear in **Ledger**.
5. Change Ada's `Society` value to `+18`, set the effective date to tomorrow,
   and save. Confirm a scheduled-sheet notice names tomorrow, while the editor
   returns to today's applicable value (`+8`).
6. Change Ada's `Occultism` value to `+7`, use today's date, and save. Confirm
   tomorrow's scheduled-sheet notice remains visible.
7. Test backdated default validation: rename Ada's `Society` row to `OldOnly`,
   select it as the `rk-general` default, set the effective date to yesterday,
   and save.
8. Confirm the backdated save is rejected because `OldOnly` is not in the
   actually applicable sheet. Restore `Society +8` and its default. Confirm no
   partial update was appended.

Expected: profile names are NFC-normalized and case-sensitive, a backdated
candidate cannot install a dangling current default, and a future transition
does not disappear after a later current-dated save.

## 3. Exercise ordinary and ritual draws

1. Return to **Table** and open session 1. Select Ada and click **Recall
   Knowledge**. Set DC 15 and confirm the UI selects `Society +8`; draw it.
2. Arm Ada again, select **Recall Knowledge**, change the profile explicitly to
   `Occultism +7`, and draw. Confirm the session log records modifier `+7`
   rather than silently returning to Ada's `Society +8` default.
3. Press `P` (or try the publish control) while the session remains open.
   Confirm publication is refused and no `disclose` entry appears in
   **Ledger**.
4. Arm Ada and select **Major cosmology inquiry**. Enter a short sealed context,
   then announce it.
5. In the **ANNOUNCED** view set DC 22, switch to manual modifier entry, type
   `-4`, and—without pressing Enter—click **Reveal**.
6. Confirm the resulting draw shows DC 22 and modifier `-4`. The large numeral
   is the computed check total; the smaller line retains the raw d20 arithmetic
   (for example, `19 -4 = 15`). It must not use `Occultism` or another default
   value.

Expected: standalone publication cannot expose a live session or ritual, and
clicking Reveal reads the current controlled manual field.

## 4. Exercise Void restoration and position reuse

1. Start another Ada **Major cosmology inquiry** and announce it. In
   **ANNOUNCED**, enter DC 23 and manual modifier `-5`.
2. Open **Void**, then use **Back** or Escape. Confirm the ANNOUNCED context,
   DC 23, manual mode, and `-5` are all restored.
3. Enter **Void** again, give reason `UX smoke: no check occurred`, and write
   the void. Note the reserved sealed-lane position in the log.
4. Immediately make an Ada **Recall Knowledge** draw. Confirm it uses that same
   lane position: a voided announcement did not consume the draw cursor.
5. Start and announce one more ritual, then reload the browser. Unlock if
   prompted.
6. Confirm the UI recovers into **ANNOUNCED**, not an ordinary blank table.
   Because uncommitted DC/modifier edits are browser-local, deliberately choose
   them again, then resolve this announcement with **Reveal**.

Expected: backing out of Void is lossless, a void reservation can be reused,
and a durable open announcement is recoverable after reload.

## 5. Exercise explicit correction attribution

1. Make an ordinary Ada draw so it is the most recent draw, then press `U` or
   click **Correct sheet**.
2. Select Bert as the intended slot. Choose the correction/redraw option and
   explicitly select Bert's `Society +5` profile (or explicitly enter manual
   `+5`). Confirm the correction.
3. Confirm the replacement draw is on Bert's lane and carries the explicit
   `+5` attribution. The dialog must not silently use the destination slot's
   default without showing and confirming it.
4. Make and reveal another ritual draw, then open **Correct sheet** while it is
   the most recent draw. Confirm one-step redraw is unavailable and the UI
   instructs you to make a fresh announcement. Cancel the dialog.

Expected: corrections are target-scoped and explicit; ritual corrections
cannot bypass the announcement ceremony.

## 6. Close, publish, and replay the receipt

1. Make one ordinary draw with its DC left blank. Click **Close & publish** (or
   press `C`). Confirm the late-DC review lists that draw.
2. Enter its DC and close session 1. Save the displayed session number, draw
   count, void count, digest, and head.
3. Between sessions, invoke **Publish** again with no new ledger work.
4. Confirm the response replays the same session receipt and head. It must not
   replace the original count with `0 draws`.
5. Open session 2. Confirm this is allowed only after session 1 has published.

Expected: close publication is tied to the requested session and idempotent
replay preserves the original human-facing digest counts.

## 7. Operator-assisted close recovery drill

This section deliberately breaks only the rehearsal export directory. Keep the
terminal open so permissions are restored even if the browser behaves
unexpectedly.

1. In session 2, make one ordinary draw. Before closing, run on the rehearsal
   host:

   ```sh
   sudo chmod 0500 /var/lib/column-rehearsal/public
   ```

2. In the UI, close and publish session 2. Confirm export fails but the UI moves
   to publication recovery: **Open session** is hidden and no editable late-DC
   controls are shown.
3. Press `O`; confirm it explains/routes to recovery rather than opening
   session 3. Press `P`; confirm it also routes to the pending close recovery.
4. Restore the directory immediately:

   ```sh
   sudo chmod 0755 /var/lib/column-rehearsal/public
   ```

5. Click **Retry publication**. Confirm it publishes session 2 with its
   original counts/digest, without adding another session-close or rerunning
   late-DC entry.
6. Reload the page and confirm **Open session** is available again.

Expected: a failed export creates durable `CLOSED_PENDING(2)`, blocks all new
ledger mutations, and recovery replays the frozen receipt.

## 8. Exercise the disclosure boundary

1. Open the next session (session 3 if you ran section 7; otherwise session 2).
   Announce a ritual, then void it without making another draw. Record the
   reservation position and close/publish the session.
2. Open **Disclose**. For that sealed lane, attempt to preview disclosure through
   the trailing void's position (one greater than the lane's consumed/drawn
   cursor).
3. Confirm ordinary disclosure rejects it as beyond the highest consumed
   position. The trailing reservation must remain unopened for possible reuse.
4. For a lane with consumed draws, preview through exactly its drawn position.
   Review the entries, commit, then publish between sessions.
5. Open the public verifier at
   <https://dice-rehearsal-ledger.condor.ts.dgoeke.io/verify.html?ledger=/ledger.json>.
   It should load the exported ledger and report `VERIFIED`.

Expected: normal publication/disclosure advances only through consumed draws;
it cannot burn a reusable reservation or create a post-watermark carrier.

## 9. Optional extended activation check

This takes at least one live drand delay.

1. Open **Slots** and declare the lowest deferred slot as a new player with both
   `sealed,open` lanes. Generate its private values in the UI.
2. The declaration is published immediately. Open
   <https://dice-rehearsal-ledger.condor.ts.dgoeke.io/ledger.json> and inspect
   the last `activation-declare`. It should expose `role_class: player`, but
   not the player's display name or the contents sealed by `label_commit`.
3. After the beacon becomes eligible, complete activation. Open **Sheets** and
   confirm the player immediately has `Default +0`, defaults, and both requested
   lanes.
4. If time permits, repeat with an NPC. Its declaration should have
   `role_class: non-player`; exact NPC-versus-World identity stays sealed until
   final reveal, and no public player sheet is emitted for it.

Expected: later players preserve all configured lanes and can be checked
publicly as players without revealing sealed identity details.

## 10. Optional final-reveal check

Final reveal permanently ends this rehearsal campaign.

1. Ensure no session, close recovery, or announcement is open. Open **Reveal**,
   enter the exact confirmation phrase shown by the UI, and begin final reveal.
2. Walk through the opened results. Confirm the trailing void from section 8 is
   now opened, since only final reveal may disclose through the highest
   concerned position.
3. Confirm corrected draws show the original as corrected and the attributed
   replacement, player checks use the public player-sheet semantics, and
   private/non-player checks do not produce false missing-profile warnings.
4. Write the final closed marker, publish once more, and reload the public
   verifier. Confirm `VERIFIED` and retain the final head/digest in the test
   record.

## Optional browser failure drills

- **Announcement refresh:** Before clicking Announce, use the browser's Network
  request-blocking panel to block only `*/api/table*`. The announcement POST
  should succeed and the UI should remain ANNOUNCED even though its refresh
  fails. Remove the block before Reveal/Void.
- **Ambiguous Void:** With an ANNOUNCED ritual and the draft values recorded,
  block `*/api/table*`, write a void, then remove the block and retry/reconcile.
  The UI must either restore the complete draft or discover that the void is
  already durable; it must not leave a public announcement unresolved.

Do not use Offline mode for these drills: it prevents the mutation request
itself and does not simulate “write succeeded, follow-up refresh failed.”
