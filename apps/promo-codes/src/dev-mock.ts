/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const today = () => new Date().toISOString().slice(0, 10);
function stateOf(c: any) {
  if (!c.active) return "paused";
  if (c.start_on && c.start_on > today()) return "scheduled";
  if (c.expires_on && c.expires_on < today()) return "expired";
  if (c.max_uses != null && c.used_count >= c.max_uses) return "used_up";
  return "active";
}
const tok = () => Math.random().toString(36).slice(2, 9);
function withState(c: any) { return { ...c, state: stateOf(c), share_url: location.origin + "/code/" + (c.token || "tok"), once_per_customer: !!c.once_per_customer, scope_note: c.scope_note ?? null, start_on: c.start_on ?? null }; }
let CODES: any[] = [
  { id: 1, code: "WELCOME10", kind: "percent", value: 10, min_spend: 0, max_uses: null, used_count: 14, start_on: null, expires_on: null, once_per_customer: true, scope_note: "New customers only", active: true, currency: "JMD", token: "w10tok" },
  { id: 2, code: "BIGSPEND500", kind: "fixed", value: 500, min_spend: 5000, max_uses: 100, used_count: 23, start_on: null, expires_on: "2026-12-31", once_per_customer: false, scope_note: null, active: true, currency: "JMD", token: "bs5tok" },
  { id: 3, code: "EASTER25", kind: "percent", value: 25, min_spend: 0, max_uses: 50, used_count: 50, start_on: null, expires_on: "2026-04-30", once_per_customer: false, scope_note: null, active: false, currency: "JMD", token: "e25tok" },
  { id: 4, code: "SUMMERSOON", kind: "percent", value: 15, min_spend: 0, max_uses: null, used_count: 0, start_on: "2099-06-01", expires_on: null, once_per_customer: false, scope_note: null, active: true, currency: "JMD", token: "sstok" },
];
let CID = 4;
const REDS: any[] = [
  { id: 1, code: "WELCOME10", original: 5000, discount: 500, net: 4500, currency: "JMD", customer: "Maria Brown", customer_email: "maria@example.com", payment_url: "https://pay.dev/x", inkress_order_id: "2390", state: "paid", created_at: new Date(Date.now() - 36e5).toISOString(), paid_at: new Date(Date.now() - 30e5).toISOString() },
  { id: 2, code: "BIGSPEND500", original: 8000, discount: 500, net: 7500, currency: "JMD", customer: "Devon Clarke", customer_email: "devon@example.com", payment_url: "https://pay.dev/y", inkress_order_id: "2391", state: "awaiting", created_at: new Date(Date.now() - 72e5).toISOString(), paid_at: null },
];
let RID = 2;

function disc(c: any, amt: number) {
  const st = stateOf(c);
  if (st === "paused") return { ok: false, reason: "inactive" };
  if (st === "scheduled") return { ok: false, reason: "scheduled" };
  if (st === "expired") return { ok: false, reason: "expired" };
  if (st === "used_up") return { ok: false, reason: "used_up" };
  if (amt < c.min_spend) return { ok: false, reason: "min_spend" };
  const d = c.kind === "percent" ? Math.round(amt * c.value / 100) : Math.min(c.value, amt);
  return { ok: true, discount: d, net: amt - d };
}
function analytics() {
  const byCode = new Map<string, any>();
  for (const c of CODES) byCode.set(c.code, { code: c.code, kind: c.kind, value: c.value, state: stateOf(c), issued: 0, paid: 0, discount: 0, revenue: 0 });
  for (const r of REDS) { const g = byCode.get(r.code) || { code: r.code, issued: 0, paid: 0, discount: 0, revenue: 0 }; g.issued++; if (r.state === "paid") { g.paid++; g.discount += r.discount; g.revenue += r.net; } byCode.set(r.code, g); }
  const rows = [...byCode.values()].map((g) => ({ ...g, redemption_rate: g.issued ? Math.round((g.paid / g.issued) * 100) : 0 })).sort((a, b) => b.revenue - a.revenue);
  const paid = REDS.filter((r) => r.state === "paid");
  return { totals: { codes: CODES.length, issued: REDS.length, paid: paid.length, redemption_rate: REDS.length ? Math.round((paid.length / REDS.length) * 100) : 0, discount_given: paid.reduce((s, r) => s + r.discount, 0), revenue_driven: paid.reduce((s, r) => s + r.net, 0) }, top_codes: rows.slice(0, 10), by_code: rows };
}

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));
    const cm = u.pathname.match(/\/api\/codes\/(\d+)$/);
    const rm = u.pathname.match(/\/api\/redemptions\/(\d+)\/poll/);

    if (u.pathname === "/api/codes" && method === "GET") {
      const paid = REDS.filter((r) => r.state === "paid");
      return json({ codes: CODES.map(withState), connected: true, webhook_realtime: true, stats: { active: CODES.filter((c) => stateOf(c) === "active").length, redemptions: REDS.length, paid: paid.length, discount_given: paid.reduce((s, r) => s + r.discount, 0), revenue_driven: paid.reduce((s, r) => s + r.net, 0), redemption_rate: REDS.length ? Math.round((paid.length / REDS.length) * 100) : 0 } });
    }
    if (u.pathname === "/api/codes" && method === "POST") { const c = { id: ++CID, code: String(body.code).toUpperCase(), kind: body.kind, value: body.value, min_spend: body.min_spend || 0, max_uses: body.max_uses ? Number(body.max_uses) : null, used_count: 0, start_on: body.start_on || null, expires_on: body.expires_on || null, once_per_customer: !!body.once_per_customer, scope_note: body.scope_note || null, active: body.active !== false, currency: "JMD", token: tok() }; CODES.unshift(c); return json({ code: withState(c) }, 201); }
    if (u.pathname === "/api/codes/bulk" && method === "POST") { const n = Math.min(200, Number(body.count) || 1); const created = []; for (let i = 0; i < n; i++) { const c = { id: ++CID, code: (body.prefix || "SAVE").toUpperCase() + Math.random().toString(16).slice(2, 8).toUpperCase(), kind: body.kind, value: body.value, min_spend: body.min_spend || 0, max_uses: body.max_uses ? Number(body.max_uses) : null, used_count: 0, start_on: null, expires_on: body.expires_on || null, once_per_customer: false, scope_note: null, active: true, currency: "JMD", token: tok() }; CODES.unshift(c); created.push(withState(c)); } return json({ created: created.length, batch_id: "batch-x", codes: created }, 201); }
    if (cm && method === "PATCH") { const c = CODES.find((x) => x.id === Number(cm[1])); Object.assign(c, body, { max_uses: body.max_uses ? Number(body.max_uses) : (body.max_uses === null ? null : c.max_uses) }); return json({ code: withState(c) }); }
    if (cm && method === "DELETE") { CODES = CODES.filter((x) => x.id !== Number(cm[1])); return json({ ok: true }); }
    if (u.pathname === "/api/codes.csv") return new Response("code,kind,value,state\nWELCOME10,percent,10,active", { status: 200, headers: { "Content-Type": "text/csv" } });
    if (u.pathname === "/api/analytics") return json(analytics());
    if (u.pathname === "/api/validate") { const c = CODES.find((x) => x.code === String(body.code).toUpperCase()); if (!c) return json({ valid: false, reason: "not_found" }); const r = disc(c, body.amount); return json(r.ok ? { valid: true, ...r, code: c.code } : { valid: false, reason: r.reason }); }
    if (u.pathname === "/api/charge") { const c = CODES.find((x) => x.code === String(body.code).toUpperCase()); if (!c) return json({ error: "bad_code", message: "Code not found." }, 400); const r = disc(c, body.amount); if (!r.ok) return json({ error: "code_invalid", reason: r.reason, message: "Can't apply." }, 400); const red = { id: ++RID, code: c.code, original: body.amount, discount: r.discount, net: r.net, currency: "JMD", customer: body.customer?.name || "Customer", customer_email: body.customer?.email || null, payment_url: "https://pay.dev.inkress.com/" + RID, inkress_order_id: String(2400 + RID), state: "awaiting", created_at: new Date().toISOString(), paid_at: null }; REDS.unshift(red); return json({ redemption: red, payment_url: red.payment_url }); }
    if (u.pathname === "/api/redemptions" && method === "GET") return json({ redemptions: REDS });
    if (rm) { const r = REDS.find((x) => x.id === Number(rm[1])); if (r && r.state !== "paid") { r.state = "paid"; r.paid_at = new Date().toISOString(); const c = CODES.find((x) => x.code === r.code); if (c) c.used_count++; return json({ changed: true }); } return json({ changed: false }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:read", "orders:write", "webhooks:manage", "offline_access"],
  };
}
