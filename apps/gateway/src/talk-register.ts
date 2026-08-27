/**
 * Register the gateway as one or more SIP clients (Alltree / UniFi Talk, etc.).
 * The PBX then dials those extensions → INVITE lands on our SIP UA.
 */
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";

const require = createRequire(import.meta.url);

export type TalkAccountMode = "menu" | "pa" | "test";

export type TalkAccount = {
  user: string;
  password: string;
  host: string;
  port: number;
  mode: TalkAccountMode;
  expires: number;
};

export type TalkRegStatus = {
  enabled: boolean;
  registered: boolean;
  host: string | null;
  user: string | null;
  lastError: string | null;
  accounts: Array<{
    user: string;
    mode: TalkAccountMode;
    registered: boolean;
    lastError: string | null;
  }>;
};

type SipResponse = {
  status: number;
  reason?: string;
  headers: Record<string, unknown>;
};

type SipSend = {
  send: (msg: Record<string, unknown>, callback?: (res: SipResponse) => void) => void;
};

type RegHandle = {
  account: TalkAccount;
  timer: ReturnType<typeof setTimeout> | null;
  registered: boolean;
  lastError: string | null;
  seq: number;
  callId: string;
  fromTag: string;
};

let handles: RegHandle[] = [];
let sipMod: {
  generateBranch: () => string;
  generateTag: () => string;
  parseUri: (u: string) => unknown;
} | null = null;
let digestMod: {
  signRequest: (
    ctx: Record<string, unknown>,
    request: Record<string, unknown>,
    response: SipResponse | null,
    credentials: { user: string; password: string },
  ) => unknown;
} | null = null;

function lanIp(): string {
  const fromEnv = process.env.PA_PUBLIC_IP || process.env.PA_BIND_IP;
  if (fromEnv) return fromEnv;
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal && n.address.startsWith("192.168.")) {
        return n.address;
      }
    }
  }
  return "127.0.0.1";
}

function parseMode(raw: string | undefined, fallback: TalkAccountMode): TalkAccountMode {
  const m = (raw || fallback).trim().toLowerCase();
  if (m === "pa" || m === "page" || m === "live") return "pa";
  if (m === "test") return "test";
  return "menu";
}

/** Accounts from env: menu line (PA_TALK_*) + optional direct-page line (PA_PAGE_*). */
export function parseTalkAccounts(): TalkAccount[] {
  const host = (process.env.PA_TALK_HOST || "").trim();
  const port = Number(process.env.PA_TALK_PORT || 5060);
  const expires = Math.max(60, Number(process.env.PA_TALK_EXPIRES || 300));
  const out: TalkAccount[] = [];

  const talkUser = (process.env.PA_TALK_USER || "").trim();
  const talkPass = (process.env.PA_TALK_PASS || "").trim();
  if (host && talkUser && talkPass) {
    out.push({
      user: talkUser,
      password: talkPass,
      host,
      port,
      mode: parseMode(process.env.PA_TALK_MODE, "menu"),
      expires,
    });
  }

  const pageUser = (
    process.env.PA_PAGE_USER ||
    process.env.PA_PAGE_EXT ||
    ""
  ).trim();
  const pagePass = (process.env.PA_PAGE_PASS || "").trim();
  const pageHost = (process.env.PA_PAGE_HOST || host).trim();
  const pagePort = Number(process.env.PA_PAGE_PORT || port || 5060);
  if (pageHost && pageUser && pagePass) {
    const dup = out.some((a) => a.user === pageUser && a.host === pageHost);
    if (!dup) {
      out.push({
        user: pageUser,
        password: pagePass,
        host: pageHost,
        port: pagePort,
        mode: parseMode(process.env.PA_PAGE_MODE, "pa"),
        expires: Math.max(60, Number(process.env.PA_PAGE_EXPIRES || expires)),
      });
    }
  }

  return out;
}

export function modeForCalledUser(called: string): TalkAccountMode | null {
  if (!called) return null;
  for (const a of parseTalkAccounts()) {
    if (called === a.user || called.endsWith(a.user)) return a.mode;
  }
  return null;
}

export function getTalkRegStatus(): TalkRegStatus {
  const primary = handles[0];
  return {
    enabled: handles.length > 0,
    registered: handles.some((h) => h.registered),
    host: primary?.account.host ?? null,
    user: primary?.account.user ?? null,
    lastError: handles.find((h) => h.lastError)?.lastError ?? null,
    accounts: handles.map((h) => ({
      user: h.account.user,
      mode: h.account.mode,
      registered: h.registered,
      lastError: h.lastError,
    })),
  };
}

export function stopTalkRegistration(): void {
  for (const h of handles) {
    if (h.timer) clearTimeout(h.timer);
  }
  handles = [];
}

/**
 * @param sipSend — SipStack._instance (same UDP socket as the PA listener)
 */
export function startTalkRegistration(sipSend: SipSend, contactPort: number): void {
  stopTalkRegistration();

  const accounts = parseTalkAccounts();
  if (!accounts.length) {
    console.log(
      "[pa/talk] SIP registration idle — set PA_TALK_HOST/USER/PASS (and optional PA_PAGE_USER/PASS)",
    );
    return;
  }

  try {
    sipMod = require("@vexyl.ai/sip");
    digestMod = require("@vexyl.ai/sip/digest");
  } catch (err) {
    console.error("[pa/talk] cannot load @vexyl.ai/sip", err);
    return;
  }

  const contactHost = lanIp();
  for (const account of accounts) {
    startOneRegistration(sipSend, contactPort, contactHost, account);
  }
}

function startOneRegistration(
  sipSend: SipSend,
  contactPort: number,
  contactHost: string,
  account: TalkAccount,
): void {
  const sip = sipMod!;
  const digest = digestMod!;
  const handle: RegHandle = {
    account,
    timer: null,
    registered: false,
    lastError: null,
    seq: 1,
    callId: `${Date.now()}-${account.user}-${Math.random().toString(16).slice(2)}@${contactHost}`,
    fromTag: sip.generateTag(),
  };
  handles.push(handle);

  const credentials = { user: account.user, password: account.password };
  const authCtx: Record<string, unknown> = {};
  const aor = `sip:${account.user}@${account.host}`;
  const registrarUri = `sip:${account.host}:${account.port}`;
  const { expires } = account;

  const schedule = (ms: number) => {
    if (handle.timer) clearTimeout(handle.timer);
    handle.timer = setTimeout(() => registerOnce(false), ms);
  };

  const buildRequest = () => {
    handle.seq += 1;
    return {
      method: "REGISTER",
      uri: registrarUri,
      version: "2.0",
      headers: {
        via: [],
        "max-forwards": 70,
        from: { uri: aor, params: { tag: handle.fromTag } },
        to: { uri: aor },
        "call-id": handle.callId,
        cseq: { seq: handle.seq, method: "REGISTER" },
        contact: [
          {
            uri: `sip:${account.user}@${contactHost}:${contactPort}`,
            params: { expires: String(expires) },
          },
        ],
        expires,
        "user-agent": "arnold-alarm-pa",
        "content-length": 0,
      },
      content: "",
    };
  };

  const onFinal = (res: SipResponse) => {
    if (res.status >= 200 && res.status < 300) {
      handle.registered = true;
      handle.lastError = null;
      console.log(
        `[pa/talk] registered ${account.user} (${account.mode}) → ${account.host}:${account.port} (expires ${expires}s)`,
      );
      schedule(Math.floor(expires * 0.45) * 1000);
      return;
    }
    handle.registered = false;
    handle.lastError = `${res.status} ${res.reason || ""}`.trim();
    console.error(`[pa/talk] register ${account.user} failed:`, handle.lastError);
    schedule(20000);
  };

  const registerOnce = (withAuth: boolean) => {
    try {
      const req = buildRequest();
      if (withAuth) {
        digest.signRequest(authCtx, req, null, credentials);
      }

      sipSend.send(req, (res) => {
        try {
          if (res.status === 401 || res.status === 407) {
            digest.signRequest(authCtx, req, res, credentials);
            const authed = buildRequest();
            digest.signRequest(authCtx, authed, res, credentials);
            sipSend.send(authed, (res2) => {
              try {
                onFinal(res2);
              } catch (err) {
                handle.lastError = String(err);
                console.error(`[pa/talk] register ${account.user} callback error`, err);
                schedule(20000);
              }
            });
            return;
          }
          onFinal(res);
        } catch (err) {
          handle.lastError = String(err);
          console.error(`[pa/talk] register ${account.user} callback error`, err);
          schedule(20000);
        }
      });
    } catch (err) {
      handle.lastError = String(err);
      console.error(`[pa/talk] register ${account.user} send error`, err);
      schedule(20000);
    }
  };

  console.log(
    `[pa/talk] registering as ${account.user} (${account.mode}) @ ${account.host}:${account.port}…`,
  );
  registerOnce(false);
}
