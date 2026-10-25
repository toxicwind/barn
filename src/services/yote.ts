/**
 * Yote — Telegram gateway that uses OpenFang as an *external* HTTP service.
 * No OpenFang process env sharing; only OPENFANG_URL + optional OPENFANG_API_KEY.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "bun";
import { handleMeshRequest } from "../../src/lib/ghas-mesh-features.ts";
import { checkHealth, checkHealthLegacy } from "./lib/health";
import { OpenFangClient, openfang } from "./lib/openfang-client.ts";
import { Overlord } from "./lib/overlord";

const __f = fileURLToPath(import.meta.url);
const __d = dirname(__f);
const PR = resolve(__d, "..");

/** Load KEY=VAL into process.env if unset (yote/.env is SSOT for telegram). */
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (let line of readFileSync(path, "utf8").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7);
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFile(join(PR, ".env"));
loadEnvFile(join(PR, "..", "config", "ports.env"));
loadEnvFile(join(process.env.HOME || "/home/toxic", ".secrets"));

const LD = join(PR, "logs");
const CD = join(PR, "config");
const CF = join(CD, "yote_chats.json");
const LF = join(CD, "last_update.json");
const LG = join(LD, "yote.log");
const PORT = Number(process.env.YOTE_PORT ?? "25102");
const TOK = process.env.YOTE_TELEGRAM_BOT_TOKEN ?? "";
const ALW = new Set(
  (process.env.YOTE_TELEGRAM_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n) && n > 0),
);
const CHS = (process.env.YOTE_TELEGRAM_CHANNELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LLM = process.env.LLM_PROXY_URL ?? "http://127.0.0.1:25100";
const OF_URL = process.env.OPENFANG_URL ?? "http://127.0.0.1:25103";
const DEFAULT_AGENT = (
  process.env.YOTE_OPENFANG_AGENT ||
  process.env.DEFAULT_MODEL?.replace(/^openfang:/, "") ||
  "coyote"
).replace(/^openfang:/, "");
const PUP_TRIX_ID = Number(process.env.YOTE_TARGET_USER || "716302190");

/** Coyote persona for the herd fallback path (used only when OpenFang is down). */
const YOTE_SYSTEM = "You are Yote, a clever southwestern desert coyote and User's loyal trickster companion. Warm, dry, direct, a little mischievous — but all business when something real is at stake. Keep replies tight and useful. You answer as Yote in Telegram chats.";

/** Avatar sync: push the Yote avatar to the Telegram bot profile (once). */
const AVATAR_PATH =
  process.env.YOTE_AVATAR_PATH || join(CD, "yote-avatar.png");
const AVATAR_MARK = join(CD, ".avatar_synced");

const ofClient = new OpenFangClient(
  OF_URL,
  process.env.OPENFANG_API_KEY || "",
  DEFAULT_AGENT,
  [
    {
      agent: "coyote",
      model: "openfang:coyote",
      max_tokens: 512,
      temperature: 0.3,
      timeoutMs: 8000,
      label: "fast-local",
    },
    {
      agent: "coyote",
      model: "openfang:coyote",
      max_tokens: 1024,
      temperature: 0.4,
      timeoutMs: 15000,
      label: "balanced",
    },
    {
      agent: "coyote",
      model: "openfang:coyote",
      max_tokens: 2048,
      temperature: 0.5,
      timeoutMs: 30000,
      label: "thorough",
    },
  ],
);

/** per-chat agent override (user can /agent coyote) */
const chatAgent: Record<string, string> = {};

let chats: Record<string, any> = {};
let last = 0;
const shut = false;

const overlord = new Overlord({
  apiId: Number(process.env.YOTE_TELEGRAM_API_ID),
  apiHash: process.env.YOTE_TELEGRAM_API_HASH || "",
  session: process.env.YOTE_TELEGRAM_SESSION || "",
  onLog: (l) => log(l),
});
let overlordReady = false;
overlord
  .start()
  .then(() => {
    overlordReady = true;
    log("overlord connected");
  })
  .catch((e) => log(`overlord err: ${e.message ?? e}`));

function log(m: string) {
  const l = `[${new Date().toISOString()}] ${m}`;
  console.log(l);
  try {
    mkdirSync(dirname(LG), { recursive: true });
    appendFileSync(LG, `${l}\n`);
  } catch {
    /* */
  }
}
function loadChats() {
  try {
    if (existsSync(CF)) chats = JSON.parse(readFileSync(CF, "utf-8"));
  } catch {
    /* */
  }
}
function saveChats() {
  try {
    mkdirSync(dirname(CF), { recursive: true });
    writeFileSync(CF, JSON.stringify(chats, null, 2));
  } catch {
    /* */
  }
}
function loadLast() {
  try {
    if (existsSync(LF)) {
      const d = JSON.parse(readFileSync(LF, "utf-8"));
      last = d.lastUpdateId ?? 0;
    }
  } catch {
    /* */
  }
}
function saveLast() {
  try {
    mkdirSync(dirname(LF), { recursive: true });
    writeFileSync(
      LF,
      JSON.stringify(
        { lastUpdateId: last, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch {
    /* */
  }
}
function cors(r: Response) {
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  return r;
}
function jres(d: any, s = 200) {
  return cors(
    new Response(JSON.stringify(d, null, 2), {
      status: s,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function tg(m: string, b: any) {
  if (!TOK) return { ok: false, description: "no bot token" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOK}/${m}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

async function send(cid: number, t: string, o: any = {}) {
  const MX = 4000;
  const ps: string[] = [];
  let rem = t;
  while (rem.length > MX) {
    let cut = rem.lastIndexOf("\n", MX);
    if (cut < MX * 0.5) cut = rem.lastIndexOf(" ", MX);
    if (cut < 0) cut = MX;
    ps.push(rem.slice(0, cut));
    rem = rem.slice(cut).trimStart();
  }
  ps.push(rem);
  for (const p of ps) {
    if (!p.trim()) continue;
    const bd: any = { chat_id: cid, text: p };
    // Markdown often breaks on model output; plain text is safer
    if (o.parse_mode) bd.parse_mode = o.parse_mode;
    if (o.threadId) bd.message_thread_id = o.threadId;
    if (o.replyTo) bd.reply_to_message_id = o.replyTo;
    await tg("sendMessage", bd);
    await Bun.sleep(200);
  }
}

/** Direct herd (herd) chat — fallback when OpenFang is unreachable. */
async function herdChat(
  txt: string,
  maxTokens = 1024,
): Promise<{ ok: boolean; content: string; model: string }> {
  // Priority list: first model that answers wins. Env override:
  // YOTE_FALLBACK_MODELS="model-a,model-b". Defaults cover the herd catalog.
  const models = (process.env.YOTE_FALLBACK_MODELS ||
    "beellama/qwen-flash-128k,qwen-flash-128k,fast,code,gpt-oss")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  let lastErr = "";
  for (const model of models) {
    try {
      const r = await fetch(`${LLM}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: YOTE_SYSTEM },
            { role: "user", content: txt },
          ],
          max_tokens: maxTokens,
          temperature: 0.5,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const j: any = await r.json().catch(() => ({}));
      const content: string = j?.choices?.[0]?.message?.content || "";
      if (r.ok && content.trim()) {
        log(`herdChat ok via ${model}`);
        return { ok: true, content, model: j.model || model };
      }
      lastErr = `${model}: ${j?.error || r.status || "empty"}`.slice(0, 120);
    } catch (e: any) {
      lastErr = `${model}: ${e.message || e}`.slice(0, 120);
    }
  }
  log(`herdChat all models failed: ${lastErr}`);
  return { ok: false, content: "", model: models[0] || "none" };
}

/** OpenFang HTTP chat with herd fallback — Yote stays alive if OpenFang is down. */
async function ofChat(txt: string, agent?: string) {
  const r = await ofClient.chat(txt, {
    agent: agent || DEFAULT_AGENT,
    max_tokens: 1024,
  });
  if (r.ok) return r.content;
  log(`ofChat openfang failed (${r.agent}): ${r.error} — herd fallback`);
  const h = await herdChat(txt);
  if (h.ok) return `${h.content}\n\n⚡ via herd/${h.model} (openfang unreachable)`;
  return `openfang err (${r.agent}): ${r.error || "empty"}; herd fallback also down`;
}

async function hChat(cid: number, txt: string, o: any = {}) {
  const tb: any = { chat_id: cid, action: "typing" };
  if (o.threadId) tb.message_thread_id = o.threadId;
  await tg("sendChatAction", tb);
  const agent = chatAgent[String(cid)] || DEFAULT_AGENT;
  try {
    const rp = await ofChat(txt, agent);
    await send(cid, rp || "empty", o);
  } catch (e: any) {
    await send(cid, `err:${e.message || e}`, o);
  }
}

async function proc(up: any) {
  if (!up || typeof up !== "object") return;
  last = up.update_id as number;
  saveLast();
  if (up.callback_query) {
    const cb = up.callback_query;
    log(`cb ${cb.from?.username}:${cb.data}`);
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }
  const msg = (up.message ?? up.edited_message) as any;
  if (!msg) return;
  const cid = msg.chat?.id;
  const txt = (msg.text ?? "").trim();
  const uid = msg.from?.id;
  const tid = msg.message_thread_id;
  const mid = msg.message_id;
  if (!cid || !txt || !uid) return;
  if (ALW.size > 0 && !ALW.has(uid)) {
    log(`unauth ${uid} in ${cid}`);
    await tg("sendMessage", {
      chat_id: cid,
      text: "unauth",
      message_thread_id: tid,
    });
    return;
  }

  if (txt === "/start") {
    chats[String(cid)] = {
      user_id: uid,
      username: msg.from?.username,
      thread_id: tid,
      registered_at: new Date().toISOString(),
    };
    saveChats();
    await send(
      cid,
      `yote v0.6 · openfang external API @ ${OF_URL}\nagent: ${chatAgent[String(cid)] || DEFAULT_AGENT}\ncmds: /start /status /health /agent <name> /agents\nwatching: ${CHS.join(",") || "all"}\nallowed: ${Array.from(ALW).join(",")}`,
      { threadId: tid },
    );
    return;
  }

  if (txt === "/status") {
    const h = await checkHealthLegacy();
    const ofh = await ofClient.health();
    await send(
      cid,
      `status llama:${h.llama ? "ok" : "down"} openfang:${ofh.ok ? "ok" : "down"} (${ofh.ms}ms) agent:${chatAgent[String(cid)] || DEFAULT_AGENT} gpu:${h.gpu}`,
      { threadId: tid },
    );
    return;
  }

  if (txt === "/health") {
    const h = await checkHealth();
    const ofh = await ofClient.health();
    await send(
      cid,
      `health ${h.overall} dur:${h.durationMs}ms llama:${h.llamaSwap.healthy ? "ok" : "down"} of_api:${ofh.ok ? "ok" : "down"} of_body:${JSON.stringify(ofh.body).slice(0, 80)}`,
      { threadId: tid },
    );
    return;
  }

  if (txt === "/agents" || txt.startsWith("/agents ")) {
    const { ok, agents, error } = await ofClient.listAgents();
    if (!ok) {
      await send(cid, `agents err: ${error}`, { threadId: tid });
      return;
    }
    const lines = agents.map(
      (a) =>
        `• ${a.name} ${a.ready ? "ready" : a.state || "?"} [${a.model_provider || "?"}:${a.model_name || "?"}]`,
    );
    await send(
      cid,
      `openfang agents (${agents.length}) via ${OF_URL}/api/agents\n` +
        lines.join("\n"),
      { threadId: tid },
    );
    return;
  }

  if (txt.startsWith("/agent")) {
    const name = txt.replace(/^\/agent\s*/, "").trim();
    if (!name) {
      await send(
        cid,
        `current agent: ${chatAgent[String(cid)] || DEFAULT_AGENT}\nset: /agent coyote`,
        { threadId: tid },
      );
      return;
    }
    chatAgent[String(cid)] = name.replace(/^openfang:/, "");
    await send(cid, `agent set → ${chatAgent[String(cid)]}`, {
      threadId: tid,
    });
    return;
  }

  await hChat(cid, txt, { threadId: tid, replyTo: mid });
}

async function poll() {
  loadChats();
  loadLast();
  log(`poll start last=${last} token=${TOK ? "set" : "MISSING"}`);
  while (!shut) {
    try {
      const r: any = await tg("getUpdates", {
        offset: last + 1,
        timeout: 25,
        allowed_updates: ["message", "edited_message", "callback_query"],
      });
      if (r.ok && Array.isArray(r.result)) {
        for (const u of r.result) await proc(u);
      } else if (r.description) {
        log(`poll tg: ${r.description}`);
        await Bun.sleep(3000);
      }
    } catch (e: any) {
      log(`poll err ${e.message || e}`);
      await Bun.sleep(2000);
    }
    await Bun.sleep(500);
  }
}

async function testOverlordSend(target: string, text: string) {
  if (!overlordReady) return { ok: false, error: "overlord not connected" };
  const cl = overlord.client;
  const entity = await cl.getEntity(target);
  const sent = await cl.sendMessage(entity, { message: text });
  log(`overlord sent to ${target}: "${text}" msg_id=${sent.id}`);
  return { ok: true, sent: text, target, msgId: sent.id };
}

async function testE2E(chatId: number, text: string) {
  const prev = last;
  const fakeUp = {
    update_id: 999999999,
    message: {
      message_id: Date.now(),
      from: { id: chatId, username: "test" },
      chat: { id: chatId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
  await proc(fakeUp);
  last = prev;
  saveLast();
  return {
    ok: true,
    sent: text,
    chatId,
    agent: chatAgent[String(chatId)] || DEFAULT_AGENT,
    via: "openfang-http",
  };
}

const app = serve({
  port: PORT,
  async fetch(req) {
    const u = new URL(req.url);
    const p = u.pathname;
    if (p.startsWith("/mesh")) {
      const m = await handleMeshRequest(req, {
        service: "yote",
        version: "yote-0.6",
      });
      if (m) return cors(m);
    }
    if (p === "/health") return cors(new Response("ok"));
    if (p === "/") {
      return jres({
        svc: "yote",
        version: "0.6",
        port: PORT,
        openfang_url: OF_URL,
        openfang_agent: DEFAULT_AGENT,
        integration: "openfang-http-api-only",
        llm_fallback_display: LLM,
        chs: CHS,
        overlord: overlordReady,
        bot_token_set: Boolean(TOK),
        pup_trix_id: PUP_TRIX_ID,
        avatar_url: "/avatar",
        avatar_idle_url: "/avatar/idle",
      });
    }

    // Proxy pure LLM path still available for debugging (not OpenFang)
    if (p === "/v1/chat/completions" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      // Prefer OpenFang OpenAI surface when model is openfang:*
      const model = String((b as any).model || "");
      if (model.startsWith("openfang:") || !model) {
        const messages = (b as any).messages || [];
        const lastUser =
          [...messages].reverse().find((m: any) => m.role === "user")
            ?.content || "";
        const agent = model.replace(/^openfang:/, "") || DEFAULT_AGENT;
        const r = await ofClient.chat(String(lastUser), {
          agent,
          max_tokens: (b as any).max_tokens,
        });
        return jres({
          id: `yote-of-${Date.now()}`,
          object: "chat.completion",
          model: r.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: r.content },
              finish_reason: "stop",
            },
          ],
          openfang: { ok: r.ok, error: r.error, ms: r.ms },
        });
      }
      const r = await fetch(`${LLM}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      const t = await r.text();
      return cors(
        new Response(t, {
          status: r.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (p === "/api/telegram/webhook" && req.method === "POST") {
      const up = await req.json().catch(() => null);
      if (up) await proc(up);
      return jres({ ok: true });
    }

    // OpenFang external API diagnostics
    if (p === "/api/openfang/health") {
      return jres(await ofClient.health());
    }
    if (p === "/api/openfang/agents") {
      return jres(await ofClient.listAgents());
    }
    if (p === "/api/openfang/models") {
      return jres({ models: await ofClient.listOpenAiModels() });
    }
    if (p === "/api/openfang/probe" || p === "/api/openfang/probe-all") {
      const report = await ofClient.probeAllAgents();
      return jres(report, report.fail ? 207 : 200);
    }
    if (p === "/api/openfang/chat" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const r = await ofClient.chat(String(b.message || b.text || "hi"), {
        agent: b.agent,
        max_tokens: b.max_tokens,
      });
      return jres(r, r.ok ? 200 : 502);
    }
    if (p === "/api/openfang/chat") {
      const msg = u.searchParams.get("msg") || "Reply with: YOTE_OF_OK";
      const agent = u.searchParams.get("agent") || DEFAULT_AGENT;
      const r = await ofClient.chat(msg, { agent, max_tokens: 64 });
      return jres(r, r.ok ? 200 : 502);
    }

    if (p === "/test/llm") {
      const msg = u.searchParams.get("msg") || "say hi";
      const agent = u.searchParams.get("agent") || DEFAULT_AGENT;
      const r = await ofClient.chat(msg, { agent });
      return jres({
        ok: r.ok,
        agent: r.agent,
        model: r.model,
        response: r.content,
        error: r.error,
        ms: r.ms,
        fasterRouteAttempted: r.fasterRouteAttempted,
        fallbackUsed: r.fallbackUsed,
        via: "openfang-http",
      });
    }

    if (p === "/test/send" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const cid = b.chat_id || PUP_TRIX_ID;
      const txt = b.text || "test from yote api (openfang-external)";
      const res = await tg("sendMessage", { chat_id: cid, text: txt });
      return jres({ ok: Boolean(res?.ok), sent: txt, chatId: cid, tg: res });
    }
    if (p === "/test/send") {
      // GET: overlord MTProto send (optional) OR bot API to Pup Trix
      const mode = u.searchParams.get("mode") || "bot";
      const txt =
        u.searchParams.get("msg") ||
        `yote→openfang external test ${new Date().toISOString()}`;
      if (mode === "overlord") {
        const target = u.searchParams.get("to") || "crawlspace_coyote_bot";
        const r = await testOverlordSend(target, txt);
        return jres(r);
      }
      const cid = Number(u.searchParams.get("chat_id") || PUP_TRIX_ID);
      const res = await tg("sendMessage", { chat_id: cid, text: txt });
      return jres({
        ok: Boolean(res?.ok),
        mode: "bot",
        chatId: cid,
        sent: txt,
        tg: res,
        note: "Pup Trix target YOTE_TARGET_USER / 716302190",
      });
    }

    if (p === "/test/e2e" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const cid = b.chat_id || PUP_TRIX_ID;
      const txt = b.text || "hello from yote e2e openfang";
      const r = await testE2E(cid, txt);
      return jres(r);
    }
    if (p === "/test/e2e") {
      const cid = Number(u.searchParams.get("chat_id") || PUP_TRIX_ID);
      const txt = u.searchParams.get("msg") || "hello from yote e2e openfang";
      const r = await testE2E(cid, txt);
      return jres(r);
    }

    if (p === "/test/pup-trix") {
      // Full path: OpenFang chat + bot message to real id
      const msg =
        u.searchParams.get("msg") ||
        "Pup Trix probe: reply with ESTATE_YOTE_OK";
      const agent = u.searchParams.get("agent") || DEFAULT_AGENT;
      const of = await ofClient.chat(msg, { agent, max_tokens: 128 });
      const text = of.ok
        ? `🤖 openfang:${of.agent} (${of.ms}ms)\n${of.content}`
        : `openfang failed: ${of.error}`;
      const tgRes = await tg("sendMessage", {
        chat_id: PUP_TRIX_ID,
        text,
      });
      return jres({
        openfang: of,
        telegram: tgRes,
        chat_id: PUP_TRIX_ID,
        ok: of.ok && Boolean(tgRes?.ok),
      });
    }

    if (p === "/test/fallback") {
      // Exercise the full ofChat path (OpenFang -> herd fallback) without
      // touching Telegram. Returns which tier answered.
      const msg = u.searchParams.get("msg") || "Reply with the single word: yip";
      const agent = u.searchParams.get("agent") || DEFAULT_AGENT;
      const t = Date.now();
      const text = await ofChat(msg, agent);
      const via = text.includes("(openfang unreachable)")
        ? "herd-fallback"
        : text.startsWith("openfang err")
          ? "none"
          : "openfang";
      return jres({
        ok: via !== "none",
        via,
        ms: Date.now() - t,
        reply: text.slice(0, 600),
      });
    }

    if (p === "/avatar") {
      const f = Bun.file(AVATAR_PATH);
      if (!(await f.exists()))
        return cors(new Response("no avatar", { status: 404 }));
      return cors(
        new Response(f, {
          headers: {
            "content-type": "image/png",
            "content-length": String(f.size),
            "cache-control": "public, max-age=86400",
          },
        }),
      );
    }
    if (p === "/avatar/idle") {
      const f = Bun.file(join(CD, "yote-avatar-idle.mp4"));
      if (!(await f.exists()))
        return cors(new Response("no idle video", { status: 404 }));
      return cors(
        new Response(f, {
          headers: {
            "content-type": "video/mp4",
            "content-length": String(f.size),
            "cache-control": "public, max-age=86400",
          },
        }),
      );
    }

    return cors(new Response("not found", { status: 404 }));
  },
});

/** Push the Yote avatar to the Telegram bot profile photo (once per avatar). */
async function syncAvatar() {
  // Push the Yote avatar to the Telegram bot profile once. Bot API
  // setMyProfilePhoto takes an InputProfilePhoto object:
  //   photo = JSON {type:"static", photo:"attach://<name>"}
  // with the PNG bytes attached under that name. Guarded by a marker file.
  try {
    if (!TOK || existsSync(AVATAR_MARK)) return;
    if (!existsSync(AVATAR_PATH)) return;
    const buf = readFileSync(AVATAR_PATH);
    const fd = new FormData();
    fd.append(
      "photo",
      JSON.stringify({ type: "static", photo: "attach://yote-avatar.png" }),
    );
    fd.append(
      "yote-avatar.png",
      new Blob([buf], { type: "image/png" }),
      "yote-avatar.png",
    );
    const r = await fetch(`https://api.telegram.org/bot${TOK}/setMyProfilePhoto`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(60000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok) {
      writeFileSync(AVATAR_MARK, new Date().toISOString());
      log("avatar synced to telegram bot profile");
    } else {
      log(`avatar sync failed: ${JSON.stringify(j).slice(0, 160)}`);
    }
  } catch (e: any) {
    log(`avatar sync err ${(e && e.message) || e}`);
  }
}

if (TOK) poll().catch((e) => log(`poll fatal ${e}`));
else log("WARNING: YOTE_TELEGRAM_BOT_TOKEN missing — poll disabled");
syncAvatar();

export default app;
export { ofClient, openfang };
