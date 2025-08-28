// server.js (ESM)
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
// ==== JSON STORE (ajouts)
import fs from "fs";
import path from "path";

// --------- Config ---------
const PORT = process.env.PORT || 8080;

// CSV de worldIds autorisés. Laisser vide => tout autoriser.
const ALLOWED_WORLD_IDS = (process.env.ALLOWED_WORLD_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_LEN       = parseInt(process.env.MAX_LEN       || "200", 10);
const COOLDOWN_MS   = parseInt(process.env.COOLDOWN_MS   || "2000", 10);
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_LIMIT || "100", 10);

// ==== JSON STORE (config de sécurité)
const JSON_STORE_FILE = process.env.JSON_STORE_FILE || path.join("data", "store.json");
const WRITE_TOKEN     = process.env.JSON_WRITE_TOKEN || ""; // si vide => pas d’auth (déconseillé)

// --------- App ---------
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

// --------- Stockage (mémoire) ---------
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

// ==== JSON STORE (helpers)
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
  } catch (e) { console.error("Store load error:", e); }
  return {}; // défaut
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
  }, 200); // petit debounce
}

// Accès par chemin "a.b.c"
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

// --------- Routes ---------
app.get("/", (_req, res) => {
  res.type("text/plain").send("GlobalChat backend OK");
});

// Envoi (GET-only pour compat Udon)
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

// Poll incrémental
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

// Flux fixe (lecture seule)
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

// ==== JSON STORE: GET/SET depuis VRChat ============================

// Lecture: /json/get?path=worlds.myWorld.counter
app.get("/json/get", (req, res) => {
  const { path: p = "" } = req.query;
  const value = getByPath(STORE, p.toString().trim());
  setNoCache(res);
  return res.json({ ok: true, path: p || "", value });
});

// Écriture GET-only :
// /json/set?path=worlds.myWorld.counter&value=42
// /json/set?path=players.Hyroe&valueJson={"score":12,"online":true}
// + sécurité optionnelle:
//   - ?token=SECRET
//   - ?worldId=... (contrainte sur ALLOWED_WORLD_IDS si renseigné)
app.get("/json/set", (req, res) => {
  // Anti-spam simple par IP (réutilise le cooldown global)
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

  // value ou valueJson
  const hasValueJson = typeof req.query.valueJson !== "undefined";
  let value;
  if (hasValueJson) {
    try { value = JSON.parse(req.query.valueJson); }
    catch { return res.status(400).json({ ok: false, error: "invalid-valueJson" }); }
  } else {
    // valeur texte brute
    value = (req.query.value || "").toString();
  }

  try {
    setByPath(STORE, p, value);
    saveStoreDebounced();
    lastSentByIP.set(ip, now);
    return res.json({ ok: true, path: p, value, timestamp: nowISO() });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "set-failed" });
  }
});

// --------- Start ---------
app.listen(PORT, () => {
  console.log(`GlobalChat API listening on :${PORT}`);
  console.log(`JSON store file: ${JSON_STORE_FILE}`);
  if (WRITE_TOKEN) console.log("JSON write token enabled");
});
