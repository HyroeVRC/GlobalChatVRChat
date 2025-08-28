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

// JSON store local
const JSON_STORE_FILE = process.env.JSON_STORE_FILE || path.join("data", "store.json");
// Auth facultative pour /json/set
const WRITE_TOKEN     = process.env.JSON_WRITE_TOKEN || "";

// Push GitHub (facultatif) — si GITHUB_TOKEN et GITHUB_REPO sont définis, on commit à chaque /json/set
// Exemple: GITHUB_REPO="Hyroe/vrchat-globalchat", GITHUB_FILE="data/store.json", GITHUB_BRANCH="main"
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO  = process.env.GITHUB_REPO  || "";
const GITHUB_FILE  = process.env.GITHUB_FILE  || "data/store.json";
const GITHUB_BRANCH= process.env.GITHUB_BRANCH|| "main";
// Mettre à "0" pour désactiver même si token présent
const GITHUB_PUSH_ENABLED = (process.env.GITHUB_PUSH_ENABLED ?? "1") !== "0";

// =================== APP ===================
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "32kb" }));
app.use(cors({ origin: true }));

function setNoCache(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

app.use(express.static("public", { setHeaders: setNoCache }));

// =================== ÉTAT EN MÉMOIRE ===================
let AUTO_ID = 0;
const MESSAGES = []; // { id, uuid, worldId, channel, username, text, timestamp }
const lastSentByIP = new Map();

const nowISO = () => new Date().toISOString();
const toIntOrDefault = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const clientIP = (req) =>
  (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) ||
  req.ip || req.socket.remoteAddress || "ip:unknown";

// =================== JSON STORE (local + helpers) ===================
function ensureDirFor(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadStore() {
  try {
    if (fs.existsSync(JSON_STORE_FILE)) {
      const raw = fs.readFileSync(JSON_STORE_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Store load error:", e);
  }
  return {}; // défaut vide
}
let STORE = loadStore();

let pendingSave = null;
function saveStoreDebounced() {
  if (pendingSave) return;
  pendingSave = setTimeout(() => {
    try {
      ensureDirFor(JSON_STORE_FILE);
      fs.writeFileSync(JSON_STORE_FILE, JSON.stringify(STORE, null, 2), "utf-8");
    } catch (e) { console.error("Store save error:", e); }
    pendingSave = null;
  }, 200);
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

// =================== GITHUB (commit de store.json) ===================
// Utilise l'API GitHub: https://docs.github.com/en/rest/repos/contents#update-or-create-file-contents
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

async function saveStoreToGithub(pathChanged) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_PUSH_ENABLED) return { skipped: true };

  try {
    // 1) Récupérer la SHA actuelle (si le fichier existe)
    const getUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_FILE)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const getRes = await githubFetchJson(getUrl, { method: "GET" });

    let sha = undefined;
    if (getRes.ok && getRes.json && getRes.json.sha) {
      sha = getRes.json.sha;
    } else if (getRes.status !== 404) {
      // Si autre erreur que "not found"
      console.warn("GitHub GET warning:", getRes.status, getRes.json?.message);
    }

    // 2) Contenu à pousser (base64)
    const newContentB64 = Buffer.from(JSON.stringify(STORE, null, 2)).toString("base64");

    // 3) PUT (create or update)
    const putUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_FILE)}`;
    const body = {
      message: `Update ${GITHUB_FILE} via /json/set (${pathChanged})`,
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

    return { ok: true, content: putRes.json?.content, commit: putRes.json?.commit };
  } catch (e) {
    console.error("GitHub push exception:", e);
    return { ok: false, error: String(e) };
  }
}

// =================== ROUTES ===================

// Santé
app.get("/", (_req, res) => {
  res.type("text/plain").send("GlobalChat backend OK");
});

// Envoi (GET-only pour compat Udon): /send?worldId=...&channel=global&username=Hyroe&text=Hello
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

// Poll incrémental (cursor since): /messages?since=0&limit=100&worldId=...&channel=global
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

// Flux fixe (lecture seule): /messages.json?limit=100[&worldId=...&channel=...]
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

// ===== JSON STORE: GET/SET (compatible VRCStringDownloader) =====

// Lecture: /json/get?path=worlds.myWorld.counter
app.get("/json/get", (req, res) => {
  const { path: p = "" } = req.query;
  const value = getByPath(STORE, p.toString().trim());
  setNoCache(res);
  return res.json({ ok: true, path: p || "", value });
});

// Écriture GET-only (URL-params):
// /json/set?path=worlds.myWorld.counter&value=42
// /json/set?path=players.Hyroe&valueJson={"score":12,"online":true}
// + sécurité optionnelle:
//   - ?token=SECRET
//   - ?worldId=... (contraint si ALLOWED_WORLD_IDS est renseigné)
app.get("/json/set", async (req, res) => {
  const ip = clientIP(req);
  const last = lastSentByIP.get(ip) || 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) return res.status(429).json({ ok: false, error: "rate-limit" });

  // Auth par token (facultatif mais recommandé)
  const token = (req.query.token || "").toString().trim();
  if (WRITE_TOKEN && token !== WRITE_TOKEN) {
    return res.status(403).json({ ok: false, error: "invalid-token" });
  }

  // Filtrage worldId (optionnel)
  let { worldId = "" } = req.query;
  worldId = (worldId || "").toString().trim();
  if (ALLOWED_WORLD_IDS.length && worldId && !ALLOWED_WORLD_IDS.includes(worldId)) {
    return res.status(403).json({ ok: false, error: "worldId-forbidden" });
  }

  // Données
  const p = (req.query.path || "").toString().trim();
  if (!p) return res.status(400).json({ ok: false, error: "path-required" });

  const hasValueJson = typeof req.query.valueJson !== "undefined";
  let value;
  if (hasValueJson) {
    try { value = JSON.parse(req.query.valueJson); }
    catch { return res.status(400).json({ ok: false, error: "invalid-valueJson" }); }
  } else {
    value = (req.query.value || "").toString();
  }

  try {
    setByPath(STORE, p, value);
    saveStoreDebounced();
    lastSentByIP.set(ip, now);

    // Push GitHub (optionnel)
    let github = { skipped: true };
    if (GITHUB_TOKEN && GITHUB_REPO && GITHUB_PUSH_ENABLED) {
      github = await saveStoreToGithub(p);
    }

    return res.json({
      ok: true,
      path: p,
      value,
      timestamp: nowISO(),
      github,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "set-failed" });
  }
});

// (facultatif) Incrément atomique: /json/inc?path=counter&by=1
app.get("/json/inc", async (req, res) => {
  const ip = clientIP(req);
  const last = lastSentByIP.get(ip) || 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) return res.status(429).json({ ok: false, error: "rate-limit" });

  const token = (req.query.token || "").toString().trim();
  if (WRITE_TOKEN && token !== WRITE_TOKEN) return res.status(403).json({ ok: false, error: "invalid-token" });

  let { worldId = "", path: p = "", by = "1" } = req.query;
  worldId = worldId.toString().trim();
  if (!p) return res.status(400).json({ ok: false, error: "path-required" });
  if (ALLOWED_WORLD_IDS.length && worldId && !ALLOWED_WORLD_IDS.includes(worldId))
    return res.status(403).json({ ok: false, error: "worldId-forbidden" });

  const delta = Number(by);
  if (!Number.isFinite(delta)) return res.status(400).json({ ok: false, error: "invalid-by" });

  const cur = Number(getByPath(STORE, p)) || 0;
  const val = cur + delta;

  try {
    setByPath(STORE, p, val);
    saveStoreDebounced();
    lastSentByIP.set(ip, now);

    let github = { skipped: true };
    if (GITHUB_TOKEN && GITHUB_REPO && GITHUB_PUSH_ENABLED) {
      github = await saveStoreToGithub(p);
    }

    return res.json({ ok: true, path: p, value: val, timestamp: nowISO(), github });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "inc-failed" });
  }
});

// =================== START ===================
app.listen(PORT, () => {
  console.log(`GlobalChat API listening on :${PORT}`);
  console.log(`JSON store file: ${JSON_STORE_FILE}`);
  if (WRITE_TOKEN) console.log("JSON write token enabled");
  if (GITHUB_TOKEN && GITHUB_REPO) {
    console.log(`GitHub push enabled=${GITHUB_PUSH_ENABLED} repo=${GITHUB_REPO} file=${GITHUB_FILE} branch=${GITHUB_BRANCH}`);
  } else {
    console.log("GitHub push disabled (set GITHUB_TOKEN & GITHUB_REPO to enable)");
  }
});
