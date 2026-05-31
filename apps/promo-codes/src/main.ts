import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Code { id: number; code: string; kind: "percent" | "fixed"; value: number; min_spend: number; max_uses: number | null; used_count: number; expires_on: string | null; start_on: string | null; once_per_customer: boolean; scope_note: string | null; active: boolean; currency: string; state: string; share_url: string | null; }
interface Redemption { id: number; code: string; original: number; discount: number; net: number; currency: string; customer: string | null; customer_email: string | null; payment_url: string | null; inkress_order_id: string | null; state: string; created_at: string; paid_at: string | null; }
interface Stats { active: number; redemptions: number; paid: number; discount_given: number; revenue_driven: number; redemption_rate: number; }
interface Analytics { totals: { codes: number; issued: number; paid: number; redemption_rate: number; discount_given: number; revenue_driven: number }; top_codes: any[]; by_code: any[]; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let shell: ReturnType<typeof mountShell>;
let webhookRealtime = false;
let codeFilter = "all";
let codeSearch = "";

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "tag",
    brandLogo: "/logo.svg",
    title: "Promo Codes",
    subtitle: `${merchantName} · discounts that create real pay links`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "codes", label: "Codes", icon: "tag", render: renderCodes },
      { id: "charge", label: "Charge with code", icon: "credit-card", render: renderCharge },
      { id: "redemptions", label: "Redemptions", icon: "list", render: renderRedemptions },
      { id: "analytics", label: "Analytics", icon: "chart", render: renderAnalytics },
    ],
  });
})();

const sidOf = () => sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";

/* --------------------------------------------------------------------- Codes */
async function renderCodes(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { codes: Code[]; stats: Stats; webhook_realtime: boolean; connected: boolean };
  try { data = await bvApi("/api/codes"); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  webhookRealtime = data.webhook_realtime;
  host.innerHTML = "";

  host.append(statRow([
    { k: "Active codes", v: String(data.stats.active), tone: "accent", icon: "tag" },
    { k: "Redemptions", v: `${data.stats.paid}/${data.stats.redemptions}`, d: `${data.stats.redemption_rate}% paid`, icon: "list" },
    { k: "Discount given", v: fmtMoney(data.stats.discount_given, currency), icon: "coins" },
    { k: "Revenue driven", v: fmtMoney(data.stats.revenue_driven, currency), tone: "ok", icon: "chart" },
  ]));

  const counts: Record<string, number> = {
    all: data.codes.length, active: data.codes.filter((c) => c.state === "active").length,
    scheduled: data.codes.filter((c) => c.state === "scheduled").length,
    expired: data.codes.filter((c) => c.state === "expired").length,
    used_up: data.codes.filter((c) => c.state === "used_up").length,
    paused: data.codes.filter((c) => c.state === "paused").length,
  };
  const seg = h("div", { class: "pc-seg" }, ...["all", "active", "scheduled", "expired", "used_up", "paused"].map((f) =>
    h("button", { class: "pc-seg-btn" + (codeFilter === f ? " is-on" : ""), onClick: () => { codeFilter = f; shell.select("codes"); } },
      f === "all" ? "All" : f === "used_up" ? "Used up" : f.charAt(0).toUpperCase() + f.slice(1), counts[f] ? h("span", { class: "pc-seg-n" }, String(counts[f])) : null)));
  const search = h("input", { class: "pc-search", placeholder: "Search codes…", value: codeSearch, onInput: (e: any) => { codeSearch = e.target.value; renderList(); } }) as HTMLInputElement;

  const bulk = h("button", { class: "ghost", onClick: () => openBulk() }, iconEl("plus", 14), "Bulk generate");
  const csv = h("a", { class: "ghost sm", href: "/api/codes.csv", onClick: (e: any) => { e.preventDefault(); downloadCsv(); } }, iconEl("download", 13), "CSV");
  const add = h("button", { class: "primary", onClick: () => openCode(null) }, iconEl("plus", 15), "New code");

  host.append(h("div", { class: "pc-filterbar" }, seg, search));
  const listWrap = h("div");
  host.append(card({ title: "Codes", action: h("div", { class: "pc-toolbar" }, csv, bulk, add), body: listWrap }));
  renderList();
  function renderList() {
    listWrap.innerHTML = "";
    let rows = data.codes.slice();
    if (codeFilter !== "all") rows = rows.filter((c) => c.state === codeFilter);
    const q = codeSearch.trim().toLowerCase();
    if (q) rows = rows.filter((c) => c.code.toLowerCase().includes(q) || (c.scope_note || "").toLowerCase().includes(q));
    if (!rows.length) { listWrap.append(emptyState({ icon: "tag", title: q || codeFilter !== "all" ? "No matching codes" : "No promo codes yet", text: "Create a code, then apply it on the Charge tab — or share its public link." })); return; }
    listWrap.append(dataTable<Code>({
      columns: [
        { head: "Code", cell: (c) => h("div", null, h("strong", { class: "pc-code" }, c.code), c.scope_note ? h("div", { class: "bv-muted" }, c.scope_note) : null) },
        { head: "Discount", cell: (c) => c.kind === "percent" ? `${c.value}% off` : `${fmtMoney(c.value, c.currency)} off` },
        { head: "Min spend", num: true, cell: (c) => c.min_spend ? fmtMoney(c.min_spend, c.currency) : "—" },
        { head: "Used", cell: (c) => usageCell(c) },
        { head: "Window", cell: (c) => h("span", { class: "bv-muted" }, windowLabel(c)) },
        { head: "Status", cell: (c) => statePill(c.state) },
      ],
      rows,
      rowActions: (c) => h("div", { class: "pc-row-actions" },
        c.share_url ? h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(c.share_url!); flash("Share link copied", "success"); } }, iconEl("copy", 13), "Share") : null,
        h("button", { class: "ghost sm", onClick: () => openCode(c) }, iconEl("edit", 13))),
    }));
  }
  if (webhookRealtime) host.append(h("div", { class: "pc-note bv-muted" }, iconEl("check", 14), "Real-time: codes count a redemption only when the customer actually pays."));
  else if (!data.connected) host.append(h("div", { class: "pc-note bv-muted" }, iconEl("alert", 14), "Connecting to Inkress…"));
}

function usageCell(c: Code) {
  const used = c.used_count, max = c.max_uses;
  if (max == null) return h("span", null, `${used}`);
  const pct = Math.min(100, Math.round((used / max) * 100));
  return h("div", { class: "pc-usage" }, h("div", { class: "pc-usage-track" }, h("div", { class: "pc-usage-fill" + (used >= max ? " is-full" : ""), style: { width: `${pct}%` } })), h("span", { class: "pc-usage-n" }, `${used}/${max}`));
}
function windowLabel(c: Code) {
  const parts: string[] = [];
  if (c.start_on && c.start_on > new Date().toISOString().slice(0, 10)) parts.push(`from ${c.start_on}`);
  if (c.expires_on) parts.push(`to ${c.expires_on}`);
  return parts.join(" ") || "—";
}
function statePill(s: string) {
  const tone = s === "active" ? "ok" : s === "scheduled" ? "accent" : s === "expired" || s === "used_up" ? "bad" : undefined;
  return pill(s === "used_up" ? "used up" : s, tone);
}

function openCode(c: Code | null) {
  const code = h("input", { value: c?.code || "", placeholder: "e.g. WELCOME10", style: { textTransform: "uppercase" } }) as HTMLInputElement;
  const kind = h("select", null, h("option", { value: "percent", selected: c?.kind !== "fixed" }, "% off"), h("option", { value: "fixed", selected: c?.kind === "fixed" }, "Fixed amount off")) as HTMLSelectElement;
  const value = h("input", { type: "number", min: "0", step: "0.01", value: c ? String(c.value) : "", placeholder: "10" }) as HTMLInputElement;
  const minSpend = h("input", { type: "number", min: "0", value: c ? String(c.min_spend) : "", placeholder: "0" }) as HTMLInputElement;
  const maxUses = h("input", { type: "number", min: "1", value: c?.max_uses != null ? String(c.max_uses) : "", placeholder: "unlimited" }) as HTMLInputElement;
  const startOn = h("input", { type: "date", value: c?.start_on?.slice(0, 10) || "" }) as HTMLInputElement;
  const expires = h("input", { type: "date", value: c?.expires_on?.slice(0, 10) || "" }) as HTMLInputElement;
  const scopeNote = h("input", { value: c?.scope_note || "", placeholder: "e.g. New customers only / Selected items" }) as HTMLInputElement;
  const oncePer = h("input", { type: "checkbox", checked: c ? c.once_per_customer : false }) as HTMLInputElement;
  const active = h("input", { type: "checkbox", checked: c ? c.active : true }) as HTMLInputElement;

  const body = h("div", { class: "pc-form" },
    h("div", { class: "pc-form-grid" }, field("Code", code), field("Discount type", kind), field("Value", value), field("Min spend", minSpend), field("Max uses", maxUses), field("", h("span"))),
    h("div", { class: "pc-form-grid" }, field("Starts (optional)", startOn), field("Expires (optional)", expires)),
    field("Restriction note (shown on share page)", scopeNote),
    h("label", { class: "pc-check" }, oncePer, " One use per customer"),
    h("label", { class: "pc-check" }, active, " Active"));

  const save = async () => {
    if (!code.value.trim()) { toast("Enter a code", "warning"); return; }
    if (!(Number(value.value) > 0)) { toast("Enter a discount value", "warning"); return; }
    const payload: any = { code: code.value, kind: kind.value, value: Number(value.value), min_spend: Number(minSpend.value) || 0,
      max_uses: maxUses.value || null, start_on: startOn.value || null, expires_on: expires.value || null,
      once_per_customer: oncePer.checked, scope_note: scopeNote.value || null, active: active.checked };
    try {
      if (c) await bvApi(`/api/codes/${c.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await bvApi("/api/codes", { method: "POST", body: JSON.stringify(payload) });
      flash(c ? "Code updated" : "Code created", "success"); shell.select("codes");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  const actions: any[] = [{ label: c ? "Save" : "Create", primary: true, onClick: () => { void save(); } }];
  if (c) actions.unshift({ label: "Delete", danger: true, onClick: () => { void (async () => { try { await bvApi(`/api/codes/${c.id}`, { method: "DELETE" }); flash("Deleted", "info"); shell.select("codes"); } catch (e: any) { toast(e?.message || "error", "error"); } })(); } });
  openModal({ title: c ? `Edit ${c.code}` : "New promo code", body, actions });
}

function openBulk() {
  const count = h("input", { type: "number", min: "1", max: "200", value: "10" }) as HTMLInputElement;
  const prefix = h("input", { value: "SAVE", placeholder: "SAVE", style: { textTransform: "uppercase" } }) as HTMLInputElement;
  const kind = h("select", null, h("option", { value: "percent" }, "% off"), h("option", { value: "fixed" }, "Fixed amount off")) as HTMLSelectElement;
  const value = h("input", { type: "number", min: "0", step: "0.01", placeholder: "10" }) as HTMLInputElement;
  const minSpend = h("input", { type: "number", min: "0", placeholder: "0" }) as HTMLInputElement;
  const maxUses = h("input", { type: "number", min: "1", value: "1", placeholder: "1" }) as HTMLInputElement;
  const expires = h("input", { type: "date" }) as HTMLInputElement;
  const body = h("div", { class: "pc-form" },
    h("p", { class: "bv-muted", style: { margin: "0" } }, "Generate a batch of unique random codes that share the same terms — perfect for influencer or campaign drops."),
    h("div", { class: "pc-form-grid" }, field("How many", count), field("Prefix", prefix), field("Discount type", kind), field("Value", value), field("Min spend", minSpend), field("Max uses each", maxUses)),
    field("Expires (optional)", expires));
  const save = async () => {
    if (!(Number(value.value) > 0)) { toast("Enter a discount value", "warning"); return; }
    try {
      const r = await bvApi<{ created: number }>("/api/codes/bulk", { method: "POST", body: JSON.stringify({ count: Number(count.value) || 1, prefix: prefix.value || "SAVE", kind: kind.value, value: Number(value.value), min_spend: Number(minSpend.value) || 0, max_uses: maxUses.value || null, expires_on: expires.value || null }) });
      flash(`Generated ${r.created} codes`, "success"); shell.select("codes");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: "Bulk generate codes", body, actions: [{ label: "Generate", primary: true, onClick: () => { void save(); } }] });
}

function downloadCsv() {
  fetch(`/api/codes.csv`, { headers: { "X-BV-Session": sidOf() } }).then((r) => r.blob()).then((b) => { const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "promo-codes.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); }).catch(() => toast("Couldn't export", "error"));
}

/* -------------------------------------------------------------------- Charge */
function renderCharge(host: HTMLElement) {
  let preview: { valid: boolean; discount?: number; net?: number; reason?: string } | null = null;
  const amount = h("input", { type: "number", min: "0", step: "0.01", placeholder: "0.00", class: "pc-field-input" }) as HTMLInputElement;
  const codeInput = h("input", { placeholder: "Code", class: "pc-field-input", style: { textTransform: "uppercase" } }) as HTMLInputElement;
  const cName = h("input", { placeholder: "Customer name", class: "pc-field-input" }) as HTMLInputElement;
  const cEmail = h("input", { type: "email", placeholder: "Email (optional)", class: "pc-field-input" }) as HTMLInputElement;
  const previewBox = h("div", { class: "pc-preview" });
  const result = h("div");

  let t: any;
  const doValidate = async () => {
    const amt = Number(amount.value); const code = codeInput.value.trim();
    if (!amt || !code) { preview = null; renderPreview(); return; }
    try { preview = await bvApi("/api/validate", { method: "POST", body: JSON.stringify({ amount: amt, code }) }); }
    catch { preview = null; }
    renderPreview();
  };
  const renderPreview = () => {
    previewBox.innerHTML = "";
    if (!preview) return;
    if (!preview.valid) { previewBox.append(h("div", { class: "pc-preview-bad" }, iconEl("alert", 15), reasonText(preview.reason))); return; }
    previewBox.append(
      h("div", { class: "pc-preview-row" }, h("span", null, "Discount"), h("b", { class: "pc-disc" }, `- ${fmtMoney(preview.discount!, currency)}`)),
      h("div", { class: "pc-preview-row pc-preview-net" }, h("span", null, "Customer pays"), h("b", null, fmtMoney(preview.net!, currency))));
  };
  amount.addEventListener("input", () => { clearTimeout(t); t = setTimeout(doValidate, 250); });
  codeInput.addEventListener("input", () => { clearTimeout(t); t = setTimeout(doValidate, 250); });

  const charge = h("button", { class: "primary pc-charge", onClick: async () => {
    const amt = Number(amount.value);
    if (!(amt > 0)) { toast("Enter an amount", "warning"); return; }
    if (!codeInput.value.trim()) { toast("Enter a code", "warning"); return; }
    try {
      const r = await bvApi<{ payment_url: string; redemption: Redemption }>("/api/charge", { method: "POST", body: JSON.stringify({ amount: amt, code: codeInput.value, customer: { name: cName.value, email: cEmail.value || null } }) });
      showResult(r.redemption, r.payment_url);
    } catch (err: any) { toast(err?.message || "Couldn't create link", "error"); }
  } }, iconEl("send", 16), "Create discounted pay link");

  host.append(card({ title: "Charge with a code", body: h("div", { class: "pc-charge-form" },
    h("div", { class: "pc-form-grid" }, field("Amount before discount", amount), field("Promo code", codeInput), field("Customer name", cName), field("Email", cEmail)),
    previewBox, charge, result) }));

  function showResult(red: Redemption, url: string | null) {
    const body = h("div", null,
      h("div", { class: "pc-result-sum" },
        h("div", null, h("span", { class: "bv-muted" }, "Was "), h("s", null, fmtMoney(red.original, red.currency))),
        h("div", { class: "pc-result-net" }, fmtMoney(red.net, red.currency)),
        pill(`${red.code} · -${fmtMoney(red.discount, red.currency)}`, "primary")));
    if (url) body.append(h("div", { class: "pc-actions", style: { marginTop: "12px" } },
      h("button", { class: "primary", onClick: () => { navigator.clipboard?.writeText(url); flash("Link copied", "success"); } }, iconEl("copy", 15), "Copy pay link"),
      h("a", { class: "pc-btnlink", href: url, target: "_blank", rel: "noopener" }, iconEl("external", 15), "Open")));
    openModal({ title: "Discounted link ready", body, actions: [{ label: "Done", primary: true, onClick: () => { amount.value = ""; codeInput.value = ""; cName.value = ""; cEmail.value = ""; preview = null; renderPreview(); result.innerHTML = ""; shell.select("redemptions"); } }] });
  }
}

/* --------------------------------------------------------------- Redemptions */
async function renderRedemptions(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { redemptions: Redemption[] };
  try { data = await bvApi("/api/redemptions"); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  host.append(card({ title: "Redemptions", body: data.redemptions.length ? dataTable<Redemption>({
    columns: [
      { head: "Code", cell: (r) => h("strong", { class: "pc-code" }, r.code) },
      { head: "Customer", cell: (r) => h("span", { class: "bv-muted" }, r.customer || r.customer_email || "—") },
      { head: "Original", num: true, cell: (r) => h("s", { class: "bv-muted" }, fmtMoney(r.original, r.currency)) },
      { head: "Paid", num: true, cell: (r) => fmtMoney(r.net, r.currency) },
      { head: "State", cell: (r) => pill(r.state, r.state === "paid" ? "ok" : "warn") },
      { head: "When", cell: (r) => h("span", { class: "bv-muted" }, relTime(r.created_at)) },
    ],
    rows: data.redemptions,
    onRowClick: (r) => openRedemption(r),
  }) : emptyState({ icon: "list", title: "No redemptions yet", text: "Create a discounted link on the Charge tab." }) }));
}

function openRedemption(r: Redemption) {
  const body = h("div", null,
    h("div", { class: "pc-result-sum" }, h("div", null, h("s", { class: "bv-muted" }, fmtMoney(r.original, r.currency))), h("div", { class: "pc-result-net" }, fmtMoney(r.net, r.currency)), pill(`${r.code} · -${fmtMoney(r.discount, r.currency)}`, "primary")),
    h("div", { class: "pc-detail-meta" }, h("span", null, "State: ", pill(r.state, r.state === "paid" ? "ok" : "warn")), r.inkress_order_id ? h("span", { class: "bv-muted" }, `Inkress #${r.inkress_order_id}`) : null));
  if (r.payment_url) body.append(h("div", { class: "pc-actions", style: { marginTop: "10px" } }, h("button", { class: "ghost", onClick: () => { navigator.clipboard?.writeText(r.payment_url!); flash("Copied", "success"); } }, "Copy link"), h("a", { class: "pc-btnlink", href: r.payment_url, target: "_blank", rel: "noopener" }, "Open")));
  const actions: any[] = [{ label: "Close", onClick: () => {} }];
  if (r.state !== "paid") actions.unshift({ label: "Check payment", primary: true, onClick: () => { void (async () => { try { const x = await bvApi<{ changed: boolean }>(`/api/redemptions/${r.id}/poll`, { method: "POST" }); flash(x.changed ? "Paid!" : "Still awaiting", x.changed ? "success" : "info"); if (x.changed) shell.select("redemptions"); } catch (e: any) { toast(e?.message || "error", "error"); } })(); return true; } });
  openModal({ title: `Redemption · ${r.code}`, body, actions });
}

/* ---------------------------------------------------------------- Analytics */
async function renderAnalytics(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let a: Analytics;
  try { a = await bvApi("/api/analytics"); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  host.append(statRow([
    { k: "Codes", v: String(a.totals.codes), icon: "tag" },
    { k: "Redemption rate", v: `${a.totals.redemption_rate}%`, d: `${a.totals.paid}/${a.totals.issued} paid`, tone: "accent", icon: "chart" },
    { k: "Discount given", v: fmtMoney(a.totals.discount_given, currency), icon: "coins" },
    { k: "Revenue driven", v: fmtMoney(a.totals.revenue_driven, currency), tone: "ok", icon: "coins" },
  ]));
  host.append(card({ title: "Performance by code", body: a.by_code.length ? dataTable<any>({
    columns: [
      { head: "Code", cell: (g) => h("strong", { class: "pc-code" }, g.code) },
      { head: "Issued", num: true, cell: (g) => String(g.issued) },
      { head: "Paid", num: true, cell: (g) => String(g.paid) },
      { head: "Rate", num: true, cell: (g) => `${g.redemption_rate}%` },
      { head: "Discount", num: true, cell: (g) => fmtMoney(g.discount, currency) },
      { head: "Revenue", num: true, cell: (g) => fmtMoney(g.revenue, currency) },
    ],
    rows: a.by_code,
  }) : emptyState({ icon: "chart", title: "No data yet", text: "Analytics appear once codes are redeemed and paid." }) }));
}

/* -------------------------------------------------------------------- helpers */
function reasonText(reason?: string) {
  return ({ not_found: "Code not found.", inactive: "Code is inactive.", scheduled: "Code hasn't started yet.", expired: "Code has expired.", used_up: "Code has reached its usage limit.", min_spend: "Amount is below the minimum spend.", already_used: "This customer has already used this code." } as Record<string, string>)[reason || ""] || "Code can't be applied.";
}
function field(label: string, el: HTMLElement) { return h("label", { class: "pc-field" }, label ? h("span", { class: "bv-label" }, label) : null, el); }
function fatal(msg?: string) {
  return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Promo Codes couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard."));
}
