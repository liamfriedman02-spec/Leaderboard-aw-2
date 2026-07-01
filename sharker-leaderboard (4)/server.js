// Sharker — Live Launch Leaderboard
// Node 22+ (uses built-in node:sqlite). Run: npm start
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const PORT = process.env.PORT || 3000;
// Key required to reach the admin page/actions. CHANGE THIS in production.
const ADMIN_KEY = process.env.ADMIN_KEY || "sharker-admin";
// Optional: if set, POST /api/launch requires header  x-launch-key: <value>
const LAUNCH_KEY = process.env.LAUNCH_KEY || null;

if (ADMIN_KEY === "sharker-admin") {
  console.warn("⚠  Using the default ADMIN_KEY 'sharker-admin'. Set ADMIN_KEY before going live.");
}

// ---------- optional confirmation email ----------
// Configure SMTP env vars to enable. If unset, submissions still work; no email is sent.
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  try {
    const nodemailer = (await import("nodemailer")).default;
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log("✉  Confirmation email enabled");
  } catch (e) {
    console.warn("Confirmation email disabled (nodemailer not available):", e.message);
  }
} else {
  console.log("✉  Confirmation email off (set SMTP_* env vars to enable)");
}
async function sendConfirmation(to, casinoName) {
  if (!mailer || !to) return;
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject: "You're entered in the Sharker iPad giveaway",
      text: `Thanks for entering "${casinoName}" into the Sharker launch leaderboard.\n\n`
        + `Your entry is pending review. Once approved, it appears on the live board and is entered into the iPad giveaway.\n\n— Sharker`,
    });
  } catch (e) {
    console.error("Confirmation email failed:", e.message);
  }
}

// ---------- database ----------
const DB_FILE = process.env.DB_PATH || join(__dirname, "sharker.db");
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS launches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_name TEXT NOT NULL,
    owner_name    TEXT,
    country       TEXT,
    email         TEXT,
    wallet        TEXT,
    platform_url  TEXT,
    launch_time   TEXT,
    created_at    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'Entered'
  );
  CREATE TABLE IF NOT EXISTS winners (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    launch_id  INTEGER NOT NULL,
    drawn_at   TEXT NOT NULL
  );
`);

const q = {
  insert: db.prepare(`INSERT INTO launches
    (platform_name, owner_name, country, email, wallet, platform_url, launch_time, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Entered')`),
  insertPending: db.prepare(`INSERT INTO launches
    (platform_name, owner_name, country, email, wallet, platform_url, launch_time, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`),
  byId: db.prepare(`SELECT * FROM launches WHERE id = ?`),
  allNewest: db.prepare(`SELECT * FROM launches ORDER BY datetime(created_at) DESC, id DESC`),
  approvedNewest: db.prepare(`SELECT * FROM launches WHERE status = 'Entered' ORDER BY datetime(created_at) DESC, id DESC`),
  pendingNewest: db.prepare(`SELECT * FROM launches WHERE status = 'Pending' ORDER BY datetime(created_at) DESC, id DESC`),
  setStatusTime: db.prepare(`UPDATE launches SET status = ?, created_at = ? WHERE id = ?`),
  setStatus: db.prepare(`UPDATE launches SET status = ? WHERE id = ?`),
  del: db.prepare(`DELETE FROM launches WHERE id = ?`),
  count: db.prepare(`SELECT COUNT(*) AS n FROM launches`),
  countApproved: db.prepare(`SELECT COUNT(*) AS n FROM launches WHERE status = 'Entered'`),
  countPending: db.prepare(`SELECT COUNT(*) AS n FROM launches WHERE status = 'Pending'`),
  approvedIds: db.prepare(`SELECT id FROM launches WHERE status = 'Entered'`),
  addWinner: db.prepare(`INSERT INTO winners (launch_id, drawn_at) VALUES (?, ?)`),
  latestWinner: db.prepare(`SELECT w.drawn_at, l.* FROM winners w
    JOIN launches l ON l.id = w.launch_id ORDER BY w.id DESC LIMIT 1`),
};

// public view: never expose email / wallet on the public board
const toPublic = (r) => r && ({
  id: r.id,
  platformName: r.platform_name,
  ownerName: r.owner_name,
  country: r.country,
  platformUrl: r.platform_url,
  launchTime: r.launch_time,
  createdAt: r.created_at,
  status: r.status,
});
// admin view: full record
const toAdmin = (r) => r && ({
  ...toPublic(r),
  email: r.email,
  wallet: r.wallet,
});

// ---------- app ----------
const app = express();
app.use(express.json());

// CORS so sharker.com can POST from another origin
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-admin-key, x-launch-key");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- SSE (instant, no-refresh updates) ----------
const clients = new Set();
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch {} }
}

// ---------- admin auth ----------
function requireAdmin(req, res, next) {
  if (req.header("x-admin-key") !== ADMIN_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ---------- public reads ----------
app.get("/api/launches", (req, res) => {
  const rows = q.approvedNewest.all().map(toPublic); // only approved show publicly
  res.json({ total: rows.length, launches: rows });
});

app.get("/api/winner", (req, res) => {
  const w = q.latestWinner.get();
  res.json({ winner: w ? { ...toPublic(w), drawnAt: w.drawn_at } : null });
});

// ---------- THE endpoint your website calls ----------
// POST /api/launch  -> creates a launch, pushes it live to every board
app.post("/api/launch", (req, res) => {
  if (LAUNCH_KEY && req.header("x-launch-key") !== LAUNCH_KEY)
    return res.status(401).json({ error: "Unauthorized" });

  const b = req.body || {};
  const platformName = (b.platformName || "").toString().trim();
  if (!platformName) return res.status(400).json({ error: "platformName is required" });

  const now = new Date().toISOString();
  const info = q.insert.run(
    platformName,
    (b.ownerName || "").toString().trim() || null,
    (b.country || "").toString().trim() || null,
    (b.email || "").toString().trim() || null,
    (b.wallet || "").toString().trim() || null,
    (b.platformUrl || "").toString().trim() || null,
    (b.launchTime || now).toString(),
    now
  );
  const row = q.byId.get(info.lastInsertRowid);
  broadcast("launch", toPublic(row));   // live to public boards
  res.status(201).json({ ok: true, launch: toAdmin(row) });
});

// Supabase Database Webhook receiver.
// Point a Supabase "Database Webhook" (INSERT on your platforms table) here.
// It maps the inserted row's columns to a launch and pushes it live.
function pick(rec, keys) {
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}
app.post("/api/hook/supabase", (req, res) => {
  if (LAUNCH_KEY && req.header("x-launch-key") !== LAUNCH_KEY)
    return res.status(401).json({ error: "Unauthorized" });

  const body = req.body || {};
  // only act on new rows; ignore updates/deletes
  if (body.type && body.type !== "INSERT") return res.json({ ok: true, skipped: body.type });

  const rec = body.record || body; // Supabase sends { type, table, record }
  const platformName = pick(rec, ["platform_name","platformName","name","casino_name","casinoName","title","brand","subdomain"]);
  if (!platformName) {
    return res.status(400).json({
      error: "Could not find a platform name in the row",
      seen_columns: Object.keys(rec), // tells you which column to map
    });
  }
  const now = new Date().toISOString();
  const info = q.insert.run(
    platformName,
    pick(rec, ["owner_name","ownerName","owner","full_name","fullName","username","user_name"]),
    pick(rec, ["country","country_code","countryCode"]),
    pick(rec, ["email","owner_email","user_email"]),
    pick(rec, ["wallet","wallet_address","walletAddress","address"]),
    pick(rec, ["platform_url","platformUrl","url","domain","site_url","link"]),
    pick(rec, ["launch_time","created_at","createdAt","inserted_at"]) || now,
    now
  );
  const row = q.byId.get(info.lastInsertRowid);
  broadcast("launch", toPublic(row));
  res.status(201).json({ ok: true, launch: toPublic(row) });
});

// ---------- public: Enter the Lottery form ----------
// Creates a PENDING entry (not shown on the board until an admin approves it).
app.post("/api/enter", async (req, res) => {
  const b = req.body || {};
  const casinoName = (b.casinoName || b.platformName || "").toString().trim();
  const domain = (b.domain || b.platformUrl || "").toString().trim();
  const name = (b.name || b.ownerName || "").toString().trim();
  const email = (b.email || "").toString().trim();
  const country = (b.country || "").toString().trim();

  if (!casinoName) return res.status(400).json({ error: "Casino name is required" });
  if (!domain) return res.status(400).json({ error: "White-label domain is required" });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: "A valid email is required" });

  const now = new Date().toISOString();
  const info = q.insertPending.run(
    casinoName, name || null, country || null, email, null, domain, now, now
  );
  const row = q.byId.get(info.lastInsertRowid);
  broadcast("pending", { id: row.id }); // lets the admin panel update its pending count live
  sendConfirmation(email, casinoName);  // fire-and-forget; no-op if SMTP not configured
  res.status(201).json({ ok: true, status: "Pending" });
});

app.get("/api/admin/launches", requireAdmin, (req, res) => {
  res.json({ total: q.count.get().n, launches: q.allNewest.all().map(toAdmin) });
});

app.put("/api/launch/:id", requireAdmin, (req, res) => {
  const row = q.byId.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  const val = (k, cur) => (b[k] === undefined ? cur : (b[k] === null ? null : String(b[k])));
  const updated = {
    platform_name: b.platformName === undefined ? row.platform_name : String(b.platformName).trim(),
    owner_name: val("ownerName", row.owner_name),
    country: val("country", row.country),
    email: val("email", row.email),
    wallet: val("wallet", row.wallet),
    platform_url: val("platformUrl", row.platform_url),
    launch_time: val("launchTime", row.launch_time),
    status: b.status === undefined ? row.status : String(b.status),
  };
  db.prepare(`UPDATE launches SET
      platform_name=?, owner_name=?, country=?, email=?, wallet=?, platform_url=?, launch_time=?, status=?
      WHERE id=?`).run(
    updated.platform_name, updated.owner_name, updated.country, updated.email,
    updated.wallet, updated.platform_url, updated.launch_time, updated.status, row.id
  );
  const fresh = q.byId.get(row.id);
  broadcast("update", toPublic(fresh));
  res.json({ ok: true, launch: toAdmin(fresh) });
});

app.delete("/api/launch/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!q.byId.get(id)) return res.status(404).json({ error: "Not found" });
  q.del.run(id);
  broadcast("delete", { id });
  res.json({ ok: true, id });
});

// approve a pending entry -> it goes live on the public board
app.post("/api/launch/:id/approve", requireAdmin, (req, res) => {
  const row = q.byId.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found" });
  const now = new Date().toISOString();
  q.setStatusTime.run("Entered", now, row.id); // bump created_at so it appears as newest
  const fresh = q.byId.get(row.id);
  broadcast("launch", toPublic(fresh)); // push live to the public board
  res.json({ ok: true, launch: toAdmin(fresh) });
});

// reject a pending entry -> stays hidden from the board
app.post("/api/launch/:id/reject", requireAdmin, (req, res) => {
  const row = q.byId.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found" });
  q.setStatus.run("Rejected", row.id);
  res.json({ ok: true, id: row.id, status: "Rejected" });
});

// randomly pick one winner from APPROVED entries only
app.post("/api/draw", requireAdmin, (req, res) => {
  const ids = q.approvedIds.all();
  if (!ids.length) return res.status(400).json({ error: "No approved entries to draw from" });
  const winnerId = ids[randomInt(ids.length)].id;
  const now = new Date().toISOString();
  q.addWinner.run(winnerId, now);
  const row = q.byId.get(winnerId);
  const publicWinner = { ...toPublic(row), drawnAt: now };
  broadcast("winner", publicWinner);
  res.json({ ok: true, winner: toAdmin(row) });
});

// export everyone who launched, as CSV (admin only — includes email/wallet)
app.get("/api/export.csv", requireAdmin, (req, res) => {
  const cols = ["id","platform_name","owner_name","country","email","wallet","platform_url","launch_time","created_at","status"];
  const header = ["id","platformName","ownerName","country","email","wallet","platformUrl","launchTime","createdAt","status"];
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(",")];
  for (const r of q.allNewest.all()) lines.push(cols.map((c) => cell(r[c])).join(","));
  const stamp = new Date().toISOString().slice(0, 10);
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="sharker-launches-${stamp}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n")); // BOM so Excel reads UTF-8 correctly
});

// ---------- static frontend ----------
app.use(express.static(join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(join(__dirname, "public", "admin.html")));

app.listen(PORT, () => {
  console.log(`\n🦈 Sharker leaderboard running`);
  console.log(`   Public board : http://localhost:${PORT}/`);
  console.log(`   Admin panel  : http://localhost:${PORT}/admin  (key: ${ADMIN_KEY})`);
  console.log(`   Launch API   : POST http://localhost:${PORT}/api/launch\n`);
});
