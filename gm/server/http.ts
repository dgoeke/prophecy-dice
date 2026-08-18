/**
 * HTTP layer: thin JSON routing over Campaign (§6.2 — node:http only).
 * Lock gating, unlock rate-limiting (§6.4), SSE for multi-client state (§6.5).
 */

import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Campaign, CampaignError } from './campaign.ts';

const BODY_LIMIT = 1 << 20;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

interface UnlockLimiter { failures: number[]; }

export function createServer(campaign: Campaign, opts: { idleLockMs?: number; now?: () => number; uiDir?: string } = {}): Server {
  const now = opts.now ?? Date.now;
  const idleLockMs = opts.idleLockMs ?? 12 * 3600 * 1000; // §6.4: auto-relock after 12h idle
  const limiter: UnlockLimiter = { failures: [] };
  const sseClients = new Set<ServerResponse>();
  let lastActivity = now();
  let authToken: string | null = null;
  const cookieName = '__Host-column_session';

  const broadcast = () => {
    const msg = `data: ${JSON.stringify({ ...campaign.status(), clients: sseClients.size })}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  campaign.onChange = broadcast;

  const idleTimer = setInterval(() => {
    if (!campaign.locked && now() - lastActivity > idleLockMs) {
      console.log('[column] idle timeout: locking');
      campaign.lock();
    }
  }, 60_000);
  idleTimer.unref();

  async function readBody(req: IncomingMessage): Promise<any> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += c.length;
      if (size > BODY_LIMIT) throw new CampaignError('body too large', 413);
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CampaignError('invalid JSON body'); }
  }
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const tokenFrom = (req: IncomingMessage): string | null => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
    const cookies = String(req.headers.cookie ?? '').split(';');
    for (const raw of cookies) {
      const [name, ...rest] = raw.trim().split('=');
      if (name === cookieName) return decodeURIComponent(rest.join('='));
    }
    return null;
  };
  const authorized = (req: IncomingMessage): boolean => {
    if (!authToken || campaign.locked) return false;
    const supplied = tokenFrom(req);
    if (!supplied) return false;
    const a = Buffer.from(authToken);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const issueAuth = (res: ServerResponse, body: Record<string, unknown>) => {
    authToken = randomBytes(32).toString('hex');
    return json(res, 200, { ...body, auth_token: authToken }, {
      'set-cookie': `${cookieName}=${authToken}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      'cache-control': 'no-store',
    });
  };
  const clearAuth = (res: ServerResponse, body: unknown) => {
    authToken = null;
    return json(res, 200, body, {
      'set-cookie': `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      'cache-control': 'no-store',
    });
  };

  // Every mutating route requires the unlocked state; drawing while locked is
  // impossible by construction (§6.4). Read-only public data stays available.
  const routes: Record<string, (b: any, res: ServerResponse) => Promise<unknown> | unknown> = {
    'POST /api/setup/precommit': (b) => campaign.precommit(b.passphrase),
    'POST /api/setup/configuration': (b) => campaign.freezeGenesisConfiguration(b),
    'POST /api/setup/genesis-preview': (b) => campaign.genesisPreview(b),
    'POST /api/setup/genesis': (b) => campaign.genesis(b),
    'POST /api/session/open': () => campaign.sessionOpen(),
    'POST /api/session/close': () => campaign.sessionClose(),
    'POST /api/draw': (b) => campaign.draw(b),
    'POST /api/batch': (b) => campaign.batch(b),
    'POST /api/announce': (b) => campaign.announce(b),
    'POST /api/void': (b) => campaign.voidAnnounce(b),
    'POST /api/correction': (b) => campaign.correction(b),
    'POST /api/dc-late': (b) => campaign.dcLate(b),
    'POST /api/out-of-band': (b) => campaign.outOfBand(b),
    'POST /api/sheet-update': (b) => campaign.sheetUpdate(b),
    'POST /api/profile-defaults': (b) => campaign.profileDefaults(b),
    'POST /api/retire-slot': (b) => campaign.retireSlot(b),
    'POST /api/note': (b) => campaign.note(b.text),
    'POST /api/activation/declare': (b) => campaign.activationDeclare(b),
    'POST /api/activation/complete': () => campaign.activationComplete(),
    'POST /api/disclose/preview': (b) => campaign.disclosePreview(b.slot, b.lane, b.through_position),
    'POST /api/disclose': (b) => campaign.disclose(b),
    'POST /api/reveal-all': (b) => campaign.revealAll(b.scope ?? 'all'),
    'POST /api/final-reveal': () => campaign.finalReveal(),
    'POST /api/closed': (b) => campaign.close(b.reason),
    'POST /api/publish': () => campaign.publish(),
    'POST /api/ui-state': (b) => campaign.setUiState(b),
    'GET /api/setup/configuration': () => campaign.genesisConfiguration(),
    'GET /api/table': () => campaign.tableState(),
    'GET /api/stats/disclosed': () => campaign.disclosedStats(),
    'GET /api/reveal/walkthrough': () => campaign.walkthrough(),
  };
  const openRoutes = new Set(['POST /api/setup/precommit']);

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site') {
          return json(res, 403, { error: 'cross-site requests are not allowed' });
        }
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return json(res, 415, { error: 'content-type must be application/json' });
        }
      }
      if (route === 'GET /api/status') {
        const status = campaign.status();
        return json(res, 200, authorized(req)
          ? { ...status, clients: sseClients.size }
          : {
              phase: status.phase, locked: true, rehearsal: status.rehearsal,
              campaign: null, session: 0, session_open: false, entries: 0,
              unpublished: null, pending_activation: null, clients: 0,
              precommit: null, configuration_frozen: false,
            });
      }
      if (route === 'GET /api/ledger') {
        if (authorized(req)) {
          if (campaign.phase !== 'live') return json(res, 404, { error: 'no ledger yet' });
          return json(res, 200, campaign.ledgerJson());
        }
        // Unauthenticated readers get only the explicit publication artifact,
        // never the working ledger (which leaks secret-check timing).
        const published = join(campaign.opts.publicDir, 'ledger.json');
        if (!existsSync(published)) return json(res, 404, { error: 'no published ledger yet' });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(readFileSync(published));
      }
      if (route === 'GET /api/events') {
        if (!authorized(req)) return json(res, 401, { error: 'authentication required' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hi\n\n');
        sseClients.add(res);
        broadcast();
        req.on('close', () => { sseClients.delete(res); broadcast(); });
        return;
      }
      if (route === 'POST /api/unlock') {
        const recent = limiter.failures.filter((t) => now() - t < 15 * 60_000);
        limiter.failures = recent;
        if (recent.length >= 5) {
          console.log('[column] unlock rate-limited');
          return json(res, 429, { error: 'too many unlock attempts; wait' });
        }
        const body = await readBody(req);
        try {
          await campaign.unlock(body.passphrase ?? '');
          lastActivity = now();
          console.log('[column] unlocked');
          return issueAuth(res, campaign.status());
        } catch (e) {
          limiter.failures.push(now());
          console.log('[column] unlock failed');
          throw e;
        }
      }
      if (route === 'POST /api/lock') {
        if (!authorized(req)) return json(res, 401, { error: 'authentication required' });
        campaign.lock();
        return clearAuth(res, campaign.status());
      }
      const handler = routes[route];
      if (!handler) {
        // static GM UI (built by vite into gm/dist); holds no key material
        if (req.method === 'GET' && opts.uiDir && !url.pathname.startsWith('/api/')) {
          const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
          const file = join(opts.uiDir, rel);
          const target = existsSync(file) ? file : join(opts.uiDir, 'index.html');
          if (target.startsWith(opts.uiDir) && existsSync(target)) {
            res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
            return res.end(readFileSync(target));
          }
        }
        return json(res, 404, { error: `no route ${route}` });
      }
      if (!openRoutes.has(route) && !authorized(req)) {
        return json(res, campaign.locked ? 423 : 401,
          { error: campaign.locked ? 'locked' : 'authentication required' });
      }
      lastActivity = now();
      const body = await readBody(req);
      const result = (await handler(body, res)) ?? { ok: true };
      if (route === 'POST /api/setup/precommit') {
        return issueAuth(res, result as Record<string, unknown>);
      }
      return json(res, 200, result);
    } catch (e: any) {
      const status = e instanceof CampaignError ? e.status : 500;
      if (status === 500) console.error('[column]', e);
      return json(res, status, { error: e.message ?? 'internal error' });
    }
  });
  server.on('close', () => clearInterval(idleTimer));
  return server;
}
