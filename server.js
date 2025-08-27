// server.js
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(cors({ origin: true })); // en prod, restreignez !

const MESSAGES = []; // remplacez par une DB (SQLite/Postgres)

const WORLD_OK = new Set(["wrld_xxx"]);
const MAX_LEN = 200;

app.post("/messages", (req, res) => {
  const { worldId, channel="global", username="Guest", text } = req.body || {};
  if (!WORLD_OK.has(worldId || "")) return res.status(400).json({ error: "bad worldId" });
  if (!text || typeof text !== "string") return res.status(400).json({ error: "no text" });
  const trimmed = (""+text).trim();
  if (!trimmed || trimmed.length > MAX_LEN) return res.status(400).json({ error: "len" });

  // TODO: anti-spam par IP, filtre mots, etc.
  const now = new Date().toISOString();
  const msg = {
    id: randomUUID(),
    worldId,
    channel,
    username: (""+username).slice(0, 24),
    text: trimmed,
    timestamp: now
  };
  MESSAGES.push(msg);
  res.status(201).json({ ok: true, id: msg.id, timestamp: now });
});

app.get("/messages", (req, res) => {
  const { since, limit="100" } = req.query;
  let out = MESSAGES;
  if (since) {
    const idx = MESSAGES.findIndex(m => m.timestamp > since);
    out = idx < 0 ? [] : MESSAGES.filter(m => m.timestamp > since);
  }
  const lim = Math.max(1, Math.min(200, parseInt(limit)));
  const slice = out.slice(0, lim);
  const cursor = slice.length ? slice[slice.length-1].timestamp : (since || new Date().toISOString());
  res.json({ cursor, messages: slice });
});

app.listen(8080, () => console.log("GlobalChat API on :8080"));
