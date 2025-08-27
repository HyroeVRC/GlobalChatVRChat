// server.js (ESM)
// Dépendances: npm i express cors
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";

// --------- Config ---------
const PORT = process.env.PORT || 8080;

// CSV de worldIds autorisés. Laisser vide => tout autoriser.
const ALLOWED_WORLD_IDS = (process.env.ALLOWED_WORLD_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_LEN       = parseInt(process.env.MAX_LEN       || "200", 10);  // len max d'un message
const COOLDOWN_MS   = parseInt(process.env.COOLDOWN_MS   || "2000", 10); // 1 msg / 2s par IP
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_LIMIT || "100", 10);  // taille page

// --------- App ---------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "32kb" }));
app.use(cors({ origin: true }));

// No-cache utilitaire
function setNoCache(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

// Servir /public (optionnel : pour send.html)
app.use(
  express.static("public", {
    setHeaders: setNoCache,
  })
);

// --------- Stockage (mémoire) ---------
// ⚠️ Remplacez par une DB si besoin de persistance.
let AUTO_ID = 0;
const MESSAGES = []; // { id, uuid, worldId, channel, username, text, timestamp }
const lastSentByIP = new Map(); // anti-spam par IP

const nowISO = () => new Date().toISOString();
const toIntOrDefault = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const clientIP = (req) =>
  (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) ||
  req.ip ||
  req.socket.remoteAddress ||
  "ip:unknown";

// --------- Routes ---------

// Santé
app.get("/", (_req, res) => {
  res.type("text/plain").send("GlobalChat backend OK");
});

// Envoi (GET-only pour compat Udon):
// /send?worldId=...&channel=global&username=Hyroe&text=Hello%20world
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

// Poll incrémental (cursor since):
// /messages?since=0&limit=100&worldId=...&channel=global
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
      id: m.id,
      worldId: m.worldId,
      channel: m.channel,
      username: m.username,
      text: m.text,
      timestamp: m.timestamp,
    })),
  });
});

// Flux fixe pour VRCUrl constant (lecture seule):
// /messages.json?limit=100[&worldId=...&channel=...]
app.get("/messages.json", (req, res) => {
  let { worldId = "", channel = "", limit } = req.query;
  worldId = worldId.toString().trim();
  channel = channel.toString().trim();
  const lim = Math.max(1, Math.min(200, toIntOrDefault(limit, DEFAULT_LIMIT)));

  let out = MESSAGES;
  if (ALLOWED_WORLD_IDS.length && worldId) out = out.filter((m) => m.worldId === worldId);
  if (channel) out = out.filter((m) => m.channel === channel);

  const slice = out.slice(-lim); // N derniers
  setNoCache(res);
  return res.json({
    messages: slice.map((m) => ({
      username: m.username,
      text: m.text,
      timestamp: m.timestamp,
    })),
  });
});

// --------- Start ---------
app.listen(PORT, () => {
  console.log(`GlobalChat API listening on :${PORT}`);
});
