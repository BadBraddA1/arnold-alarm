import { neon } from "@neondatabase/serverless";

export type PinRow = {
  id: string;
  label: string;
  pin_hash: string;
  scopes: string[];
  active: boolean;
  created_at: string;
};

function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export async function ensureSchema() {
  const db = sql();
  await db`
    CREATE TABLE IF NOT EXISTS alarm_pins (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await db`
    CREATE TABLE IF NOT EXISTS pin_rate_limits (
      ip TEXT PRIMARY KEY,
      attempts INT NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

export async function listActivePins(): Promise<PinRow[]> {
  const db = sql();
  const rows = await db`
    SELECT id, label, pin_hash, scopes, active, created_at::text
    FROM alarm_pins
    WHERE active = TRUE
    ORDER BY created_at ASC
  `;
  return rows as PinRow[];
}

export async function listAllPins(): Promise<Omit<PinRow, "pin_hash">[]> {
  const db = sql();
  const rows = await db`
    SELECT id, label, scopes, active, created_at::text
    FROM alarm_pins
    ORDER BY created_at ASC
  `;
  return rows as Omit<PinRow, "pin_hash">[];
}

export async function insertPin(input: {
  id: string;
  label: string;
  pinHash: string;
  scopes: string[];
}) {
  const db = sql();
  await db`
    INSERT INTO alarm_pins (id, label, pin_hash, scopes, active)
    VALUES (${input.id}, ${input.label}, ${input.pinHash}, ${input.scopes}, TRUE)
  `;
}

export async function setPinActive(id: string, active: boolean) {
  const db = sql();
  await db`
    UPDATE alarm_pins SET active = ${active} WHERE id = ${id}
  `;
}

export async function checkRateLimit(ip: string, maxAttempts = 10, windowMs = 15 * 60 * 1000) {
  const db = sql();
  const rows = await db`
    SELECT attempts, window_start::text FROM pin_rate_limits WHERE ip = ${ip}
  `;
  const now = Date.now();
  if (rows.length === 0) {
    await db`INSERT INTO pin_rate_limits (ip, attempts, window_start) VALUES (${ip}, 1, NOW())`;
    return { allowed: true, remaining: maxAttempts - 1 };
  }
  const row = rows[0] as { attempts: number; window_start: string };
  const start = new Date(row.window_start).getTime();
  if (now - start > windowMs) {
    await db`UPDATE pin_rate_limits SET attempts = 1, window_start = NOW() WHERE ip = ${ip}`;
    return { allowed: true, remaining: maxAttempts - 1 };
  }
  if (row.attempts >= maxAttempts) {
    return { allowed: false, remaining: 0 };
  }
  await db`UPDATE pin_rate_limits SET attempts = attempts + 1 WHERE ip = ${ip}`;
  return { allowed: true, remaining: maxAttempts - row.attempts - 1 };
}

export async function clearRateLimit(ip: string) {
  const db = sql();
  await db`DELETE FROM pin_rate_limits WHERE ip = ${ip}`;
}
