import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, createInkressOrder, getInkressOrder, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[promo-codes] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("promo_codes", `
  CREATE TABLE IF NOT EXISTS codes (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, code TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'percent', value NUMERIC NOT NULL, min_spend NUMERIC NOT NULL DEFAULT 0,
    max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, expires_on DATE, active BOOLEAN NOT NULL DEFAULT true,
    currency TEXT NOT NULL DEFAULT 'JMD', created_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, code)
  );
  ALTER TABLE codes ADD COLUMN IF NOT EXISTS start_on DATE;
  ALTER TABLE codes ADD COLUMN IF NOT EXISTS once_per_customer BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE codes ADD COLUMN IF NOT EXISTS scope_note TEXT;
  ALTER TABLE codes ADD COLUMN IF NOT EXISTS token TEXT;
  ALTER TABLE codes ADD COLUMN IF NOT EXISTS batch_id TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_codes_token ON codes (token) WHERE token IS NOT NULL;
  CREATE TABLE IF NOT EXISTS redemptions (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, code TEXT NOT NULL,
    original NUMERIC NOT NULL, discount NUMERIC NOT NULL, net NUMERIC NOT NULL, currency TEXT NOT NULL,
    customer TEXT, ref TEXT, inkress_order_id TEXT, payment_url TEXT, state TEXT NOT NULL DEFAULT 'awaiting',
    created_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS customer_email TEXT;
  ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS code_id BIGINT;
  ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_codes_merchant ON codes (merchant_id, id);
  CREATE INDEX IF NOT EXISTS idx_redemptions_merchant ON redemptions (merchant_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("promo_codes", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const cleanCode = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
const token = () => crypto.randomBytes(7).toString("base64url");
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;

function codeState(c) {
  if (!c.active) return "paused";
  if (c.start_on && c.start_on > today()) return "scheduled";
  if (c.expires_on && c.expires_on < today()) return "expired";
  if (c.max_uses != null && c.used_count >= c.max_uses) return "used_up";
  return "active";
}
function discountFor(code, amount) {
  const st = codeState(code);
  if (st === "paused") return { ok: false, reason: "inactive" };
  if (st === "scheduled") return { ok: false, reason: "scheduled" };
  if (st === "expired") return { ok: false, reason: "expired" };
  if (st === "used_up") return { ok: false, reason: "used_up" };
  if (amount < Number(code.min_spend)) return { ok: false, reason: "min_spend", min_spend: Number(code.min_spend) };
  const discount = code.kind === "percent" ? round2(amount * Number(code.value) / 100) : Math.min(round2(Number(code.value)), amount);
  return { ok: true, discount, net: round2(amount - discount) };
}

const serializeCode = (c, req) => ({ id: c.id, code: c.code, kind: c.kind, value: Number(c.value), min_spend: Number(c.min_spend), max_uses: c.max_uses, used_count: c.used_count,
  expires_on: c.expires_on, start_on: c.start_on, once_per_customer: !!c.once_per_customer, scope_note: c.scope_note, active: c.active, currency: c.currency,
  state: codeState(c), share_url: c.token ? `${PUBLIC_BASE(req)}/code/${c.token}` : null });
const serializeRed = (r) => ({ id: r.id, code: r.code, original: Number(r.original), discount: Number(r.discount), net: Number(r.net), currency: r.currency, customer: r.customer, customer_email: r.customer_email, payment_url: r.payment_url, inkress_order_id: r.inkress_order_id, state: r.state, created_at: r.created_at, paid_at: r.paid_at });

// ---- Codes -----------------------------------------------------------------
app.get("/api/codes", core.requireSession, async (req, res) => {
  const codes = await db.q(`SELECT * FROM codes WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  const reds = await db.q(`SELECT code, discount, net, state FROM redemptions WHERE merchant_id=$1`, [req.session.merchantId]);
  const paid = reds.filter((r) => r.state === "paid");
  res.json({
    codes: codes.map((c) => serializeCode(c, req)),
    connected: await tokens.hasToken(req.session.merchantId), webhook_realtime: Boolean(WEBHOOK_SECRET),
    stats: {
      active: codes.filter((c) => codeState(c) === "active").length,
      redemptions: reds.length,
      paid: paid.length,
      discount_given: round2(paid.reduce((s, r) => s + Number(r.discount), 0)),
      revenue_driven: round2(paid.reduce((s, r) => s + Number(r.net), 0)),
      redemption_rate: reds.length ? Math.round((paid.length / reds.length) * 100) : 0,
    },
  });
});

async function insertCode(merchantId, currency, actor, b) {
  const code = cleanCode(b.code);
  const kind = b.kind === "fixed" ? "fixed" : "percent";
  const value = round2(b.value);
  return db.one(`INSERT INTO codes (merchant_id, code, kind, value, min_spend, max_uses, start_on, expires_on, once_per_customer, scope_note, currency, created_by_name, token, batch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [merchantId, code, kind, value, round2(b.min_spend), b.max_uses ? Number(b.max_uses) : null,
      /^\d{4}-\d{2}-\d{2}$/.test(b.start_on) ? b.start_on : null, /^\d{4}-\d{2}-\d{2}$/.test(b.expires_on) ? b.expires_on : null,
      !!b.once_per_customer, String(b.scope_note || "").slice(0, 120) || null, currency, actor || null, token(), b.batch_id || null]);
}

app.post("/api/codes", core.requireSession, async (req, res) => {
  const b = req.body || {};
  if (!cleanCode(b.code)) return res.status(400).json({ error: "no_code", message: "Enter a code." });
  if (!(round2(b.value) > 0)) return res.status(400).json({ error: "bad_value", message: "Enter a discount value." });
  try {
    const row = await insertCode(req.session.merchantId, req.session.data?.merchant?.currency_code || "JMD", req.actor?.name, b);
    res.status(201).json({ code: serializeCode(row, req) });
  } catch (err) {
    if (String(err.message).includes("uq") || String(err.code) === "23505") return res.status(409).json({ error: "duplicate", message: "That code already exists." });
    throw err;
  }
});

// Bulk generator — N random codes sharing the same terms (campaign batch)
app.post("/api/codes/bulk", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const count = Math.max(1, Math.min(200, Number(b.count) || 1));
  if (!(round2(b.value) > 0)) return res.status(400).json({ error: "bad_value", message: "Enter a discount value." });
  const prefix = cleanCode(b.prefix || "SAVE").slice(0, 12);
  const currency = req.session.data?.merchant?.currency_code || "JMD";
  const batchId = `batch-${Date.now().toString(36)}`;
  const created = [];
  for (let i = 0; i < count; i++) {
    const code = `${prefix}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    try { const row = await insertCode(req.session.merchantId, currency, req.actor?.name, { ...b, code, batch_id: batchId }); created.push(serializeCode(row, req)); }
    catch { /* skip dup */ }
  }
  res.status(201).json({ created: created.length, batch_id: batchId, codes: created });
});

app.patch("/api/codes/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const row = await db.one(`SELECT * FROM codes WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!row) return res.status(404).json({ error: "not_found" });
  const newCode = b.code !== undefined ? cleanCode(b.code) : row.code;
  try {
    const u = await db.one(`UPDATE codes SET code=$1, kind=$2, active=$3, value=$4, min_spend=$5, max_uses=$6, start_on=$7, expires_on=$8, once_per_customer=$9, scope_note=$10 WHERE id=$11 RETURNING *`,
      [newCode, b.kind === "fixed" ? "fixed" : (b.kind === "percent" ? "percent" : row.kind), b.active != null ? !!b.active : row.active,
        b.value != null ? round2(b.value) : row.value, b.min_spend != null ? round2(b.min_spend) : row.min_spend,
        b.max_uses !== undefined ? (b.max_uses ? Number(b.max_uses) : null) : row.max_uses,
        b.start_on !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.start_on) ? b.start_on : null) : row.start_on,
        b.expires_on !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.expires_on) ? b.expires_on : null) : row.expires_on,
        b.once_per_customer != null ? !!b.once_per_customer : row.once_per_customer,
        b.scope_note !== undefined ? (String(b.scope_note || "").slice(0, 120) || null) : row.scope_note, row.id]);
    res.json({ code: serializeCode(u, req) });
  } catch (err) {
    if (String(err.code) === "23505") return res.status(409).json({ error: "duplicate", message: "That code already exists." });
    throw err;
  }
});
app.delete("/api/codes/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM codes WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// ---- Validate (preview a discount) -----------------------------------------
app.post("/api/validate", core.requireSession, async (req, res) => {
  const code = await db.one(`SELECT * FROM codes WHERE merchant_id=$1 AND code=$2`, [req.session.merchantId, cleanCode(req.body?.code)]);
  if (!code) return res.json({ valid: false, reason: "not_found" });
  const r = discountFor(code, round2(req.body?.amount));
  res.json(r.ok ? { valid: true, ...r, code: code.code } : { valid: false, reason: r.reason, min_spend: r.min_spend });
});

// ---- Charge with code (creates a discounted Inkress payment link) ----------
app.post("/api/charge", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const amount = round2(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: "bad_amount", message: "Enter an amount." });
  const code = await db.one(`SELECT * FROM codes WHERE merchant_id=$1 AND code=$2`, [req.session.merchantId, cleanCode(b.code)]);
  if (!code) return res.status(400).json({ error: "bad_code", message: "Code not found." });
  const calc = discountFor(code, amount);
  if (!calc.ok) return res.status(400).json({ error: "code_invalid", reason: calc.reason, message: `Code can't be applied (${calc.reason}).` });

  const email = b.customer?.email || null;
  if (code.once_per_customer && email) {
    const prior = await db.one(`SELECT 1 FROM redemptions WHERE merchant_id=$1 AND code=$2 AND lower(customer_email)=lower($3)`, [req.session.merchantId, code.code, email]);
    if (prior) return res.status(400).json({ error: "code_invalid", reason: "already_used", message: "This customer has already used this code." });
  }

  const ref = `promo-${req.session.merchantId}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const name = String(b.customer?.name || "Customer").trim();
  const [first, ...rest] = name.split(/\s+/);
  const emailForOrder = email || `promo+${ref}@bookerva.com`;
  let created;
  try {
    created = await createInkressOrder(core.cfg, req.session.accessToken, {
      referenceId: ref, total: calc.net, currencyCode: code.currency, kind: "online",
      title: `${name} - ${code.code} (-${fmtPlain(calc.discount, code.currency)})`,
      customer: { email: emailForOrder, first_name: first || "Customer", last_name: rest.join(" ") || "", phone: b.customer?.phone || undefined },
      metaData: { source: "promo-codes", promo_code: code.code, original: amount, discount: calc.discount },
    });
  } catch (err) { return res.status(502).json({ error: "inkress_failed", message: err?.message }); }

  // NOTE: used_count is NOT incremented here — only on confirmed payment
  // (webhook or poll). This fixes the bug where unpaid links "used up" a code.
  const red = await db.one(
    `INSERT INTO redemptions (merchant_id, code, code_id, original, discount, net, currency, customer, customer_email, ref, inkress_order_id, payment_url, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.session.merchantId, code.code, code.id, amount, calc.discount, calc.net, code.currency, name, email, ref,
      created.id != null ? String(created.id) : null, created.payment_url || null, req.actor?.name || null]);
  res.json({ redemption: serializeRed(red), payment_url: created.payment_url });
});

app.get("/api/redemptions", core.requireSession, async (req, res) => {
  res.json({ redemptions: (await db.q(`SELECT * FROM redemptions WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.session.merchantId])).map(serializeRed) });
});

// Mark a redemption paid + (idempotently) bump the code's used_count.
async function markRedemptionPaid(merchantId, red) {
  if (red.state === "paid") return false;
  await db.run(`UPDATE redemptions SET state='paid', paid_at=now() WHERE id=$1`, [red.id]);
  const cid = red.code_id;
  if (cid) await db.run(`UPDATE codes SET used_count = used_count + 1 WHERE id=$1 AND merchant_id=$2`, [cid, merchantId]);
  else await db.run(`UPDATE codes SET used_count = used_count + 1 WHERE merchant_id=$1 AND code=$2`, [merchantId, red.code]);
  return true;
}

app.post("/api/redemptions/:id/poll", core.requireSession, async (req, res) => {
  const row = await db.one(`SELECT * FROM redemptions WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!row || !row.inkress_order_id) return res.json({ changed: false });
  try {
    const ink = await getInkressOrder(core.cfg, req.session.accessToken, row.inkress_order_id);
    if (ink && isPaidStatus(ink)) { const changed = await markRedemptionPaid(req.session.merchantId, row); return res.json({ changed }); }
    res.json({ changed: false });
  } catch (err) { res.status(502).json({ error: "poll_failed", message: err?.message }); }
});

// ---- Analytics -------------------------------------------------------------
app.get("/api/analytics", core.requireSession, async (req, res) => {
  const codes = await db.q(`SELECT * FROM codes WHERE merchant_id=$1`, [req.session.merchantId]);
  const reds = await db.q(`SELECT * FROM redemptions WHERE merchant_id=$1`, [req.session.merchantId]);
  const byCode = new Map();
  for (const c of codes) byCode.set(c.code, { code: c.code, kind: c.kind, value: Number(c.value), state: codeState(c), issued: 0, paid: 0, discount: 0, revenue: 0 });
  for (const r of reds) {
    const g = byCode.get(r.code) || { code: r.code, issued: 0, paid: 0, discount: 0, revenue: 0 };
    g.issued++; if (r.state === "paid") { g.paid++; g.discount = round2(g.discount + Number(r.discount)); g.revenue = round2(g.revenue + Number(r.net)); }
    byCode.set(r.code, g);
  }
  const rows = [...byCode.values()].map((g) => ({ ...g, redemption_rate: g.issued ? Math.round((g.paid / g.issued) * 100) : 0 })).sort((a, b) => b.revenue - a.revenue);
  const paid = reds.filter((r) => r.state === "paid");
  res.json({
    totals: { codes: codes.length, issued: reds.length, paid: paid.length, redemption_rate: reds.length ? Math.round((paid.length / reds.length) * 100) : 0,
      discount_given: round2(paid.reduce((s, r) => s + Number(r.discount), 0)), revenue_driven: round2(paid.reduce((s, r) => s + Number(r.net), 0)) },
    top_codes: rows.slice(0, 10), by_code: rows,
  });
});

// CSV export
app.get("/api/codes.csv", core.requireSession, async (req, res) => {
  const codes = await db.q(`SELECT * FROM codes WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["code", "kind", "value", "state", "min_spend", "max_uses", "used_count", "start_on", "expires_on", "once_per_customer"];
  const lines = codes.map((c) => [c.code, c.kind, c.value, codeState(c), c.min_spend, c.max_uses ?? "", c.used_count, c.start_on || "", c.expires_on || "", c.once_per_customer].map(esc).join(","));
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", `attachment; filename="promo-codes.csv"`);
  res.send([head.join(","), ...lines].join("\n"));
});

// Webhook self-registration status
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try {
      await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) });
      await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url };
    } catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), can_register: Boolean(canRegister), webhook_secret_configured: Boolean(WEBHOOK_SECRET) });
});

// Public shareable campaign page (pre-applies a code)
app.get("/code/:token", async (req, res) => {
  const c = await db.one(`SELECT * FROM codes WHERE token=$1`, [req.params.token]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!c) return res.status(404).send(campaignShell("Not found", `<h1>Code not found</h1>`));
  res.send(campaignPage(c));
});

// Webhook receiver — real-time redemption: on paid order, mark redemption paid + bump used_count
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const red = await db.one(`SELECT * FROM redemptions WHERE merchant_id=$1 AND inkress_order_id=$2`, [merchantId, String(o.id)]);
    if (red) await markRedemptionPaid(merchantId, red);
  } catch (err) { console.error(`[promo-codes] webhook failed: ${err?.message}`); }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[promo-codes] listening on ${HOST}:${PORT}`));

function fmtPlain(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c }).format(n); } catch { return `${c} ${n}`; } }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function campaignShell(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1226;color:#fff;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:linear-gradient(160deg,#1b2150,#0f1226);border:1px solid #2b316b;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.4);max-width:420px;width:100%;padding:34px;text-align:center}
  h1{font-size:1.4rem;margin:0 0 6px}.muted{color:#aab0e0;font-size:.95rem;margin:0 0 18px}
  .code{font-family:ui-monospace,monospace;font-size:1.9rem;font-weight:800;letter-spacing:.12em;background:#fff;color:#1b2150;border-radius:12px;padding:14px 10px;margin:6px 0 14px;border:2px dashed #6b73c4}
  .terms{color:#cfd3f5;font-size:.9rem;margin:4px 0}.copy{margin-top:16px;padding:13px 24px;background:#6b73f4;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer}
  .pb{color:#7079b8;font-size:12px;margin-top:18px}</style></head>
  <body><div class="card">${inner}</div></body></html>`;
}
function campaignPage(c) {
  const off = c.kind === "percent" ? `${Number(c.value)}% off` : `${fmtPlain(Number(c.value), c.currency)} off`;
  const st = codeState(c);
  const terms = [];
  if (Number(c.min_spend) > 0) terms.push(`Min spend ${fmtPlain(Number(c.min_spend), c.currency)}`);
  if (c.expires_on) terms.push(`Valid until ${esc(c.expires_on)}`);
  if (c.scope_note) terms.push(esc(c.scope_note));
  return campaignShell(`${off} — ${c.code}`, `
    <h1>${off}</h1>
    <p class="muted">Use this code at checkout</p>
    <div class="code" id="code">${esc(c.code)}</div>
    ${terms.map((t) => `<p class="terms">${t}</p>`).join("")}
    ${st !== "active" && st !== "scheduled" ? `<p class="terms" style="color:#ff9b9b">This offer is ${st === "used_up" ? "fully claimed" : st}.</p>` : ""}
    <button class="copy" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(c.code)}');this.textContent='Copied!'">Copy code</button>
    <p class="pb">powered by Marketplace</p>`);
}
