import type { Env } from "./types";

export type PinRow = {
  id: string;
  label: string;
  pin_hash: string;
  scopes: string;
  active: number;
  created_at: string;
  must_change_pin: number;
};

export async function listActivePins(env: Env): Promise<PinRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, label, pin_hash, scopes, active, created_at, must_change_pin
     FROM alarm_pins WHERE active = 1 ORDER BY created_at ASC`,
  ).all<PinRow>();
  return results ?? [];
}

export async function listAllPins(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, label, scopes, active, created_at, must_change_pin
     FROM alarm_pins ORDER BY created_at ASC`,
  ).all<{
    id: string;
    label: string;
    scopes: string;
    active: number;
    created_at: string;
    must_change_pin: number;
  }>();
  return results ?? [];
}

export async function getPinById(env: Env, id: string) {
  return env.DB.prepare(
    `SELECT id, label, pin_hash, scopes, active, created_at, must_change_pin
     FROM alarm_pins WHERE id = ?`,
  )
    .bind(id)
    .first<PinRow>();
}

export async function insertPin(
  env: Env,
  input: {
    id: string;
    label: string;
    pinHash: string;
    scopes: string[];
    mustChangePin?: boolean;
  },
) {
  await env.DB.prepare(
    `INSERT INTO alarm_pins (id, label, pin_hash, scopes, active, must_change_pin)
     VALUES (?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      input.id,
      input.label,
      input.pinHash,
      JSON.stringify(input.scopes),
      input.mustChangePin ? 1 : 0,
    )
    .run();
}

export async function setPinHash(
  env: Env,
  id: string,
  pinHash: string,
  mustChangePin: boolean,
) {
  await env.DB.prepare(
    `UPDATE alarm_pins SET pin_hash = ?, must_change_pin = ? WHERE id = ?`,
  )
    .bind(pinHash, mustChangePin ? 1 : 0, id)
    .run();
}

export async function setPinActive(env: Env, id: string, active: boolean) {
  await env.DB.prepare(`UPDATE alarm_pins SET active = ? WHERE id = ?`)
    .bind(active ? 1 : 0, id)
    .run();
}

export async function checkRateLimit(
  env: Env,
  ip: string,
  maxAttempts = 10,
  windowSec = 15 * 60,
) {
  const row = await env.DB.prepare(
    `SELECT attempts, window_start FROM pin_rate_limits WHERE ip = ?`,
  )
    .bind(ip)
    .first<{ attempts: number; window_start: string }>();

  const now = Date.now();
  if (!row) {
    await env.DB.prepare(
      `INSERT INTO pin_rate_limits (ip, attempts, window_start) VALUES (?, 1, datetime('now'))`,
    )
      .bind(ip)
      .run();
    return { allowed: true };
  }

  const start = Date.parse(row.window_start + "Z");
  if (Number.isFinite(start) && now - start > windowSec * 1000) {
    await env.DB.prepare(
      `UPDATE pin_rate_limits SET attempts = 1, window_start = datetime('now') WHERE ip = ?`,
    )
      .bind(ip)
      .run();
    return { allowed: true };
  }

  if (row.attempts >= maxAttempts) return { allowed: false };

  await env.DB.prepare(
    `UPDATE pin_rate_limits SET attempts = attempts + 1 WHERE ip = ?`,
  )
    .bind(ip)
    .run();
  return { allowed: true };
}

export async function clearRateLimit(env: Env, ip: string) {
  await env.DB.prepare(`DELETE FROM pin_rate_limits WHERE ip = ?`).bind(ip).run();
}

export type QueueJob = {
  id: string;
  action_id: string;
  pin_id: string;
  label: string;
  delay_minutes: number;
  status: string;
  created_at: string;
  loop_play?: number;
  command?: string;
  fire_at?: string | null;
};

export async function enqueuePlay(
  env: Env,
  input: {
    id: string;
    actionId: string;
    pinId: string;
    label: string;
    delayMinutes: number;
    loop?: boolean;
    command?: "play" | "stop" | "all_clear";
    fireAt?: string | null;
  },
) {
  const delay = Math.max(0, input.delayMinutes);
  const fireAt =
    input.fireAt ??
    (delay > 0 ? new Date(Date.now() + delay * 60_000).toISOString() : null);
  const status = delay > 0 && input.command !== "stop" && input.command !== "all_clear"
    ? "scheduled"
    : "pending";

  await env.DB.prepare(
    `INSERT INTO play_queue (id, action_id, pin_id, label, delay_minutes, status, loop_play, command, fire_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.actionId,
      input.pinId,
      input.label,
      delay,
      status,
      input.loop ? 1 : 0,
      input.command ?? "play",
      fireAt,
    )
    .run();
}

/** Due plays: immediate pending, or scheduled whose fire_at is due. */
export async function claimPendingJobs(env: Env, limit = 5): Promise<QueueJob[]> {
  const nowIso = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, action_id, pin_id, label, delay_minutes, status, created_at, loop_play, command, fire_at
     FROM play_queue
     WHERE status = 'pending'
        OR (status = 'scheduled' AND fire_at IS NOT NULL AND fire_at <= ?)
     ORDER BY COALESCE(fire_at, created_at) ASC
     LIMIT ?`,
  )
    .bind(nowIso, limit)
    .all<QueueJob>();

  const jobs = results ?? [];
  for (const job of jobs) {
    await env.DB.prepare(
      `UPDATE play_queue SET status = 'claimed', claimed_at = datetime('now') WHERE id = ? AND status IN ('pending', 'scheduled')`,
    )
      .bind(job.id)
      .run();
  }
  return jobs;
}

export async function listScheduledPlays(env: Env): Promise<QueueJob[]> {
  const nowIso = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, action_id, pin_id, label, delay_minutes, status, created_at, loop_play, command, fire_at
     FROM play_queue
     WHERE status = 'scheduled'
       AND (fire_at IS NULL OR fire_at > ?)
     ORDER BY COALESCE(fire_at, created_at) ASC
     LIMIT 40`,
  )
    .bind(nowIso)
    .all<QueueJob>();
  return results ?? [];
}

export async function cancelScheduledPlay(
  env: Env,
  id: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE play_queue
     SET status = 'cancelled', finished_at = datetime('now')
     WHERE id = ? AND status = 'scheduled'`,
  )
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function finishJob(
  env: Env,
  id: string,
  ok: boolean,
  error?: string,
) {
  await env.DB.prepare(
    `UPDATE play_queue
     SET status = ?, error = ?, finished_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(ok ? "done" : "error", error ?? null, id)
    .run();
}

export async function updatePinScopes(env: Env, id: string, scopes: string[]) {
  await env.DB.prepare(`UPDATE alarm_pins SET scopes = ? WHERE id = ?`)
    .bind(JSON.stringify(scopes), id)
    .run();
}

export async function insertAudit(
  env: Env,
  input: {
    id: string;
    actionId: string;
    label: string;
    pinId: string;
    mode: string;
    status: string;
    detail?: string;
  },
) {
  await env.DB.prepare(
    `INSERT INTO play_audit (id, action_id, label, pin_id, mode, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.actionId,
      input.label,
      input.pinId,
      input.mode,
      input.status,
      input.detail ?? null,
    )
    .run();
}

export async function updateAuditStatus(
  env: Env,
  id: string,
  status: string,
  detail?: string,
) {
  await env.DB.prepare(
    `UPDATE play_audit SET status = ?, detail = COALESCE(?, detail) WHERE id = ?`,
  )
    .bind(status, detail ?? null, id)
    .run();
}

export async function listAudit(env: Env, limit = 50) {
  const { results } = await env.DB.prepare(
    `SELECT id, action_id, label, pin_id, mode, status, detail, created_at
     FROM play_audit
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      action_id: string;
      label: string;
      pin_id: string;
      mode: string;
      status: string;
      detail: string | null;
      created_at: string;
    }>();
  return results ?? [];
}

export async function touchGatewayHeartbeat(env: Env, detail?: string) {
  await env.DB.prepare(
    `INSERT INTO gateway_heartbeat (id, last_seen, detail)
     VALUES ('primary', datetime('now'), ?)
     ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now'), detail = excluded.detail`,
  )
    .bind(detail ?? null)
    .run();
}

export async function getGatewayHeartbeat(env: Env) {
  return env.DB.prepare(
    `SELECT last_seen, detail FROM gateway_heartbeat WHERE id = 'primary'`,
  ).first<{ last_seen: string; detail: string | null }>();
}

export async function getSystemArmed(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = 'armed'`,
  ).first<{ value: string }>();
  if (!row) return true; // default armed if migration not applied yet
  return row.value === "1" || row.value === "true";
}

export async function setSystemArmed(env: Env, armed: boolean) {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('armed', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(armed ? "1" : "0")
    .run();
}

export type EvacPhase = "idle" | "red" | "blue";

export async function getEvacPhase(env: Env): Promise<EvacPhase> {
  const row = await env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = 'evac_phase'`,
  ).first<{ value: string }>();
  const v = (row?.value || "idle").toLowerCase();
  if (v === "red" || v === "blue") return v;
  return "idle";
}

export async function setEvacPhase(env: Env, phase: EvacPhase) {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('evac_phase', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(phase)
    .run();
}

/** Map evacuate action ids to phase transitions / gates. */
export function evacPhaseForAction(actionId: string): EvacPhase | null {
  if (actionId === "evacuate.code_red" || actionId === "evacuate.main") return "red";
  if (actionId === "evacuate.code_blue") return "blue";
  return null;
}

export function evacActionAllowedForPhase(
  actionId: string,
  phase: EvacPhase,
): { ok: true } | { ok: false; error: string } {
  const isAllClear =
    actionId === "__all_clear__" || actionId === "evacuate.code_green";
  const next = evacPhaseForAction(actionId);
  if (isAllClear) {
    if (phase === "idle") {
      return {
        ok: false,
        error:
          "All clear is only available after Code Red or Code Blue has been issued.",
      };
    }
    return { ok: true };
  }
  if (next) {
    if (phase !== "idle") {
      return {
        ok: false,
        error:
          "A code is already active. Issue Stop & All clear before starting another.",
      };
    }
    return { ok: true };
  }
  return { ok: true };
}
