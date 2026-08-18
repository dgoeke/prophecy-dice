/** Fetch wrapper. __API_BASE is set by tests to point at a real server. */

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const base = () => (globalThis as any).__API_BASE ?? '';
let authToken: string | null = null;

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(base() + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as any).error ?? `HTTP ${res.status}`, res.status);
  if (typeof (data as any).auth_token === 'string') {
    authToken = (data as any).auth_token;
    // Authentication is deliberately memory-only. In particular, setup stores
    // the public commitment response in localStorage so it survives a reload.
    delete (data as any).auth_token;
  }
  if (path === '/api/lock') authToken = null;
  return data as T;
}

export const uuid = () => crypto.randomUUID();

export interface Status {
  phase: 'empty' | 'precommitted' | 'live';
  locked: boolean;
  rehearsal: boolean;
  campaign: string | null;
  session: number;
  session_open: boolean;
  close_pending: boolean;
  close_pending_session: number | null;
  entries: number;
  unpublished: number | null;
  precommit?: { commitment: string; precommit_at: string } | null;
  configuration_frozen?: boolean;
  pending_activation: {
    slot: string; round: number; round_time: number;
    declaration_seq: number; declaration_head: string;
    player_label_salt: string | null;
  } | null;
  clients?: number;
}

export interface CheckType {
  id: string; label: string; lane: string; roles: string[];
  seal_dc: boolean; seal_modifier: boolean; ritual: boolean;
}

export interface SlotInfo {
  id: string; active: boolean; retired: boolean;
  role: string | null; display: string | null; lanes: string[];
}

export interface TableState {
  session: number;
  lanes: Record<string, { drawn: number; remaining: number; watermark: number }>;
  sheets: Record<string, Record<string, number>>;
  latest_sheets: Record<string, {
    seq: number; slot: string; effective_from: string; modifiers: Record<string, number>;
  }>;
  scheduled_sheets: Record<string, {
    seq: number; slot: string; effective_from: string; modifiers: Record<string, number>;
  }[]>;
  npc_sheets: Record<string, Record<string, number>>;
  profile_defaults: Record<string, Record<string, string>>;
  open_announce: null | {
    seq: number; slot: string; lane: string; checkType: string;
    context: string | null; initiator: string;
  };
  registry: CheckType[];
  slots: SlotInfo[];
  next_deferred: string | null;
  ui_state: { bench?: string[] } | null;
}

/**
 * Every lane a role's check types can route to, in registry order.
 *
 * Lane sets are permanent from activation — there is no lane-add — so an
 * activation that omits a routable lane creates a slot that can never make
 * that kind of check, unrepairably. Deriving the default from the campaign's
 * own frozen registry keeps that impossible for any registry, where a
 * hardcoded table only ever matched the suggested one.
 */
export function defaultLanesForRole(registry: CheckType[], role: string): string[] {
  return [...new Set(registry.filter((t) => t.roles.includes(role)).map((t) => t.lane))];
}

// red is reserved for ceremony (rubrication) — no lane may wear it
export const LANE_COLORS: Record<string, string> = {
  sealed: 'var(--seal)', open: 'var(--verdigris)', routine: 'var(--amber)', deep: 'var(--plum)',
};
export const laneColor = (lane: string) => LANE_COLORS[lane] ?? 'var(--ink-faint)';

export const DEGREES = ['critical failure', 'failure', 'success', 'critical success'];
