/**
 * Register the gateway as a UniFi Talk "Third-Party Device" (SIP client).
 * Talk then dials the assigned extension → INVITE lands on our existing SIP UA.
 */
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";

const require = createRequire(import.meta.url);

export type TalkRegStatus = {
  enabled: boolean;
  registered: boolean;
  host: string | null;
  user: string | null;
  lastError: string | null;
};

type SipResponse = {
  status: number;
  reason?: string;
  headers: Record<string, unknown>;
};

type SipSend = {
  send: (msg: Record<string, unknown>, callback?: (res: SipResponse) => void) => void;
};

let timer: ReturnType<typeof setTimeout> | null = null;
let registered = false;
let lastError: string | null = null;
let host: string | null = null;
let user: string | null = null;
let seq = 1;
let callId = "";
let fromTag = "";

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

export function getTalkRegStatus(): TalkRegStatus {
  return {
    enabled: Boolean(host && user),
    registered,
    host,
    user,
    lastError,
  };
}

export function stopTalkRegistration(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  registered = false;
}

/**
 * @param sipSend — SipStack._instance (same UDP socket as the PA listener)
 */
export function startTalkRegistration(sipSend: SipSend, contactPort: number): void {
  stopTalkRegistration();

  host = (process.env.PA_TALK_HOST || "").trim() || null;
  user = (process.env.PA_TALK_USER || "").trim() || null;
  const pass = (process.env.PA_TALK_PASS || "").trim();
  const targetPort = Number(process.env.PA_TALK_PORT || 5060);
  const expires = Math.max(60, Number(process.env.PA_TALK_EXPIRES || 300));

  if (!host || !user || !pass) {
    console.log(
      "[pa/talk] Third-Party Device registration idle — set PA_TALK_HOST, PA_TALK_USER, PA_TALK_PASS",
    );
    return;
  }

  let sip: {
    generateBranch: () => string;
    generateTag: () => string;
    parseUri: (u: string) => unknown;
  };
  let digest: {
    signRequest: (
      ctx: Record<string, unknown>,
      request: Record<string, unknown>,
      response: SipResponse | null,
      credentials: { user: string; password: string },
    ) => unknown;
  };
  try {
    sip = require("@vexyl.ai/sip");
    digest = require("@vexyl.ai/sip/digest");
  } catch (err) {
    lastError = "sip module missing";
    console.error("[pa/talk] cannot load @vexyl.ai/sip", err);
    return;
  }

  const contactHost = lanIp();
  const credentials = { user, password: pass };
  const authCtx: Record<string, unknown> = {};
  const aor = `sip:${user}@${host}`;
  const registrarUri = `sip:${host}:${targetPort}`;

  if (!callId) {
    callId = `${Date.now()}-${Math.random().toString(16).slice(2)}@${contactHost}`;
  }
  if (!fromTag) fromTag = sip.generateTag();

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => registerOnce(false), ms);
  };

  const buildRequest = () => {
    seq += 1;
    return {
      method: "REGISTER",
      uri: registrarUri,
      version: "2.0",
      headers: {
        // sip.js expects via as an array; empty lets transport fill hop
        via: [],
        "max-forwards": 70,
        from: { uri: aor, params: { tag: fromTag } },
        to: { uri: aor },
        "call-id": callId,
        cseq: { seq, method: "REGISTER" },
        contact: [
          {
            uri: `sip:${user}@${contactHost}:${contactPort}`,
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
      registered = true;
      lastError = null;
      console.log(
        `[pa/talk] registered ${user} → ${host}:${targetPort} (expires ${expires}s)`,
      );
      schedule(Math.floor(expires * 0.45) * 1000);
      return;
    }
    registered = false;
    lastError = `${res.status} ${res.reason || ""}`.trim();
    console.error("[pa/talk] register failed:", lastError);
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
                lastError = String(err);
                console.error("[pa/talk] register callback error", err);
                schedule(20000);
              }
            });
            return;
          }
          onFinal(res);
        } catch (err) {
          lastError = String(err);
          console.error("[pa/talk] register callback error", err);
          schedule(20000);
        }
      });
    } catch (err) {
      lastError = String(err);
      console.error("[pa/talk] register send error", err);
      schedule(20000);
    }
  };

  console.log(`[pa/talk] registering as ${user} @ ${host}:${targetPort}…`);
  registerOnce(false);
}
