/**
 * Secret-authenticated remote ops for Cursor / automation.
 * Hit over Tailscale: POST /agent with Authorization: Bearer $GATEWAY_POLL_SECRET
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";

const execFileAsync = promisify(execFile);

const ALLOWED = new Set(["health", "logs", "env", "sync", "sync-notify", "restart"]);

export function agentAuthorized(req: IncomingMessage, secret: string): boolean {
  if (!secret) return false;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token.length > 0 && token === secret;
}

function repoDir(): string {
  return process.env.ARNOLD_ALARM_REPO || join(homedir(), "arnold-alarm");
}

function envFile(): string {
  return process.env.GATEWAY_ENV_FILE || join(homedir(), ".config/arnold-alarm/gateway.env");
}

function redactEnvLine(line: string): string {
  const t = line.trim();
  if (!t || t.startsWith("#")) return t;
  const eq = t.indexOf("=");
  if (eq < 1) return t;
  const key = t.slice(0, eq);
  const upper = key.toUpperCase();
  if (
    upper.includes("PASS") ||
    upper.includes("SECRET") ||
    upper.includes("TOKEN") ||
    upper.includes("KEY")
  ) {
    return `${key}=***`;
  }
  return t;
}

async function runShell(
  cmd: string,
  args: string[],
  timeoutMs = 120_000,
  cwd?: string,
) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    cwd,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function runAgentAction(
  action: string,
  meta: { requestedBy?: string } = {},
): Promise<Record<string, unknown>> {
  const act = action.trim().toLowerCase();
  if (!ALLOWED.has(act)) {
    throw Object.assign(new Error(`Unknown agent action: ${action}`), { status: 400 });
  }

  if (act === "health") {
    return { ok: true, action: act, repo: repoDir(), envFile: envFile() };
  }

  if (act === "logs") {
    const { stdout } = await runShell("journalctl", [
      "-u",
      "arnold-alarm-gateway",
      "-n",
      "100",
      "--no-pager",
    ]);
    return { ok: true, action: act, lines: stdout.split("\n").filter(Boolean) };
  }

  if (act === "env") {
    const path = envFile();
    if (!existsSync(path)) {
      return { ok: false, action: act, error: `missing ${path}` };
    }
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map(redactEnvLine)
      .filter((l) => l.length > 0);
    return { ok: true, action: act, path, lines };
  }

  if (act === "sync" || act === "sync-notify") {
    const repo = repoDir();
    const notifyScript = join(repo, "scripts/pi-sync-notify.sh");
    const steps: string[] = [];

    const pull = await runShell("git", ["-C", repo, "pull", "--ff-only", "origin", "main"]);
    steps.push(pull.stdout || "git pull ok");

    if (act === "sync-notify" && existsSync(notifyScript)) {
      const sync = await runShell("bash", [notifyScript], 180_000);
      steps.push(sync.stdout);
      if (sync.stderr) steps.push(sync.stderr);
      return { ok: true, action: act, steps, requestedBy: meta.requestedBy };
    }

    const gw = join(repo, "apps/gateway");
    await runShell("pnpm", ["install"], 180_000, gw);
    steps.push("pnpm install ok");
    await runShell("pnpm", ["run", "build"], 120_000, gw);
    steps.push("pnpm build ok");
    await runShell("sudo", ["systemctl", "restart", "arnold-alarm-gateway"], 30_000);
    steps.push("service restarted");
    return { ok: true, action: act, steps, requestedBy: meta.requestedBy };
  }

  if (act === "restart") {
    await runShell("sudo", ["systemctl", "restart", "arnold-alarm-gateway"], 30_000);
    return { ok: true, action: act, restarted: true };
  }

  throw Object.assign(new Error(`Unhandled action: ${act}`), { status: 500 });
}
