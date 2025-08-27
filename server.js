// server.js
// Minimal backend pour chat global inter-instances VRChat (GET-only).
// Dépendances: express, cors  ->  npm i express cors

const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");

// ---------- Config ----------
const PORT = process.env.PORT || 8080;

// Liste de worldIds autorisés (CSV). Vide = tout autoriser.
const ALLOWED_WORLD_IDS = (process.env.ALLOWED_WORLD_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MAX_LEN = parseInt(process.env.MAX_LEN || "200", 10);     // longueur max d'un message
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || "2000", 10); // 1 msg / 2s par IP
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_LIMIT || "100", 10); // nombre max de msgs renvoyés

// ---------- App ----------
const app = express();
app.set("trust proxy", true); // pour récupérer l'IP réelle derrière un proxy
app.use(express.json({ limit: "32kb" }));
app.use(cors({ origin: true }));

// No-cache headers pour les flux JSON
function setNoCache(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

// ---------- Stockage (mémoire) ----------
// ⚠️ En prod, remplacez par une DB (SQLite/Postgres). La mémoire est éphémère (Railway/Render).
let AUTO_ID = 0;
const MESSAGES = []; // { id, uuid, worldId, channel, username, text, timestamp }

// Anti-spam simple par IP
const lastSentByIP = new Map();

// Utils
function nowISO() { return new Date().toISOString(); }
function toIntOrDefault(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function clientIP(req) {
  return (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim())
    || req.ip || req.socket.remoteAddress || "ip:unknown";
}

// ---------- Routes ----------

// Santé
app.get("/", (_req, res) => {
  res.type("text/plain").send("GlobalChat backend OK");
});

// Ajout d’un message (GET-only pour compat Udon):
// /send?worldId=...&channel=global&username=Hyroe&text=Hello%20world
app.get("/send", (req, res) => {
  const ip = clientIP(req);
  const last = lastSentByIP.get(ip) || 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: "rate-limit" });
  }

  let { worldId, channel = "global", username = "Guest", text = "" } = req.query;
  worldId = (worldId || "").toString().trim();
  channel = (channel || "global").toString().trim();
  username = (username || "Guest").toString().trim();
  text = (text || "").toString();

  if (!worldId) return res.status(400).json({ ok: false, error: "worldId-required" });
  if (ALLOWED_WORLD_IDS.length && !ALLOWED_WORLD_IDS.includes(worldId)) {
    return res.status(403).json({ ok: false, error: "worldId-forbidden" });
  }

  const trimmed = text.trim();
  if (!trimmed) return res.status(400).json({ ok: false, error: "empty" });
  if (trimmed.length > MAX_LEN) return res.status(400).json({ ok: false, error: "too-long" });

  const msg = {
    id: ++AUTO_ID,            // entier croissant (sert de curseur 'since')
    uuid: randomUUID(),       // facultatif, utile en logs
    worldId,
    channel,
    username: username.slice(0, 24),
    text: trimmed,
    timestamp: nowISO()
  };

  MESSAGES.push(msg);
  lastSentByIP.set(ip, now);
  return res.json({ ok: true, id: msg.id, timestamp: msg.timestamp });
});

// Poll incrémental des messages (filtrable par worldId/channel):
// /messages?since=123&limit=100&worldId=...&channel=global
app.get("/messages", (req, res) => {
  let { worldId = "", channel = "", since = "0", limit } = req.query;
  worldId = worldId.toString().trim();
  channel = channel.toString().trim();
  const sinceId = toIntOrDefault(since, 0);
  const lim = Math.max(1, Math.min(200, toIntOrDefault(limit, DEFAULT_LIMIT)));

  let out = MESSAGES;

  if (ALLOWED_WORLD_IDS.length && worldId) {
    out = out.filter(m => m.worldId === worldId);
  }
  if (channel) {
    out = out.filter(m => m.channel === channel);
  }

  out = out.filter(m => m.id > sinceId).sort((a, b) => a.id - b.id);

  const slice = out.slice(0, lim);
  const cursor = slice.length ? String(slice[slice.length - 1].id) : String(sinceId);

  setNoCache(res);
  return res.json({
    cursor,
    messages: slice.map(m => ({
      id: m.id,
      worldId: m.worldId,
      channel: m.channel,
      username: m.username,
      text: m.text,
      timestamp: m.timestamp
    }))
  });
});

// Flux fixe (idéal pour un VRCUrl constant en lecture seule):
// /messages.json?limit=100   (optionnel: &worldId=...&channel=...)
app.get("/messages.json", (req, res) => {
  let { worldId = "", channel = "", limit } = req.query;
  worldId = worldId.toString().trim();
  channel = channel.toString().trim();
  const lim = Math.max(1, Math.min(200, toIntOrDefault(limit, DEFAULT_LIMIT)));

  let out = MESSAGES;
  if (ALLOWED_WORLD_IDS.length && worldId) {
    out = out.filter(m => m.worldId === worldId);
  }
  if (channel) {
    out = out.filter(m => m.channel === channel);
  }

  const slice = out.slice(-lim); // N derniers
  setNoCache(res);
  return res.json({
    messages: slice.map(m => ({
      username: m.username,
      text: m.text,
      timestamp: m.timestamp
    }))
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`GlobalChat API listening on :${PORT}`);
});
