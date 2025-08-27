import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";

// --- Config ---
// Mettez ici les worldId autorisés (ou laissez vide pour autoriser tous les mondes).
const ALLOWED_WORLD_IDS = new Set([
  "wrld_c2b1a096-9f2b-474c-afb7-fece2e1ecdfa" // <- votre monde
]);

// Limites
const MAX_LEN = 200;          // longueur max d'un message
const COOLDOWN_MS = 2000;     // 1 msg / 2s par IP
const DEFAULT_LIMIT = 100;    // nombre max de msgs par GET

const app = express();
app.use(express.json({ limit: "32kb" }));

// En prod, restreignez CORS à votre domaine si vous avez un proxy
app.use(cors({ origin: true }));

// --- In-memory storage (remplacez par DB si besoin) ---
let AUTO_ID = 0;
const MESSAGES = []; // { id:number, worldId, channel, username, text, timestamp, uuid }

// Anti-spam simple par IP
const lastSentByIP = new Map();

// Helpers
function nowISO() {
  return new Date().toISOString();
}
function toIntOrDefault(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

// --- Routes ---

// Envoi d'un message via GET (compatible VRCStringDownloader)
// /send?worldId=...&channel=global&username=Hyroe&text=Hello
app.get("/send", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.socket.remoteAddress || "ip:unknown";

  // Cooldown anti-spam simple
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
  if (ALLOWED_WORLD_IDS.size && !ALLOWED_WORLD_IDS.has(worldId))
    return res.status(403).json({ ok: false, error: "worldId-forbidden" });

  const trimmed = text.trim();
  if (!trimmed) return res.status(400).json({ ok: false, error: "empty" });
  if (trimmed.length > MAX_LEN) return res.status(400).json({ ok: false, error: "too-long" });

  const msg = {
    id: ++AUTO_ID,              // entier croissant -> idéal pour cursor "since"
    uuid: randomUUID(),         // facultatif
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

// Récupération des messages
// /messages?worldId=...&channel=global&since=123&limit=100
app.get("/messages", (req, res) => {
  let { worldId, channel, since, limit } = req.query;
  worldId = (worldId || "").toString().trim();
  channel = (channel || "").toString().trim();
  const sinceId = toIntOrDefault(since, 0);
  const lim = Math.max(1, Math.min(200, toIntOrDefault(limit, DEFAULT_LIMIT)));

  let out = MESSAGES;

  if (ALLOWED_WORLD_IDS.size && worldId) {
    out = out.filter(m => m.worldId === worldId);
  }
  if (channel) {
    out = out.filter(m => m.channel === channel);
  }

  // messages strictement après 'since'
  out = out.filter(m => m.id > sinceId);

  // Ordonner par id asc (par sécurité)
  out = out.sort((a, b) => a.id - b.id);

  // Limiter
  const slice = out.slice(0, lim);

  // Nouveau curseur = dernier id renvoyé (ou since si vide)
  const cursor = slice.length ? String(slice[slice.length - 1].id) : String(sinceId);

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

// Santé
app.get("/", (_req, res) => res.type("text/plain").send("GlobalChat backend OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("GlobalChat API listening on :" + PORT);
});
