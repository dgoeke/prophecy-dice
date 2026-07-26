/**
 * GM service entry point (§6.2, §6.6).
 *
 * Binds ONLY the address given by COLUMN_BIND (production: the Tailscale
 * interface IP — never 0.0.0.0 on a shared server). Boots LOCKED (§6.4):
 * after an unattended reboot the service is alive, serves already-public
 * data, and refuses to draw until a passphrase arrives over the GM UI.
 *
 * Env:
 *   COLUMN_STATE_DIR   default ./state
 *   COLUMN_PUBLIC_DIR  default ./public
 *   COLUMN_BIND        default 127.0.0.1
 *   COLUMN_PORT        default 7777
 *   COLUMN_DRAND       default https://api.drand.sh
 *   COLUMN_REHEARSAL   "1" → rehearsal mode in <state>/rehearsal (§7.8)
 */

import { resolve, join } from 'node:path';
import { Campaign } from './campaign.ts';
import { createServer } from './http.ts';
import { DrandBeacon } from './beacon.ts';

const rehearsal = process.env.COLUMN_REHEARSAL === '1';
// Configured directories are used exactly as given; silently rewriting them
// once put deployments outside their own writable paths. The rehearsal
// subdirectories exist only for the DEVELOPMENT defaults, where their job is
// to keep `COLUMN_REHEARSAL=1 npm run serve` off both `state/` and
// `public/` — rehearsal publishes, so sharing either would let a throwaway
// run overwrite real development work.
const devDir = (name: string) => (rehearsal ? join(resolve(name), 'rehearsal') : resolve(name));
const stateDir = process.env.COLUMN_STATE_DIR ? resolve(process.env.COLUMN_STATE_DIR) : devDir('state');
const publicDir = process.env.COLUMN_PUBLIC_DIR ? resolve(process.env.COLUMN_PUBLIC_DIR) : devDir('public');
const bind = process.env.COLUMN_BIND ?? '127.0.0.1';
const port = Number(process.env.COLUMN_PORT ?? 7777);

// resolved-path probe: lets a test assert what the entry point actually
// derived from the environment, which is where directory rewriting lived
if (process.env.COLUMN_PRINT_DIRS === '1') {
  console.log(stateDir);
  console.log(publicDir);
  process.exit(0);
}

const campaign = new Campaign({
  stateDir, publicDir, rehearsal,
  beacon: new DrandBeacon(process.env.COLUMN_DRAND ?? 'https://api.drand.sh'),
  mirrorCommand: process.env.COLUMN_MIRROR_CMD || undefined,
  // §4.1's one-hour pre-commit gate protects the REAL ceremony's ordering
  // guarantee. Rehearsal state is throwaway and unpromotable (§7.8), so the
  // wait would only discourage rehearsing.
  minPrecommitAgeMs: rehearsal ? 0 : undefined,
});

process.on('SIGHUP', () => { console.log('[column] SIGHUP: locking'); campaign.lock(); });

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const uiDir = process.env.COLUMN_UI_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../dist');

const server = createServer(campaign, { uiDir });
server.listen(port, bind, () => {
  console.log(`[column] GM service on http://${bind}:${port} — ${campaign.phase}, locked${rehearsal ? ', REHEARSAL' : ''}`);
});
