import type { Env } from "./types";
import { FOB_LEASE_SEC } from "./types";

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
    `SELECT id, label, scopes, active, created_at, must_change_pin, fob_id
     FROM alarm_pins ORDER BY created_at ASC`,
  ).all<{
    id: string;
    label: string;
    scopes: string;
    active: number;
    created_at: string;
    must_change_pin: number;
    fob_id: string | null;
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

export async function updatePinLabel(env: Env, id: string, label: string) {
  await env.DB.prepare(`UPDATE alarm_pins SET label = ? WHERE id = ?`)
    .bind(label, id)
    .run();
}

export async function setPinMustChange(env: Env, id: string, mustChangePin: boolean) {
  await env.DB.prepare(`UPDATE alarm_pins SET must_change_pin = ? WHERE id = ?`)
    .bind(mustChangePin ? 1 : 0, id)
    .run();
}

export async function setPinFobId(env: Env, id: string, fobId: string | null) {
  await env.DB.prepare(`UPDATE alarm_pins SET fob_id = ? WHERE id = ?`)
    .bind(fobId, id)
    .run();
}

export type FobDeviceRow = {
  id: string;
  name: string;
  active: number;
  created_at: string;
};

export type FobLeaseRow = {
  fob_id: string;
  pin_id: string;
  label: string;
  expires_at: number;
  armed_at: number;
};

const FOB_CODE_MAP: Record<string, string> = {
  red: "evacuate.code_red",
  code_red: "evacuate.code_red",
  blue: "evacuate.code_blue",
  code_blue: "evacuate.code_blue",
  clear: "__all_clear__",
  green: "__all_clear__",
  all_clear: "__all_clear__",
};

/** Hold button 4 / green — link fob from app (no horns). */
const FOB_PAIR_CODES = new Set(["clear", "green", "all_clear", "wake", "pair"]);

export function isFobPairCode(code: string): boolean {
  return FOB_PAIR_CODES.has(normalizeFobCode(code));
}

function normalizeFobCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeFobId(raw: string): string | null {
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id.length >= 2 && id.length <= 40 ? id : null;
}

export function mapFobCodeToAction(code: string): string | null {
  return FOB_CODE_MAP[normalizeFobCode(code)] ?? null;
}

async function purgeExpiredFobLeases(env: Env) {
  await env.DB.prepare(`DELETE FROM fob_leases WHERE expires_at <= ?`)
    .bind(Date.now())
    .run();
}

export async function listFobDevices(env: Env): Promise<FobDeviceRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, active, created_at FROM fob_devices ORDER BY name ASC`,
  ).all<FobDeviceRow>();
  return results ?? [];
}

export async function getFobDevice(env: Env, id: string): Promise<FobDeviceRow | null> {
  return env.DB.prepare(
    `SELECT id, name, active, created_at FROM fob_devices WHERE id = ?`,
  )
    .bind(id)
    .first<FobDeviceRow>();
}

export async function upsertFobDevice(env: Env, id: string, name: string) {
  const slug = normalizeFobId(id);
  if (!slug) throw new Error("Invalid fob id — use letters, numbers, dash (2–40 chars).");
  const label = name.trim().slice(0, 80) || slug;
  await env.DB.prepare(
    `INSERT INTO fob_devices (id, name, active) VALUES (?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  )
    .bind(slug, label)
    .run();
  return slug;
}

export async function setFobDeviceActive(env: Env, id: string, active: boolean) {
  await env.DB.prepare(`UPDATE fob_devices SET active = ? WHERE id = ?`)
    .bind(active ? 1 : 0, id)
    .run();
}

export async function getPinFobId(env: Env, pinId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT fob_id FROM alarm_pins WHERE id = ?`)
    .bind(pinId)
    .first<{ fob_id: string | null }>();
  return row?.fob_id ?? null;
}

export async function getFobLease(env: Env, fobId: string): Promise<FobLeaseRow | null> {
  await purgeExpiredFobLeases(env);
  return env.DB.prepare(
    `SELECT fob_id, pin_id, label, expires_at, armed_at FROM fob_leases WHERE fob_id = ?`,
  )
    .bind(fobId)
    .first<FobLeaseRow>();
}

export async function armFobLease(
  env: Env,
  input: { pinId: string; label: string; fobId?: string | null },
): Promise<
  | { ok: true; fobId: string; fobName: string; expiresAt: number }
  | { ok: false; error: string }
> {
  await purgeExpiredFobLeases(env);
  const fobId = input.fobId?.trim() || (await getPinFobId(env, input.pinId));
  if (!fobId) {
    return { ok: false, error: "No fob linked yet — use Link my fob in the app and hold button 4." };
  }
  const device = await getFobDevice(env, fobId);
  if (!device || !device.active) {
    return { ok: false, error: "That fob is not registered or is inactive." };
  }
  const now = Date.now();
  const expiresAt = now + FOB_LEASE_SEC * 1000;
  await env.DB.prepare(
    `INSERT INTO fob_leases (fob_id, pin_id, label, expires_at, armed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fob_id) DO UPDATE SET
       pin_id = excluded.pin_id,
       label = excluded.label,
       expires_at = excluded.expires_at,
       armed_at = excluded.armed_at`,
  )
    .bind(fobId, input.pinId, input.label, expiresAt, now)
    .run();
  return { ok: true, fobId, fobName: device.name, expiresAt };
}

export async function disarmFobLease(
  env: Env,
  input: { pinId: string; fobId?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fobId = input.fobId?.trim() || (await getPinFobId(env, input.pinId));
  if (!fobId) return { ok: false, error: "No fob assigned." };
  const lease = await getFobLease(env, fobId);
  if (!lease || lease.pin_id !== input.pinId) {
    return { ok: false, error: "You do not have this fob armed." };
  }
  await env.DB.prepare(`DELETE FROM fob_leases WHERE fob_id = ?`).bind(fobId).run();
  return { ok: true };
}

export async function getFobStatusForPin(env: Env, pinId: string) {
  const assignedId = await getPinFobId(env, pinId);
  if (!assignedId) {
    return { assigned: null as null, armed: false, expiresAt: null as number | null, fobName: null as string | null };
  }
  const device = await getFobDevice(env, assignedId);
  const lease = await getFobLease(env, assignedId);
  const armed = Boolean(
    lease && lease.pin_id === pinId && lease.expires_at > Date.now(),
  );
  return {
    assigned: assignedId,
    fobName: device?.name ?? assignedId,
    armed,
    expiresAt: armed ? lease!.expires_at : null,
  };
}

const FOB_PAIR_MS = 3 * 60 * 1000;

async function purgeExpiredFobPairing(env: Env) {
  await env.DB.prepare(`DELETE FROM fob_pairing WHERE expires_at <= ?`)
    .bind(Date.now())
    .run();
}

export async function startFobPairing(
  env: Env,
  pinId: string,
  label: string,
): Promise<{ expiresAt: number }> {
  await purgeExpiredFobPairing(env);
  const now = Date.now();
  const expiresAt = now + FOB_PAIR_MS;
  await env.DB.prepare(`DELETE FROM fob_pairing`).run();
  await env.DB.prepare(
    `INSERT INTO fob_pairing (pin_id, label, expires_at, started_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(pinId, label, expiresAt, now)
    .run();
  return { expiresAt };
}

export async function getFobPairingForPin(env: Env, pinId: string) {
  await purgeExpiredFobPairing(env);
  const row = await env.DB.prepare(
    `SELECT pin_id, label, expires_at, started_at FROM fob_pairing WHERE pin_id = ?`,
  )
    .bind(pinId)
    .first<{ pin_id: string; label: string; expires_at: number; started_at: number }>();
  if (!row || row.expires_at <= Date.now()) return null;
  return row;
}

export async function tryCompleteFobPairing(
  env: Env,
  fobIdRaw: string,
  codeRaw: string,
): Promise<
  | { paired: true; pinId: string; label: string; fobId: string; fobName: string; expiresAt: number }
  | { paired: false }
> {
  if (!isFobPairCode(codeRaw)) return { paired: false };
  const fobId = normalizeFobId(fobIdRaw);
  if (!fobId) return { paired: false };
  const device = await getFobDevice(env, fobId);
  if (!device || !device.active) return { paired: false };

  await purgeExpiredFobPairing(env);
  const session = await env.DB.prepare(
    `SELECT pin_id, label, expires_at FROM fob_pairing ORDER BY started_at DESC LIMIT 1`,
  ).first<{ pin_id: string; label: string; expires_at: number }>();
  if (!session || session.expires_at <= Date.now()) return { paired: false };

  await setPinFobId(env, session.pin_id, fobId);
  const armed = await armFobLease(env, {
    pinId: session.pin_id,
    label: session.label,
    fobId,
  });
  await env.DB.prepare(`DELETE FROM fob_pairing`).run();
  if (!armed.ok) return { paired: false };

  return {
    paired: true,
    pinId: session.pin_id,
    label: session.label,
    fobId,
    fobName: armed.fobName,
    expiresAt: armed.expiresAt,
  };
}

export async function authorizeFobTrigger(
  env: Env,
  fobIdRaw: string,
  codeRaw: string,
): Promise<
  | {
      allowed: true;
      actionId: string;
      label: string;
      pinId: string;
      fobName: string;
    }
  | { allowed: false; error: string }
> {
  const fobId = normalizeFobId(fobIdRaw);
  if (!fobId) return { allowed: false, error: "Invalid fob id" };
  const actionId = mapFobCodeToAction(codeRaw);
  if (!actionId) return { allowed: false, error: "Unknown fob action code" };

  const device = await getFobDevice(env, fobId);
  if (!device || !device.active) {
    return { allowed: false, error: "Unknown or inactive fob" };
  }

  const lease = await getFobLease(env, fobId);
  if (!lease || lease.expires_at <= Date.now()) {
    return {
      allowed: false,
      error: "Fob not armed — press 4 on campus phone or arm in the app (3-hour window).",
    };
  }

  if (actionId === "__all_clear__") {
    const phase = await getEvacPhase(env);
    const gate = evacActionAllowedForPhase(actionId, phase);
    if (!gate.ok) return { allowed: false, error: gate.error };
  } else if (evacPhaseForAction(actionId)) {
    const phase = await getEvacPhase(env);
    const gate = evacActionAllowedForPhase(actionId, phase);
    if (!gate.ok) return { allowed: false, error: gate.error };
  }

  return {
    allowed: true,
    actionId,
    label: `${lease.label} · ${device.name}`,
    pinId: lease.pin_id,
    fobName: device.name,
  };
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

export type VolumeSettings = {
  bells: number;
  evac: number;
  /** Per-speaker class-bell volume overrides (Protect speaker id → 20–100). */
  bellsBySpeaker: Record<string, number>;
};

function clampVol(n: number, min: number, max: number, fallback: number) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function parseBellsBySpeaker(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, val] of Object.entries(parsed || {})) {
      if (!id) continue;
      out[id] = clampVol(Number(val), 20, 100, 60);
    }
    return out;
  } catch {
    return {};
  }
}

export async function getVolumeSettings(env: Env): Promise<VolumeSettings> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM system_settings WHERE key IN ('bell_volume', 'evac_volume', 'bell_volumes_by_speaker')`,
  ).all<{ key: string; value: string }>();
  let bells = 60;
  let evac = 100;
  let bellsBySpeaker: Record<string, number> = {};
  for (const row of results ?? []) {
    if (row.key === "bell_volume") bells = clampVol(Number(row.value), 20, 100, 60);
    if (row.key === "evac_volume") evac = clampVol(Number(row.value), 50, 100, 100);
    if (row.key === "bell_volumes_by_speaker") {
      bellsBySpeaker = parseBellsBySpeaker(row.value);
    }
  }
  return { bells, evac, bellsBySpeaker };
}

export async function setVolumeSettings(
  env: Env,
  next: Partial<VolumeSettings> & {
    bellsBySpeaker?: Record<string, number>;
  },
): Promise<VolumeSettings> {
  const cur = await getVolumeSettings(env);
  const bells =
    typeof next.bells === "number"
      ? clampVol(next.bells, 20, 100, cur.bells)
      : cur.bells;
  const evac =
    typeof next.evac === "number"
      ? clampVol(next.evac, 50, 100, cur.evac)
      : cur.evac;
  let bellsBySpeaker = cur.bellsBySpeaker;
  if (next.bellsBySpeaker && typeof next.bellsBySpeaker === "object") {
    bellsBySpeaker = {};
    for (const [id, val] of Object.entries(next.bellsBySpeaker)) {
      if (!id) continue;
      bellsBySpeaker[id] = clampVol(Number(val), 20, 100, bells);
    }
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO system_settings (key, value) VALUES ('bell_volume', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(bells)),
    env.DB.prepare(
      `INSERT INTO system_settings (key, value) VALUES ('evac_volume', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(evac)),
    env.DB.prepare(
      `INSERT INTO system_settings (key, value) VALUES ('bell_volumes_by_speaker', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(JSON.stringify(bellsBySpeaker)),
  ]);
  return { bells, evac, bellsBySpeaker };
}

export type SpeakerStatusRow = {
  id: string;
  name: string;
  state: string;
  volume: number;
  speakerStatus?: string;
  speakerMode?: string;
  mac?: string;
};

export async function setSpeakersSnapshot(
  env: Env,
  speakers: SpeakerStatusRow[],
  at = Date.now(),
) {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('speakers_status', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify({ at, speakers }))
    .run();
}

export async function getSpeakersSnapshot(env: Env): Promise<{
  at: number | null;
  speakers: SpeakerStatusRow[];
}> {
  const row = await env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = 'speakers_status'`,
  ).first<{ value: string }>();
  if (!row?.value) return { at: null, speakers: [] };
  try {
    const parsed = JSON.parse(row.value) as {
      at?: number;
      speakers?: SpeakerStatusRow[];
    };
    return {
      at: typeof parsed.at === "number" ? parsed.at : null,
      speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
    };
  } catch {
    return { at: null, speakers: [] };
  }
}

export type TestNotifyExtReportRow = {
  ext: string;
  label: string;
  status: string;
  error?: string;
  digit?: string | null;
  ringStartedAt: number;
  answeredAt?: number;
  finishedAt?: number;
};

export type TestNotifyReportRow = {
  id: string;
  state: "ringing" | "complete";
  startedAt: number;
  finishedAt?: number;
  requestedBy?: string;
  playId?: string;
  notifyOnly: boolean;
  delayMinutes: number;
  delayed: boolean;
  delayedBy: string[];
  hornsAt?: number | null;
  configError?: string;
  promptReady?: boolean;
  extensions: TestNotifyExtReportRow[];
};

export async function setTestNotifyReport(env: Env, report: TestNotifyReportRow) {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('test_notify_report', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(report))
    .run();
}

export async function getTestNotifyReport(env: Env): Promise<TestNotifyReportRow | null> {
  const row = await env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = 'test_notify_report'`,
  ).first<{ value: string }>();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as TestNotifyReportRow;
  } catch {
    return null;
  }
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
