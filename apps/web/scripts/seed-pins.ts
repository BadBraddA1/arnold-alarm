/**
 * Seed PINs into Neon.
 *
 * Usage:
 *   DATABASE_URL=... pnpm seed:pins
 *
 * Optional env:
 *   SEED_ADMIN_PIN=123456
 *   SEED_BELLS_PIN=234567
 *   SEED_EVAC_PIN=345678
 *   SEED_BOTH_PIN=456789
 */
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { neon } from "@neondatabase/serverless";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const sql = neon(url);
  await sql`
    CREATE TABLE IF NOT EXISTS alarm_pins (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const seeds: Array<{ label: string; pin: string; scopes: string[] }> = [];
  if (process.env.SEED_ADMIN_PIN) {
    seeds.push({
      label: "Bootstrap admin",
      pin: process.env.SEED_ADMIN_PIN,
      scopes: ["bells", "evacuate", "admin"],
    });
  }
  if (process.env.SEED_BELLS_PIN) {
    seeds.push({
      label: "Class bells",
      pin: process.env.SEED_BELLS_PIN,
      scopes: ["bells"],
    });
  }
  if (process.env.SEED_EVAC_PIN) {
    seeds.push({
      label: "Evacuation only",
      pin: process.env.SEED_EVAC_PIN,
      scopes: ["evacuate"],
    });
  }
  if (process.env.SEED_BOTH_PIN) {
    seeds.push({
      label: "Bells + evacuate",
      pin: process.env.SEED_BOTH_PIN,
      scopes: ["bells", "evacuate"],
    });
  }

  if (seeds.length === 0) {
    console.log(
      "No SEED_*_PIN vars set. Example:\n  SEED_ADMIN_PIN=482901 DATABASE_URL=... pnpm seed:pins",
    );
    process.exit(0);
  }

  for (const s of seeds) {
    if (!/^\d{6}$/.test(s.pin)) {
      console.error(`Invalid PIN for ${s.label} (need 6 digits)`);
      process.exit(1);
    }
    const hash = await bcrypt.hash(s.pin, 12);
    const id = randomUUID();
    await sql`
      INSERT INTO alarm_pins (id, label, pin_hash, scopes, active)
      VALUES (${id}, ${s.label}, ${hash}, ${s.scopes}, TRUE)
    `;
    console.log(`Seeded ${s.label} (${s.scopes.join("+")}) id=${id}`);
  }
  console.log("Done. PINs are not printed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
