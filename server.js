// server.js (ESM)
// Node >= 18 (fetch natif)
// Dépendances: npm i express cors

import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

// =================== CONFIG ===================
const PORT = process.env.PORT || 8080;

// CSV de worldIds autorisés. Laisser vide => tout autoriser.
const ALLOWED_WORLD_IDS = (process.env.ALLOWED_WORLD_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Limites et anti-spam
const MAX_LEN       = parseInt(process.env.MAX_LEN       || "200", 10);  // len max d'un message
const COOLDOWN_MS   = parseInt(process.env.COOLDOWN_MS   || "2000", 10); // 1 msg / 2s par IP
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_LIMIT || "100", 10);  // taille page

// JSON store local par défaut (si doc non fourni)
const DEFAULT_JSON_STORE_FILE = process.env.JSON_STORE_FILE || path.join("data", "store.json");
// Auth facultative pour /json/set
const WRITE_TOKEN     = process.env.JSON_WRITE_TOKEN || "";

// Push GitHub (facultatif)
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN   || "";
const GITHUB_REPO    = process.env.GITHUB_REPO    || "";
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH  || "main";
const GITHUB_PUSH_ENABLED = (process.env.GITHUB_PUSH_ENABLED ?? "1") !== "0";

// =================== APP ===================
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "32kb" }));
app.use(cors({ origin: true }));

// Logs simples (méthode, path, query)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${JSON.stringify(req.query)}`);
  next();
});

function setNoCache(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

app.use(express.static("public", { setHeaders: setNoCache }));

// =================== UTIL ===================
const nowISO = () => new Date().toISOString();
const toIntOrDefault = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const clientIP = (req) =>
  (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) ||
  req.ip || req.socket.remoteAddress || "ip:unknown";

function ensureDirFor(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileForDoc(doc) {
  // doc=store => data/store.json ; sinon fichier par défaut
  const safe = (doc || "").toString().trim();
  if (!safe) return DEFAULT_JSON_STORE_FILE;
  return path.join("data", `${safe}.json`);
}

function loadStore(file) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Store load error:", e);
  }
  return {}; // défaut vide
}

function saveStoreSync(file, obj) {
  try {
    ensureDirFor(file);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
  } catch (e) {
    console.error("Store save error:", e);
  }
}

// Accès via chemin "a.b.c"
function getByPath(obj, pathStr) {
  if (!pathStr) return obj;
  return pathStr.split(".").reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}
function setByPath(obj, pathStr, val) {
  if (!pathStr) throw new Error("path-required");
  const keys = pathStr.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = val;
}

// =================== GITHUB PUSH ===================
async function githubFetchJson(url, init = {}) {
  const headers = init.headers || {};
  const res = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      ...headers,
    },
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
async function pushToGithub(storeFile, message = "Update via API") {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_PUSH_ENABLED) return { skipped: true };

  try {
    const relFile = path.relative(process.cwd(), storeFile).replace(/\\/g, "/");
    const getUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(relFile)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const getRes = await githubFetchJson(getUrl, { method: "GET" });

    let sha = undefined;
    if (getRes.ok && getRes.json?.sha) sha = getRes.json.sha;

    const content = fs.readFileSync(storeFile, "utf-8");
    const newContentB64 = Buffer.from(content).toString("base64");

    const putUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(relFile)}`;
    const body = {
      message,
      content: newContentB64,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    };
    const putRes = await githubFetchJson(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      console.error("GitHub PUT error:", putRes.status, putRes.json?.message, putRes.json);
      return { ok: false, status: putRes.status, error: putRes.json?.message || "github-put-failed" };
    }
    return { ok: true, commit: putRes.json?.commit };
  } catch (e) {
    console.error("GitHub push exception:", e);
    return { ok: false, error: String(e) };
  }
}

// =================== ÉTAT EN MÉMOIRE (chat) ===================
let AUTO_ID = 0;
const MESSAGES = []; // { id, uuid, worldId, channel, username, text, timestamp }
const lastSentByIP = new Map();

// =================== ROUTES ===================

// Santé
app.get("/", (_req, res) => {
  res.type("text/plain").send("GlobalChat backend OK");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: nowISO() });
});

// -------- Chat (inchangé) --------
app.get("/send", (req, res) => {
  const ip = clientIP(req);
  const last = lastSentByIP.get(ip) || 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) return res.status(429).json({ ok: false, error: "rate-limit" });

  let { worldId, channel = "global", username = "Guest", text = "" } = req.query;
  worldId = (worldId || "").toString().trim();
  channel = (channel || "global").toString().trim();
  username = (username || "Guest").toString().trim();
  text = (text || "").toString();

  if (!worldId) return res.status(400).json({ ok: false, error: "worldId-required" });
  if (ALLOWED_WORLD_IDS.length && !ALLOWED_WORLD_IDS.includes(worldId))
    return res.status(403).json({ ok: false, error: "worldId-forbidden" });

  const trimmed = text.trim();
  if (!trimmed) return res.status(400).json({ ok: false, error: "empty" });
  if (trimmed.length > MAX_LEN) return res.status(400).json({ ok: false, error: "too-long" });

  const msg = {
    id: ++AUTO_ID,
    uuid: randomUUID(),
    worldId,
    channel,
    username: username.slice(0, 24),
    text: trimmed,
    timestamp: nowISO(),
  };

  MESSAGES.push(msg);
  lastSentByIP.set(ip, now);
  return res.json({ ok: true, id: msg.id, timestamp: msg.timestamp });
});

app.get("/messages", (req, res) => {
  let { worldId = "", channel = "", since = "0", limit } = req.query;
  worldId = worldId.toString().trim();
  channel = channel.toString().trim();
  const sinceId = toIntOrDefault(since, 0);
  const lim = Math.max(1, Math.min(200, toIntOrDefault(limit, DEFAULT_LIMIT)));

  let out = MESSAGES;
  if (ALLOWED_WORLD_IDS.length && worldId) out = out.filter((m) => m.worldId === worldId);
  if (channel) out = out.filter((m) => m.channel === channel);
  out = out.filter((m) => m.id > sinceId).sort((a, b) => a.id - b.id);

  const slice = out.slice(0, lim);
  const cursor = slice.length ? String(slice[slice.length - 1].id) : String(sinceId);

  setNoCache(res);
  return res.json({
    cursor,
    messages: slice.map((m) => ({
      id: m.id, worldId: m.worldId, channel: m.channel,
      username: m.username, text: m.text, timestamp: m.timestamp,
    })),
  });
});

app.get("/messages.json", (req, res) => {
  let { worldId = "", channel = "", limit } = req.query;
  worldId = worldId.toString().trim();
  channel = channel.toString().trim();
  const lim = Math.max(1, Math.min(200, toIntOrDefault(limit, DEFAULT_LIMIT)));

  let out = MESSAGES;
  if (ALLOWED_WORLD_IDS.length && worldId) out = out.filter((m) => m.worldId === worldId);
  if (channel) out = out.filter((m) => m.channel === channel);

  const slice = out.slice(-lim);
  setNoCache(res);
  return res.json({
    messages: slice.map((m) => ({
      username: m.username, text: m.text, timestamp: m.timestamp,
    })),
  });
});

// -------- JSON STORE: multi-doc + GET-only friendly --------

// util pour charger/écrire par "doc"
function readDoc(doc) {
  const file = fileForDoc(doc);
  return { file, store: loadStore(file) };
}
function writeDoc(file, store, message) {
  saveStoreSync(file, store);
  return pushToGithub(file, message);
}

// Lecture générique: /json/get?doc=store&path=players.Hyroe.playMs
app.get("/json/get", (req, res) => {
  const doc = (req.query.doc || "").toString().trim();
  const p   = (req.query.path || "").toString().trim();

  const { file, store } = readDoc(doc);
  const value = p ? getByPath(store, p) : store;

  setNoCache(res);
  return res.json({ ok: true, doc: doc || "default", path: p, value });
});

// Écriture générique GET-only:
// /json/set?token=...&doc=store&path=players.Hyroe.playMs&value=123
// /json/set?token=...&doc=store&path=players.Hyroe&valueJson={"playMs":123}
app.get("/json/set", async (req, res) => {
  const ip = clientIP(req);
  const last = lastSentByIP.get(ip) || 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) return res.status(429).json({ ok: false, error: "rate-limit" });

  if (WRITE_TOKEN) {
    const token = (req.query.token || "").toString().trim();
    if (token !== WRITE_TOKEN) return res.status(403).json({ ok: false, error: "invalid-token" });
  }

  const doc = (req.query.doc || "").toString().trim();
  const p   = (req.query.path || "").toString().trim();
  if (!p) return res.status(400).json({ ok: false, error: "path-required" });

  let value;
  if (typeof req.query.valueJson !== "undefined") {
    try { value = JSON.parse(req.query.valueJson.toString()); }
    catch { return res.status(400).json({ ok: false, error: "invalid-valueJson" }); }
  } else {
    value = (req.query.value || "").toString();
    // si c'est un nombre, convertir en Number pour éviter des strings non désirées
    if (/^-?\d+$/.test(value)) value = Number(value);
  }

  const { file, store } = readDoc(doc);
  try {
    setByPath(store, p, value);
    const message = `Update ${path.relative(process.cwd(), file)} (${p})`;
    await writeDoc(file, store, message);
    lastSentByIP.set(ip, now);
    return res.json({ ok: true, doc: doc || "default", path: p, value, timestamp: nowISO() });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "set-failed" });
  }
});

// Raccourcis Udon-friendly : éviter de construire path côté client

// GET total: /json/getTotal?doc=store&player=Hyroe
app.get("/json/getTotal", (req, res) => {
  const doc    = (req.query.doc || "").toString().trim();
  const player = (req.query.player || "").toString().trim();
  if (!player) return res.status(400).json({ ok: false, error: "player-required" });

  const { store } = readDoc(doc);
  const value = getByPath(store, `players.${player}.playMs`) || 0;
  setNoCache(res);
  return res.json({ ok: true, player, ms: Number(value) || 0 });
});

// SET total: /json/setTotal?token=...&doc=store&player=Hyroe&ms=1234567
app.get("/json/setTotal", async (req, res) => {
  if (WRITE_TOKEN) {
    const token = (req.query.token || "").toString().trim();
    if (token !== WRITE_TOKEN) return res.status(403).json({ ok: false, error: "invalid-token" });
  }
  const doc    = (req.query.doc || "").toString().trim();
  const player = (req.query.player || "").toString().trim();
  const ms     = Number((req.query.ms || "0").toString().trim());
  if (!player) return res.status(400).json({ ok: false, error: "player-required" });
  if (!Number.isFinite(ms) || ms < 0) return res.status(400).json({ ok: false, error: "invalid-ms" });

  const { file, store } = readDoc(doc);
  setByPath(store, `players.${player}.playMs`, ms);
  const message = `setTotal ${player}=${ms}`;
  await writeDoc(file, store, message);
  return res.json({ ok: true, player, ms });
});

// PULSE (incrément): /json/pulse?token=...&doc=store&player=Hyroe&addMs=60000
app.get("/json/pulse", async (req, res) => {
  if (WRITE_TOKEN) {
    const token = (req.query.token || "").toString().trim();
    if (token !== WRITE_TOKEN) return res.status(403).json({ ok: false, error: "invalid-token" });
  }
  const doc    = (req.query.doc || "").toString().trim();
  const player = (req.query.player || "").toString().trim();
  const addMs  = Number((req.query.addMs || "60000").toString().trim()); // défaut 60s
  if (!player) return res.status(400).json({ ok: false, error: "player-required" });
  if (!Number.isFinite(addMs) || addMs <= 0) return res.status(400).json({ ok: false, error: "invalid-addMs" });

  const { file, store } = readDoc(doc);
  const cur = Number(getByPath(store, `players.${player}.playMs`) || 0);
  const next = cur + addMs;
  setByPath(store, `players.${player}.playMs`, next);
  const message = `pulse ${player} += ${addMs} -> ${next}`;
  await writeDoc(file, store, message);
  return res.json({ ok: true, player, ms: next, added: addMs });
});

// Wildcard “not found” → toujours JSON (évite les 404 HTML)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not-found", path: req.path, query: req.query });
});
// Ping/pulse: enregistre simplement le temps total du joueur
app.get("/json/pulse", async (req, res) => {
  // Token optionnel
  const token = (req.query.token || "").toString().trim();
  if (process.env.JSON_WRITE_TOKEN && token !== process.env.JSON_WRITE_TOKEN) {
    return res.status(403).json({ ok: false, error: "invalid-token" });
  }

  const doc    = (req.query.doc || "store").toString().trim();          // défaut "store"
  const player = (req.query.player || "ClientSim").toString().trim();   // défaut "ClientSim"
  const addMs  = Number((req.query.addMs || "60000").toString().trim());// défaut 60s

  if (!Number.isFinite(addMs) || addMs <= 0) {
    return res.status(400).json({ ok: false, error: "invalid-addMs" });
  }

  const file  = fileForDoc(doc);
  const store = loadStore(file);
  const cur   = Number(getByPath(store, `players.${player}.playMs`) || 0);
  const next  = cur + addMs;

  setByPath(store, `players.${player}.playMs`, next);
  saveStoreSync(file, store);

  // (optionnel) commit GitHub si activé
  const github = await pushToGithub(file, `pulse ${player} += ${addMs} -> ${next}`);

  return res.json({ ok: true, doc, player, ms: next, added: addMs, github });
});


// =================== START ===================
app.listen(PORT, () => {
  console.log(`GlobalChat API listening on :${PORT}`);
  console.log(`Default JSON store: ${DEFAULT_JSON_STORE_FILE}`);
  if (WRITE_TOKEN) console.log("JSON write token enabled");
  if (GITHUB_TOKEN && GITHUB_REPO) {
    console.log(`GitHub push enabled=${GITHUB_PUSH_ENABLED} repo=${GITHUB_REPO} branch=${GITHUB_BRANCH}`);
  } else {
    console.log("GitHub push disabled (set GITHUB_TOKEN & GITHUB_REPO to enable)");
  }
});
