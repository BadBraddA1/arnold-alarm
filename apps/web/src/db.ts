import type { Env } from "./types";

export type PinRow = {
  id: string;
  label: string;
  pin_hash: string;
  scopes: string;
  active: number;
  created_at: string;
};

export async function listActivePins(env: Env): Promise<PinRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, label, pin_hash, scopes, active, created_at
     FROM alarm_pins WHERE active = 1 ORDER BY created_at ASC`,
  ).all<PinRow>();
  return results ?? [];
}

export async function listAllPins(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, label, scopes, active, created_at FROM alarm_pins ORDER BY created_at ASC`,
  ).all<{
    id: string;
    label: string;
    scopes: string;
    active: number;
    created_at: string;
  }>();
  return results ?? [];
}

export async function insertPin(
  env: Env,
  input: { id: string; label: string; pinHash: string; scopes: string[] },
) {
  await env.DB.prepare(
    `INSERT INTO alarm_pins (id, label, pin_hash, scopes, active)
     VALUES (?, ?, ?, ?, 1)`,
  )
    .bind(input.id, input.label, input.pinHash, JSON.stringify(input.scopes))
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
};

export async function enqueuePlay(
  env: Env,
  input: {
    id: string;
    actionId: string;
    pinId: string;
    label: string;
    delayMinutes: number;
  },
) {
  await env.DB.prepare(
    `INSERT INTO play_queue (id, action_id, pin_id, label, delay_minutes, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  )
    .bind(
      input.id,
      input.actionId,
      input.pinId,
      input.label,
      input.delayMinutes,
    )
    .run();
}

export async function claimPendingJobs(env: Env, limit = 5): Promise<QueueJob[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, action_id, pin_id, label, delay_minutes, status, created_at
     FROM play_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<QueueJob>();

  const jobs = results ?? [];
  for (const job of jobs) {
    await env.DB.prepare(
      `UPDATE play_queue SET status = 'claimed', claimed_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    )
      .bind(job.id)
      .run();
  }
  return jobs;
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
