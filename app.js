import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, query, where, writeBatch, setDoc, updateDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app), db = getFirestore(app);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scr = (n) => 'SCR ' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const ROLE_LABEL = { admin: 'Admin', sales_associate: 'Sales associate', developer: 'Developer' };
const STATUSES = ['Prospect', 'Pitch Sent', 'Meeting', 'Closed', 'Lost'];
const PAY_METHODS = [['Online transfer', 'Online transfer'], ['Cash', 'Cash']];

// Link visibility only – the real enforcement is Firestore rules.
const NAV = [
  ['overview', 'Overview', ['admin']],
  ['pipeline', 'Lead pipeline', ['admin', 'sales_associate']],
  ['commissions', 'Commissions', ['admin', 'sales_associate']],
  ['plans', 'Maintenance plans', ['admin', 'sales_associate']],
  ['support', 'Site health & hours', ['admin', 'developer']],
  ['clients', 'Clients', ['admin']],
  ['billing', 'Billing & payments', ['admin']],
  ['team', 'Team', ['admin']],
];
let me = null; // { uid, name, email, role }

const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 4000); };
// Every write is checked by firestore.rules; permission-denied means role or stale data.
async function run(fn) {
  try { return await fn(); }
  catch (e) { toast(e.code === 'permission-denied' ? 'Not allowed: your role cannot make that change, or the data changed. Refresh and try again.' : (e.message || 'Something went wrong. Try again.')); throw e; }
}
const ref = (...p) => doc(db, ...p);
const now = () => new Date().toISOString();
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Local calendar dates (so the 1st of the month starts on the 1st where you are, not in UTC).
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const period = () => today().slice(0, 7); // e.g. 2026-11
const nextFirst = () => { const [y, m] = today().split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); };
const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const list = async (q) => (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
const mine = (col, field) => (me.role === 'admin' ? collection(db, col) : query(collection(db, col), where(field, '==', me.uid)));

const COLORS = { Paid: '#43d9c8', Due: '#f0c674', Overdue: '#ff8585', 'Not invoiced': '#9bb2bd' };
const badge = (s) => `<span class="badge" style="color:${COLORS[s] || '#9bb2bd'}">${esc(s)}</span>`;
const payState = (p) => (p.status === 'Paid' ? 'Paid' : today() > p.due_date ? 'Overdue' : 'Due');
// Hours reset every month: if the stored month is old, this month's usage is 0 (no rollover).
const usedNow = (c) => ((c.hours_period || period()) === period() ? Number(c.hours_used || 0) : 0);
// A client's monthly fee always comes from their plan (falls back to the stored amount if the plan was deleted).
const priceOf = (c, planById) => planById[c.plan_id]?.price_monthly ?? c.retainer_amount ?? 0;

// Ready-to-paste messages (built when a page renders, copied with one click).
const MSG = {};
const SIGN = '\n\nAXIS Digital Engineering · +248 260 3277 · axisagency.co';
const reminderText = (p, contact) => `Hi ${contact || p.client_name}, a friendly reminder that your AXIS website care payment of ${scr(p.amount)} for ${p.period} was due on ${p.due_date}. You can pay by online transfer or cash. Please let me know once it is done. Thank you!${SIGN}`;
const confirmText = (c, plan) => `Hi ${c.contact_person}, welcome to AXIS Digital Engineering! This confirms your plan:\n\n${plan.name} at ${scr(plan.price_monthly ?? c.retainer_amount)} per month, starting ${c.start_date || 'the next 1st'}.\n• Up to ${plan.included_hours ?? 0} developer hours per month (unused hours do not roll over)\n• Support response: ${plan.response || 'as per your plan sheet'}\n• Billing: invoiced on the 1st, payable by the 5th by online transfer or cash\n• Minimum commitment: ${plan.min_term_months || 3} months, then month to month with 30 days' notice\n\nPlease reply "Confirmed" to lock this in.${SIGN}`;
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into WhatsApp, SMS or email.'); }
  catch { prompt('Copy this message:', text); }
}
const receiptHtml = (p) => `<!doctype html><meta charset="utf-8"><title>Receipt ${esc(p.receipt_no)}</title>
<style>body{font:15px/1.6 system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:3rem auto;padding:0 1.25rem;color:#111}h1{font-size:1.3rem;letter-spacing:.14em;margin:0}small{color:#666}table{width:100%;border-collapse:collapse;margin:1.5rem 0}td{padding:.55rem 0;border-bottom:1px solid #ddd}td:last-child{text-align:right;font-weight:600}button{padding:.5rem 1rem;font:inherit;cursor:pointer}@media print{button{display:none}}</style>
<h1>AXIS DIGITAL ENGINEERING</h1><small>+248 260 3277 · axisagency.co</small><h2>Payment receipt</h2>
<table><tr><td>Receipt no.</td><td>${esc(p.receipt_no)}</td></tr><tr><td>Received from</td><td>${esc(p.client_name)}</td></tr><tr><td>For</td><td>Website care plan, ${esc(p.period)}</td></tr><tr><td>Amount</td><td>${scr(p.amount)}</td></tr><tr><td>Paid by</td><td>${esc(p.method)}</td></tr><tr><td>Date received</td><td>${esc(p.paid_on)}</td></tr></table>
<p>Thank you for your payment.</p><button onclick="print()">Print or save as PDF</button>`;

// Generic form dialog -> resolves with values or null.
function ask(title, fields) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>${fields.map((f) => `<label>${esc(f.label)}${
      f.options ? `<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select>`
        : `<input name="${f.name}" type="${f.type || 'text'}" step="any" ${f.opt ? '' : 'required'} ${f.value ? `value="${esc(f.value)}"` : ''}>`}</label>`).join('')}
      <div class="row"><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">Save</button></div></form>`;
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? Object.fromEntries(new FormData(d.querySelector('form'))) : null);
    d.showModal();
  });
}

/* ---------------------------------- views ---------------------------------- */
const views = {
  // Everything that needs attention, on one screen.
  async overview() {
    const per = period(), t = today();
    const [clients, pays, ops, plans] = await Promise.all([list(collection(db, 'clients')), list(collection(db, 'payments')), list(collection(db, 'client_ops')), list(collection(db, 'plans'))]);
    const planById = Object.fromEntries(plans.map((p) => [p.id, p]));
    const contactOf = Object.fromEntries(clients.map((c) => [c.id, c.contact_person]));
    const unpaid = pays.filter((p) => p.status !== 'Paid');
    const overdue = unpaid.filter((p) => t > p.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const active = clients.filter((c) => (c.start_date || '0000').slice(0, 7) <= per);
    const missing = active.filter((c) => !pays.some((p) => p.client_id === c.id && p.period === per));
    const hot = ops.filter((o) => o.included_hours > 0 && usedNow(o) / o.included_hours >= 0.8);
    const ending = clients.filter((c) => c.term_end_date && daysBetween(t, c.term_end_date) <= 45).sort((a, b) => a.term_end_date.localeCompare(b.term_end_date));
    const noHealth = ops.filter((o) => ['uptime', 'backups', 'security'].some((k) => !(o.site_health || {})[k]));
    const sum = (a) => a.reduce((s, p) => s + (p.amount || 0), 0);
    const mrr = clients.reduce((s, c) => s + priceOf(c, planById), 0);
    const sec = (title, items, empty) => `<section class="col"><b>${title} <span class="muted" style="display:inline">${items.length}</span></b>${items.join('') || `<span class="muted">${empty}</span>`}</section>`;

    const overdueItems = overdue.map((p) => { MSG['rem:' + p.id] = reminderText(p, contactOf[p.client_id]);
      return `<div class="card"><b>${esc(p.client_name)}</b><span class="muted">${scr(p.amount)} · ${p.period} · ${daysBetween(p.due_date, t)} day(s) late</span>
        <div class="row" style="justify-content:flex-start"><button data-act="copy" data-id="rem:${p.id}">Copy reminder</button><button class="primary" data-act="mark-paid" data-id="${p.id}">Mark paid</button></div></div>`; });
    const missingItems = missing.map((c) => `<div class="card"><b>${esc(c.company_name)}</b><span class="muted">${scr(priceOf(c, planById))} · not invoiced for ${per}</span></div>`);
    if (missing.length) missingItems.push(`<button class="primary" data-act="gen-invoices">Create ${per} invoices</button>`);
    const hotItems = hot.map((o) => { const pct = Math.min(100, (usedNow(o) / o.included_hours) * 100);
      return `<div class="card"><b>${esc(o.company_name)}</b><span class="muted">${usedNow(o)} / ${o.included_hours} hours used this month</span><div class="bar"><i class="${usedNow(o) > o.included_hours ? 'over' : ''}" style="width:${pct}%"></i></div></div>`; });
    const endingItems = ending.map((c) => { const d = daysBetween(t, c.term_end_date);
      return `<div class="card"><b>${esc(c.company_name)}</b><span class="muted">${d >= 0 ? `Minimum term ends in ${d} day(s) (${c.term_end_date})` : `Minimum term ended ${-d} day(s) ago. They can cancel with 30 days' notice.`}</span></div>`; });
    const healthItems = noHealth.map((o) => `<div class="card"><b>${esc(o.company_name)}</b><span class="muted">Not confirmed: ${['uptime', 'backups', 'security'].filter((k) => !(o.site_health || {})[k]).join(', ')}</span></div>`);

    $('#main').innerHTML = `<h2>Overview</h2>
      <div class="stats"><div><b>${scr(mrr)}</b><span class="muted">Monthly recurring revenue</span></div><div><b>${scr(sum(pays.filter((p) => p.status === 'Paid' && p.period === per)))}</b><span class="muted">Collected in ${per}</span></div>
      <div><b>${scr(sum(unpaid))}</b><span class="muted">Outstanding</span></div><div><b>${clients.length}</b><span class="muted">Clients</span></div></div>
      <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      ${sec('Overdue payments', overdueItems, 'Nobody is overdue.')}${sec('Not invoiced yet', missingItems, `Everyone is invoiced for ${per}.`)}
      ${sec('Hours almost used up', hotItems, 'No client is near their monthly hours.')}${sec('Minimum terms ending (45 days)', endingItems, 'No terms ending soon.')}
      ${sec('Site health not confirmed', healthItems, 'All health checks are confirmed.')}</div>`;
  },

  async pipeline() {
    const leads = await list(mine('leads', 'sales_rep_id'));
    $('#main').innerHTML = `<div class="toolbar"><h2>Lead pipeline</h2><button class="primary" data-act="new-lead">New lead</button></div>
      <div class="board">${STATUSES.map((s) => { const items = leads.filter((l) => l.status === s);
        return `<section class="col"><b>${s} <span class="muted" style="display:inline">${items.length}</span></b>${items.map((l) => `
          <div class="card"><b>${esc(l.company_name)}</b><span class="muted">${esc(l.contact_person)} · ${scr(l.estimated_value)}</span>
          ${s === 'Closed' ? '' : `<select data-act="move" data-id="${l.id}">${['Prospect', 'Pitch Sent', 'Meeting', 'Lost'].map((o) => `<option ${o === s ? 'selected' : ''}>${o}</option>`).join('')}</select>
          ${s === 'Lost' ? '' : `<button class="primary" data-act="close" data-id="${l.id}">Close deal</button>`}`}</div>`).join('') || '<span class="muted">No leads</span>'}</section>`; }).join('')}</div>`;
  },

  async commissions() {
    const [rows, leadList, meDoc] = await Promise.all([list(mine('commissions', 'sales_rep_id')), list(mine('leads', 'sales_rep_id')),
      me.role === 'sales_associate' ? getDoc(ref('users', me.uid)) : null]);
    const lead = Object.fromEntries(leadList.map((l) => [l.id, l]));
    let head = '';
    if (me.role === 'sales_associate') {
      const u = meDoc.data() || {};
      head = `<div class="stats"><div><b>${scr(u.pending_commission)}</b><span class="muted">Pending</span></div><div><b>${scr(u.total_earned)}</b><span class="muted">Paid out</span></div></div>`;
    }
    $('#main').innerHTML = `<h2>Commissions</h2>${head}<div class="wrap"><table><tr><th>Deal</th><th>Amount</th><th>Status</th><th>Created</th><th></th></tr>${rows.map((c) => `
      <tr><td>${esc(lead[c.lead_id]?.company_name || c.lead_id)}</td><td>${scr(c.amount)}</td><td>${c.status}</td><td>${c.created_at.slice(0, 10)}</td>
      <td>${me.role === 'admin' && c.status === 'Unpaid' ? `<button data-act="pay" data-id="${c.id}">Mark paid</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No commissions yet. Close a deal to create one.</td></tr>'}</table></div>`;
  },

  async plans() {
    const [plans, clients] = await Promise.all([list(collection(db, 'plans')), me.role === 'admin' ? list(collection(db, 'clients')) : null]); // linked clients are billing data: admin only
    const admin = me.role === 'admin';
    $('#main').innerHTML = `<div class="toolbar"><h2>Maintenance plans</h2><div class="row">${admin && !plans.length ? '<button data-act="seed-plans">Load AXIS plans</button>' : ''}${admin ? '<button class="primary" data-act="new-plan">Add plan</button>' : ''}</div></div><div class="cards">${plans.sort((a, b) => a.price_monthly - b.price_monthly).map((p) => `<article class="plan"><h3>${esc(p.name)}</h3>
      <b style="font-size:1.4rem">${scr(p.price_monthly)}<span class="muted" style="display:inline"> / month</span></b><span>${p.included_hours} developer hours / month (no rollover)</span>
      ${p.response ? `<span class="muted">Response: ${esc(p.response)}</span>` : ''}${p.min_term_months ? `<span class="muted">Minimum term: ${p.min_term_months} months</span>` : ''}
      <ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${clients ? `<span class="muted">${clients.filter((c) => c.plan_id === p.id).map((c) => esc(c.company_name)).join(', ') || 'No linked clients'}</span>` : ''}${admin ? `<div class="row" style="justify-content:flex-start"><button data-act="edit-plan" data-id="${p.id}">Edit</button><button data-act="del-plan" data-id="${p.id}">Delete</button></div>` : ''}</article>`).join('') || '<p class="muted">No plans yet. Admins can load the AXIS plans or add one.</p>'}</div>`;
  },

  async support() {
    const rows = await list(collection(db, 'client_ops'));
    $('#main').innerHTML = `<h2>Site health & hours</h2><span class="muted" style="margin:-.75rem 0 1rem">Hours reset on the 1st of every month. Unused hours do not roll over.</span><div class="wrap"><table><tr><th>Client</th><th>Plan</th><th>Hours this month</th><th>Uptime</th><th>Backups</th><th>Security</th><th></th></tr>${rows.map((c) => {
      const used = usedNow(c), pct = Math.min(100, (used / (c.included_hours || 1)) * 100);
      return `<tr><td>${esc(c.company_name)}</td><td>${esc(c.plan_name)}</td>
        <td>${used} / ${c.included_hours}<div class="bar"><i class="${used > c.included_hours ? 'over' : ''}" style="width:${pct}%"></i></div></td>
        ${['uptime', 'backups', 'security'].map((k) => `<td><input type="checkbox" style="width:auto" aria-label="${k} for ${esc(c.company_name)}" data-act="health" data-id="${c.id}" data-key="${k}" ${(c.site_health || {})[k] ? 'checked' : ''}></td>`).join('')}
        <td><button data-act="hours" data-id="${c.id}">Log hours</button> <button data-act="docs" data-id="${c.id}">Documents</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No clients yet.</td></tr>'}</table></div>`;
  },

  async clients() {
    const [clients, plans, pays] = await Promise.all([list(collection(db, 'clients')), list(collection(db, 'plans')), list(collection(db, 'payments'))]);
    const planById = Object.fromEntries(plans.map((p) => [p.id, p]));
    const per = period();
    const mrr = clients.reduce((s, c) => s + priceOf(c, planById), 0);
    const stateOf = (c) => { const mineP = pays.filter((p) => p.client_id === c.id), cur = mineP.find((p) => p.period === per);
      return mineP.some((p) => payState(p) === 'Overdue') ? 'Overdue' : cur ? payState(cur) : 'Not invoiced'; };
    const states = clients.map(stateOf);
    $('#main').innerHTML = `<div class="toolbar"><h2>Clients</h2><button class="primary" data-act="new-client">Add client</button></div>
      <div class="stats"><div><b>${scr(mrr)}</b><span class="muted">Monthly recurring revenue</span></div><div><b>${states.filter((s) => s === 'Overdue').length}</b><span class="muted">Overdue</span></div><div><b>${clients.length}</b><span class="muted">Clients</span></div></div>
      <div class="wrap"><table><tr><th>Company</th><th>Plan</th><th>Monthly fee</th><th>Pays by</th><th>Term ends</th><th>${per}</th><th></th></tr>${clients.map((c, i) => {
        const plan = planById[c.plan_id] || { name: c.plan_id || 'your plan', included_hours: 0 };
        MSG['conf:' + c.id] = confirmText(c, plan);
        return `<tr><td>${esc(c.company_name)}<span class="muted">${esc(c.contact_person)} · ${esc(c.email)}</span></td><td>${esc(plan.name)}</td><td>${scr(priceOf(c, planById))}</td><td>${esc(c.pay_method || 'Online transfer')}</td><td>${esc(c.term_end_date || '—')}</td>
        <td>${badge(states[i])}</td><td><button data-act="copy" data-id="conf:${c.id}">Copy confirmation</button> <button data-act="change-plan" data-id="${c.id}">Change plan</button> <button data-act="docs" data-id="${c.id}">Documents</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No clients yet.</td></tr>'}</table></div>`;
  },

  async billing() {
    const [clients, pays] = await Promise.all([list(collection(db, 'clients')), list(collection(db, 'payments'))]);
    const per = period();
    const contactOf = Object.fromEntries(clients.map((c) => [c.id, c.contact_person]));
    const sum = (a) => a.reduce((s, p) => s + (p.amount || 0), 0);
    const unpaid = pays.filter((p) => p.status !== 'Paid');
    const rows = [...pays].sort((a, b) => (a.status === 'Paid') - (b.status === 'Paid') || b.period.localeCompare(a.period) || a.client_name.localeCompare(b.client_name)).slice(0, 80);
    $('#main').innerHTML = `<div class="toolbar"><h2>Billing & payments</h2><button class="primary" data-act="gen-invoices">Create ${per} invoices</button></div>
      <span class="muted" style="margin:-.75rem 0 1rem">Invoices go out on the 1st and are due on the 5th. Created after the 5th? They are due 5 days later. Payment by online transfer or cash.</span>
      <div class="stats"><div><b>${scr(sum(pays.filter((p) => p.status === 'Paid' && p.period === per)))}</b><span class="muted">Collected in ${per}</span></div><div><b>${scr(sum(unpaid))}</b><span class="muted">Outstanding</span></div>
      <div><b>${unpaid.filter((p) => today() > p.due_date).length}</b><span class="muted">Overdue</span></div></div>
      <div class="wrap"><table><tr><th>Client</th><th>Month</th><th>Amount</th><th>Due</th><th>Status</th><th>Paid by</th><th></th></tr>${rows.map((p) => {
        if (p.status !== 'Paid') MSG['rem:' + p.id] = reminderText(p, contactOf[p.client_id]);
        return `<tr><td>${esc(p.client_name)}</td><td>${p.period}</td><td>${scr(p.amount)}</td><td>${p.due_date}</td><td>${badge(payState(p))}</td>
        <td>${p.status === 'Paid' ? `${esc(p.method)}<span class="muted">${esc(p.paid_on)} · ${esc(p.receipt_no)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${p.status === 'Paid' ? `<button data-act="receipt" data-id="${p.id}">Receipt</button>` : `<button class="primary" data-act="mark-paid" data-id="${p.id}">Mark paid</button> <button data-act="set-due" data-id="${p.id}">Change due date</button> <button data-act="copy" data-id="rem:${p.id}">Copy reminder</button>`}</td></tr>`; }).join('')
        || `<tr><td colspan="7" class="muted">No invoices yet. Press "Create ${per} invoices" on the 1st of each month.</td></tr>`}</table></div>`;
  },
};

views.team = async () => {
  const users = await list(collection(db, 'users'));
  $('#main').innerHTML = `<div class="toolbar"><h2>Team</h2><button class="primary" data-act="new-member">Add team member</button></div>
    <div class="wrap"><table><tr><th>Name</th><th>User ID</th><th>Role</th></tr>${users.map((u) => `<tr><td>${esc(u.name)}<span class="muted">${esc(u.email)}</span></td><td class="muted">${esc(u.id)}</td>
    <td><select data-act="set-role" data-id="${u.id}">${u.role === 'pending' ? '<option value="pending" selected disabled>Pending approval</option>' : ''}${Object.keys(ROLE_LABEL).map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></td></tr>`).join('')}</table></div>`;
};

/* --------------------------------- actions ---------------------------------- */
/* ------------------------- maintenance documents ---------------------------- */
async function openDocs(clientId) {
  const base = collection(db, 'client_docs');
  const q = me.role === 'admin' ? query(base, where('client_id', '==', clientId)) : query(base, where('client_id', '==', clientId), where('visibility', '==', 'team'));
  const items = (await run(() => list(q))).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const d = $('#dlg');
  d.onclose = null;
  d.innerHTML = `<div style="display:grid;gap:.8rem"><h3>Documents</h3>
    ${items.map((x) => `<div class="card"><b>${esc(x.title)}</b><span class="muted">${x.kind === 'file' ? `PDF · ${Math.max(1, Math.round(x.size / 1024))} KB` : 'Link'} · ${x.created_at.slice(0, 10)}${x.visibility === 'admin' ? ' · admin only' : ''}</span>
      <div class="row" style="justify-content:flex-start"><button data-open="${x.id}">Open</button>${me.role === 'admin' ? `<button data-del="${x.id}">Delete</button>` : ''}</div></div>`).join('') || '<p class="muted">No documents yet.</p>'}
    <label>Title<input id="dt"></label>
    <label>Link (https://…, e.g. a Google Drive share link)<input id="du" type="url"></label>
    <label>Or a PDF file (up to 600 KB)<input id="df" type="file" accept="application/pdf"></label>
    ${me.role === 'admin' ? '<label style="display:flex;gap:.5rem;align-items:center"><input id="dv" type="checkbox" style="width:auto"> Admin only (hide from developers)</label>' : ''}
    <div class="row"><button id="dclose">Close</button><button class="primary" id="dsave">Add document</button></div></div>`;
  d.querySelector('#dclose').onclick = () => d.close();

  d.onclick = async (e) => {
    const open = e.target.closest('[data-open]'), del = e.target.closest('[data-del]');
    if (open) {
      const x = items.find((i) => i.id === open.dataset.open);
      const w = window.open('', '_blank'); // opened first so pop-up blockers allow it
      if (!w) return toast('Allow pop-ups to open documents.');
      w.opener = null;
      try {
        if (x.kind === 'link') w.location = x.url;
        else {
          const bin = atob((await getDoc(ref('doc_files', x.id))).data().data);
          w.location = URL.createObjectURL(new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: 'application/pdf' }));
        }
      } catch { w.close(); toast('Could not open that document.'); }
    }
    if (del && confirm('Delete this document?')) {
      const x = items.find((i) => i.id === del.dataset.del);
      const b = writeBatch(db);
      b.delete(ref('client_docs', x.id));
      if (x.kind === 'file') b.delete(ref('doc_files', x.id));
      await run(() => b.commit());
      openDocs(clientId);
    }
  };

  d.querySelector('#dsave').onclick = async () => {
    const title = d.querySelector('#dt').value.trim(), url = d.querySelector('#du').value.trim(), file = d.querySelector('#df').files[0];
    const visibility = me.role === 'admin' && d.querySelector('#dv').checked ? 'admin' : 'team';
    if (!title) return toast('Give the document a title.');
    if (!url && !file) return toast('Add a link or choose a PDF.');
    if (!file && !/^https:\/\//i.test(url)) return toast('Links must start with https://');
    if (file && (file.type !== 'application/pdf' || file.size > 600 * 1024)) return toast('Only PDFs up to 600 KB can be uploaded. For larger files, paste a link instead.');
    const mRef = doc(collection(db, 'client_docs'));
    const meta = { id: mRef.id, client_id: clientId, title, kind: file ? 'file' : 'link', visibility, uploaded_by: me.uid, created_at: now() };
    const b = writeBatch(db);
    if (file) {
      meta.size = file.size;
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      b.set(ref('doc_files', mRef.id), { id: mRef.id, client_id: clientId, visibility, data });
    } else meta.url = url;
    b.set(mRef, meta);
    await run(() => b.commit());
    openDocs(clientId);
  };
  if (!d.open) d.showModal();
}

const planFields = (p = {}) => [
  { name: 'name', label: 'Plan name (e.g. Core Performance & Care Plan)', value: p.name },
  { name: 'price_monthly', label: 'Price per month (SCR)', type: 'number', value: p.price_monthly },
  { name: 'included_hours', label: 'Developer hours per month', type: 'number', value: p.included_hours },
  { name: 'response', label: 'Support response (e.g. 24-hour turnaround on critical fixes)', value: p.response, opt: true },
  { name: 'min_term_months', label: 'Minimum term (months)', type: 'number', value: p.min_term_months ?? 3 },
  { name: 'features', label: 'Features (separate with commas)', value: (p.features || []).join(', ') },
];
const SEED_PLANS = [
  { id: 'starter', name: 'Starter Care Plan', price_monthly: 5000, included_hours: 2, response: '48-72 hours by email or ticket (no emergency guarantee)', min_term_months: 6,
    features: ['24/7 uptime and performance monitoring', 'Daily off-site cloud backups', 'Weekly CMS plugin and security patches', 'SSL + firewall + malware protection', 'Quarterly site health summary'] },
  { id: 'core', name: 'Core Performance & Care Plan', price_monthly: 10000, included_hours: 4, response: '24-hour turnaround on critical fixes', min_term_months: 3,
    features: ['24/7 uptime monitoring with a sub-2-second speed target', 'Daily off-site backups with emergency restoration', 'Weekly CMS plugin and security patches', 'SSL + firewall + malware protection', 'Monthly executive analytics and health PDF', 'Priority support'] },
  { id: 'enterprise', name: 'Enterprise Growth & Managed Engineering', price_monthly: 15000, included_hours: 8, response: '2-4 hour emergency response', min_term_months: 3,
    features: ['Everything in Core', 'Active CRO and technical SEO', 'Feature builds and landing pages', 'Monthly 30-minute CTO strategy call', 'Emergency response in 2-4 hours'] },
];
async function seedPlans() {
  const b = writeBatch(db);
  SEED_PLANS.forEach((p) => b.set(ref('plans', p.id), p));
  await run(() => b.commit());
  toast('AXIS plans loaded: Starter, Core and Enterprise.');
}
async function ensurePlans() {
  let plans = await list(collection(db, 'plans'));
  if (!plans.length) {
    if (me.role !== 'admin') { toast('No plans yet. Ask an admin to add one.'); return []; }
    if (confirm('No plans yet. Load the three AXIS plans (Starter, Core, Enterprise)?')) await seedPlans();
    else { toast('No plans yet. Create your first one.'); await actions['new-plan'](); }
    plans = await list(collection(db, 'plans'));
  }
  return plans;
}
function planData(id, f) {
  const price = Number(f.price_monthly), hours = Number(f.included_hours);
  if (!(price >= 0) || !(hours >= 0)) { toast('Price and hours must be numbers.'); throw new Error('invalid plan'); }
  return { id, name: f.name.trim(), price_monthly: price, included_hours: hours, response: (f.response || '').trim(), min_term_months: Number(f.min_term_months) || 3,
    features: f.features.split(',').map((x) => x.trim()).filter(Boolean) };
}

const actions = {
  async docs(el) { await openDocs(el.dataset.id); },
  async copy(el) { await copy(MSG[el.dataset.id] || ''); },
  async 'seed-plans'() { if (confirm('Load the three AXIS plans (Starter, Core, Enterprise)?')) await seedPlans(); },
  async 'new-plan'() {
    const f = await ask('Add plan', planFields());
    if (!f) return;
    const r = doc(collection(db, 'plans'));
    const data = planData(r.id, f);
    await run(() => setDoc(r, data));
  },
  // Editing a plan updates every client on it (name, hours, and monthly fee) from the next invoice on.
  async 'edit-plan'(el) {
    const f = await ask('Edit plan', planFields((await getDoc(ref('plans', el.dataset.id))).data()));
    if (!f) return;
    const data = planData(el.dataset.id, f);
    const [linkedOps, linkedClients] = await Promise.all([
      getDocs(query(collection(db, 'client_ops'), where('plan_id', '==', el.dataset.id))),
      getDocs(query(collection(db, 'clients'), where('plan_id', '==', el.dataset.id)))]);
    const b = writeBatch(db), t = now();
    b.set(ref('plans', el.dataset.id), data);
    linkedOps.docs.forEach((d) => b.update(d.ref, { plan_name: data.name, included_hours: data.included_hours, updated_at: t }));
    linkedClients.docs.forEach((d) => b.update(d.ref, { retainer_amount: data.price_monthly, updated_at: t }));
    await run(() => b.commit());
  },
  async 'del-plan'(el) {
    if (confirm('Delete this plan? Existing clients keep their records but lose the plan label.')) await run(() => deleteDoc(ref('plans', el.dataset.id)));
  },
  // Move a client to another plan: fee, hours and plan name all follow the new plan.
  async 'change-plan'(el) {
    const [plans, cSnap] = await Promise.all([list(collection(db, 'plans')), getDoc(ref('clients', el.dataset.id))]);
    const cl = cSnap.data();
    if (!plans.length) return toast('No plans yet. Add one on the Maintenance plans page.');
    const sorted = [...plans].sort((a, b) => (b.id === cl.plan_id) - (a.id === cl.plan_id) || a.price_monthly - b.price_monthly);
    const f = await ask(`Change plan: ${cl.company_name}`, [{ name: 'plan_id', label: 'New plan', options: sorted.map((p) => [p.id, `${p.name} (${scr(p.price_monthly)})`]) }]);
    if (!f) return;
    const plan = plans.find((p) => p.id === f.plan_id), t = now();
    const b = writeBatch(db);
    b.update(ref('clients', el.dataset.id), { plan_id: plan.id, retainer_amount: plan.price_monthly, updated_at: t });
    b.update(ref('client_ops', el.dataset.id), { plan_id: plan.id, plan_name: plan.name, included_hours: plan.included_hours, updated_at: t });
    await run(() => b.commit());
    toast(`${cl.company_name} is now on ${plan.name}. The new fee applies from the next invoice.`);
  },
  async 'new-lead'() {
    const f = await ask('New lead', [{ name: 'company_name', label: 'Company' }, { name: 'contact_person', label: 'Contact person' }, { name: 'estimated_value', label: 'Estimated value (SCR)', type: 'number' },
      ...(me.role === 'admin' ? [{ name: 'sales_rep_id', label: 'Sales associate user ID' }] : [])]);
    if (!f) return;
    const r = doc(collection(db, 'leads'));
    await run(() => setDoc(r, { id: r.id, company_name: f.company_name.trim(), contact_person: f.contact_person.trim(), status: 'Prospect',
      estimated_value: Number(f.estimated_value), sales_rep_id: me.role === 'admin' ? f.sales_rep_id.trim() : me.uid, created_at: now(), updated_at: now() }));
  },
  async move(el) { await run(() => updateDoc(ref('leads', el.dataset.id), { status: el.value, updated_at: now() })); },

  // Closing = one atomic batch: lead -> Closed, client + client_ops, commission (plan price x rate), rep balance.
  async close(el) {
    const id = el.dataset.id;
    const plans = await ensurePlans();
    if (!plans.length) return;
    const [settings, leadSnap] = await Promise.all([getDoc(ref('settings', 'agency')), getDoc(ref('leads', id))]);
    const lead = leadSnap.data();
    const f = await ask('Close deal', [
      { name: 'planId', label: 'Maintenance plan', options: plans.map((p) => [p.id, `${p.name} (${scr(p.price_monthly)})`]) },
      { name: 'contactEmail', label: 'Client email', type: 'email' },
      { name: 'pay_method', label: 'Client pays by', options: PAY_METHODS }]);
    if (!f) return;
    const plan = plans.find((p) => p.id === f.planId);
    const retainer = plan.price_monthly; // the fee always comes from the plan
    const rate = settings.exists() ? Number(settings.data().commission_rate ?? 0.1) : 0.1;
    const amount = r2(retainer * rate);
    const repRef = ref('users', lead.sales_rep_id);
    const rep = (await getDoc(repRef)).data() || {};
    const cRef = doc(collection(db, 'clients'));
    const t = now(), health = { uptime: false, backups: false, security: false };
    const start = nextFirst(); // every plan starts billing on the 1st
    const b = writeBatch(db);
    b.update(ref('leads', id), { status: 'Closed', closed_at: t, updated_at: t, client_id: cRef.id });
    b.set(cRef, { id: cRef.id, lead_id: id, company_name: lead.company_name, contact_person: lead.contact_person, email: f.contactEmail.trim(), plan_id: plan.id,
      retainer_amount: retainer, start_date: start, next_renewal_date: start, term_end_date: addMonths(start, plan.min_term_months || 3), pay_method: f.pay_method,
      payment_status: 'Pending', hours_used: 0, site_health: health, created_at: t, updated_at: t });
    b.set(ref('client_ops', cRef.id), { id: cRef.id, company_name: lead.company_name, plan_id: plan.id, plan_name: plan.name, included_hours: plan.included_hours, hours_used: 0, hours_period: period(), site_health: health, updated_at: t });
    b.set(ref('commissions', id), { id, lead_id: id, sales_rep_id: lead.sales_rep_id, amount, status: 'Unpaid', created_at: t });
    b.update(repRef, { pending_commission: r2((rep.pending_commission || 0) + amount), last_commission_id: id });
    await run(() => b.commit());
    toast(`Deal closed. Commission booked: ${scr(amount)}. Billing starts ${start}.`);
  },

  async pay(el) {
    const cRef = ref('commissions', el.dataset.id);
    const c = (await getDoc(cRef)).data();
    const uRef = ref('users', c.sales_rep_id);
    const u = (await getDoc(uRef)).data();
    const b = writeBatch(db);
    b.update(cRef, { status: 'Paid', paid_at: now() });
    b.update(uRef, { pending_commission: r2((u.pending_commission || 0) - c.amount), total_earned: r2((u.total_earned || 0) + c.amount) });
    await run(() => b.commit());
  },

  // Invoices: one per client per month. Due on the 5th; if created after the 5th, due 5 days from today.
  // The amount is the client's plan price.
  async 'gen-invoices'() {
    const [clients, pays, plans] = await Promise.all([list(collection(db, 'clients')), list(collection(db, 'payments')), list(collection(db, 'plans'))]);
    const planById = Object.fromEntries(plans.map((p) => [p.id, p]));
    const per = period(), have = new Set(pays.filter((p) => p.period === per).map((p) => p.client_id));
    const todo = clients.filter((c) => !have.has(c.id) && priceOf(c, planById) > 0 && (c.start_date || '0000').slice(0, 7) <= per);
    if (!todo.length) return toast(`Everyone is already invoiced for ${per}.`);
    const fifth = `${per}-05`, due = today() > fifth ? addDays(today(), 5) : fifth;
    const b = writeBatch(db), t = now();
    todo.forEach((c) => {
      const id = `${c.id}_${per}`, price = priceOf(c, planById);
      b.set(ref('payments', id), { id, client_id: c.id, client_name: c.company_name, period: per, amount: price, due_date: due, status: 'Invoiced', method: '', receipt_no: '', created_at: t });
      b.update(ref('clients', c.id), { payment_status: 'Pending', retainer_amount: price, updated_at: t });
    });
    await run(() => b.commit());
    toast(`${todo.length} invoice(s) created for ${per}. Due ${due}.`);
  },

  // Fix an exception (late invoice, agreed extension) without touching anything else.
  async 'set-due'(el) {
    const p = (await getDoc(ref('payments', el.dataset.id))).data();
    const f = await ask(`Due date: ${p.client_name} (${p.period})`, [{ name: 'due_date', label: 'New due date', type: 'date', value: p.due_date }]);
    if (!f) return;
    await run(() => updateDoc(ref('payments', el.dataset.id), { due_date: f.due_date }));
    toast('Due date updated.');
  },

  async 'mark-paid'(el) {
    const [pSnap, pays] = await Promise.all([getDoc(ref('payments', el.dataset.id)), list(collection(db, 'payments'))]);
    const p = pSnap.data();
    const cl = (await getDoc(ref('clients', p.client_id))).data() || {};
    const methods = cl.pay_method === 'Cash' ? [...PAY_METHODS].reverse() : PAY_METHODS;
    const f = await ask(`Record payment: ${p.client_name} (${scr(p.amount)})`, [{ name: 'method', label: 'Paid by', options: methods }, { name: 'paid_on', label: 'Date received', type: 'date', value: today() }]);
    if (!f) return;
    const pref = `R-${f.paid_on.slice(0, 7).replace('-', '')}-`;
    const receipt = pref + String(pays.filter((x) => (x.receipt_no || '').startsWith(pref)).length + 1).padStart(3, '0');
    const stillOwing = pays.some((x) => x.client_id === p.client_id && x.id !== p.id && x.status !== 'Paid');
    const b = writeBatch(db);
    b.update(ref('payments', p.id), { status: 'Paid', method: f.method, paid_on: f.paid_on, paid_at: now(), receipt_no: receipt });
    b.update(ref('clients', p.client_id), { payment_status: stillOwing ? 'Overdue' : 'Paid', updated_at: now() });
    await run(() => b.commit());
    toast(`Payment recorded. Receipt ${receipt}.`);
  },

  async receipt(el) {
    const w = window.open('', '_blank'); // opened first so pop-up blockers allow it
    if (!w) return toast('Allow pop-ups to open the receipt.');
    w.opener = null;
    try {
      const p = (await getDoc(ref('payments', el.dataset.id))).data();
      w.document.write(receiptHtml(p));
      w.document.close();
    } catch { w.close(); toast('Could not open that receipt.'); }
  },

  async health(el) { await run(() => updateDoc(ref('client_ops', el.dataset.id), { [`site_health.${el.dataset.key}`]: el.checked, updated_at: now() })); },

  // Hours reset each month: the first log of a new month starts the counter again.
  async hours(el) {
    const f = await ask('Log maintenance hours', [{ name: 'hoursSpent', label: 'Hours (steps of 0.25)', type: 'number' }, { name: 'description', label: 'What did you do?' }]);
    if (!f) return;
    const h = Number(f.hoursSpent);
    if (!(h > 0 && h <= 24 && h % 0.25 === 0)) return toast('Log hours between 0.25 and 24, in steps of 0.25.');
    const oRef = ref('client_ops', el.dataset.id);
    const o = (await getDoc(oRef)).data();
    const per = period(), rolled = !!o.hours_period && o.hours_period !== per;
    const used = rolled ? h : (o.hours_used || 0) + h;
    const lRef = doc(collection(db, 'maintenance_logs'));
    const b = writeBatch(db);
    b.set(lRef, { id: lRef.id, client_id: el.dataset.id, developer_id: me.uid, hours_spent: h, description: f.description.trim(), date: today() });
    b.update(oRef, { hours_used: used, hours_period: per, last_log_id: lRef.id, updated_at: now() });
    await run(() => b.commit());
    toast(`Logged. ${used} of ${o.included_hours} hours used this month.`);
  },

  async 'new-client'() {
    const plans = await ensurePlans();
    if (!plans.length) return;
    const f = await ask('Add client', [{ name: 'company_name', label: 'Company' }, { name: 'contact_person', label: 'Contact person' }, { name: 'email', label: 'Email', type: 'email' },
      { name: 'plan_id', label: 'Plan', options: plans.map((p) => [p.id, `${p.name} (${scr(p.price_monthly)})`]) },
      { name: 'start_date', label: 'First billing date (the 1st)', type: 'date', value: nextFirst() },
      { name: 'pay_method', label: 'Client pays by', options: PAY_METHODS }]);
    if (!f) return;
    const plan = plans.find((p) => p.id === f.plan_id);
    const cRef = doc(collection(db, 'clients'));
    const t = now(), health = { uptime: false, backups: false, security: false };
    const b = writeBatch(db);
    b.set(cRef, { id: cRef.id, company_name: f.company_name.trim(), contact_person: f.contact_person.trim(), email: f.email.trim(), plan_id: plan.id, retainer_amount: plan.price_monthly,
      start_date: f.start_date, next_renewal_date: f.start_date, term_end_date: addMonths(f.start_date, plan.min_term_months || 3), pay_method: f.pay_method,
      payment_status: 'Pending', hours_used: 0, site_health: health, created_at: t, updated_at: t });
    b.set(ref('client_ops', cRef.id), { id: cRef.id, company_name: f.company_name.trim(), plan_id: plan.id, plan_name: plan.name, included_hours: plan.included_hours, hours_used: 0, hours_period: period(), site_health: health, updated_at: t });
    await run(() => b.commit());
  },

  async 'new-member'() {
    const f = await ask('Add team member (create their login in Firebase Authentication first)', [{ name: 'uid', label: 'User ID (UID from Authentication)' }, { name: 'name', label: 'Name' }, { name: 'email', label: 'Email', type: 'email' },
      { name: 'role', label: 'Role', options: Object.entries(ROLE_LABEL) }]);
    if (!f) return;
    await run(() => setDoc(ref('users', f.uid.trim()), { id: f.uid.trim(), name: f.name.trim(), email: f.email.trim(), role: f.role, pending_commission: 0, total_earned: 0 }));
  },
  async 'set-role'(el) { await run(() => updateDoc(ref('users', el.dataset.id), { role: el.value })); },
};

const NO_REFRESH = new Set(['copy', 'receipt']);
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || ['SELECT', 'INPUT'].includes(el.tagName)) return;
  if (el.disabled) return;
  el.disabled = true; // no double-clicks while a write is in flight
  try { await actions[el.dataset.act](el); if (!NO_REFRESH.has(el.dataset.act)) await render(); } catch { /* toast already shown */ } finally { el.disabled = false; }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  // The control already shows the new value, so skip the refetch unless the write failed.
  try { await actions[el.dataset.act](el); if (!['health', 'set-role'].includes(el.dataset.act)) await render(); } catch { await render(); }
});

/* ---------------------------------- shell ---------------------------------- */
const SKELETON = '<div class="skel" style="width:40%;height:2rem"></div><div class="skel" style="height:8rem;margin-top:1rem"></div><div class="skel" style="height:14rem;margin-top:1rem"></div>';
async function render(skeleton = false) {
  const allowed = NAV.filter((n) => n[2].includes(me.role));
  const route = location.hash.slice(1);
  const current = allowed.find((n) => n[0] === route) || allowed[0];
  $('#nav').innerHTML = allowed.map((n) => `<a href="#${n[0]}" ${n === current ? 'aria-current="page"' : ''}>${n[1]}</a>`).join('');
  if (skeleton) $('#main').innerHTML = SKELETON;
  try { await views[current[0]](); }
  catch (e) { console.error(e); $('#main').innerHTML = '<p class="muted">Could not load this page. Check your connection and try again.</p>'; }
}
window.addEventListener('hashchange', () => me && render(true));

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    if (signupMode) { window.__signupName = $('#name').value; await createUserWithEmailAndPassword(auth, $('#email').value, $('#password').value); }
    else await signInWithEmailAndPassword(auth, $('#email').value, $('#password').value);
  }
  catch (err) {
    const code = err.code || '';
    $('#login-error').textContent =
      code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' ? 'Email or password is incorrect.'
      : code === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.' || code === 'auth/invalid-api-key' ? 'Firebase config is missing or wrong. Check firebase-config.js.'
      : code === 'auth/email-already-in-use' ? 'That email already has an account. Sign in instead.'
      : code === 'auth/weak-password' ? 'Choose a password with at least 6 characters.'
      : code === 'auth/unauthorized-domain' ? 'This domain is not authorized in Firebase Authentication settings.'
      : code === 'auth/operation-not-allowed' ? 'Email/Password sign-in is not enabled in Firebase.'
      : `Sign-in failed (${code || 'unknown error'}).`;
  }
});
$('#signout').addEventListener('click', () => signOut(auth));

let signupMode = false;
$('#mode-toggle').addEventListener('click', () => {
  signupMode = !signupMode;
  $('#name-row').classList.toggle('hidden', !signupMode);
  $('#name').required = signupMode;
  $('#login-btn').textContent = signupMode ? 'Create account' : 'Sign in';
  $('#mode-toggle').textContent = signupMode ? 'I already have an account' : 'Create an account';
  $('#login-error').textContent = '';
});

// First account ever becomes admin (and closes that door with settings/bootstrap).
// Everyone after that is created as "pending" until an admin assigns a role on the Team page.
async function createProfile(user) {
  const base = { id: user.uid, name: (window.__signupName || user.displayName || user.email.split('@')[0]).trim(), email: user.email, pending_commission: 0, total_earned: 0 };
  const marker = ref('settings', 'bootstrap');
  const first = !(await getDoc(marker)).exists();
  if (first) {
    try {
      const b = writeBatch(db);
      b.set(marker, { claimed_by: user.uid, at: now() });
      b.set(ref('users', user.uid), { ...base, role: 'admin' });
      await b.commit();
      return { ...base, role: 'admin' };
    } catch { /* someone else claimed it first: fall through to pending */ }
  }
  await setDoc(ref('users', user.uid), { ...base, role: 'pending' });
  return { ...base, role: 'pending' };
}
// Existing admins close the first-admin door the next time they sign in.
async function ensureBootstrapMarker() {
  const marker = ref('settings', 'bootstrap');
  if (!(await getDoc(marker)).exists()) await setDoc(marker, { claimed_by: me.uid, at: now() }).catch(() => {});
}

onAuthStateChanged(auth, async (user) => {
  me = null;
  $('#shell').classList.toggle('hidden', !user);
  $('#login').classList.toggle('hidden', !!user);
  if (!user) return;
  let profile = (await getDoc(ref('users', user.uid))).data();
  if (!profile) profile = await createProfile(user);
  if (!ROLE_LABEL[profile.role]) {
    await signOut(auth);
    $('#login-error').textContent = 'Account created. An admin has to approve it and assign your role. Try again after they have.';
    return;
  }
  me = { uid: user.uid, name: profile.name || user.email.split('@')[0], email: user.email, role: profile.role };
  $('#who').textContent = me.name; $('#who-email').textContent = me.email;
  $('#role').textContent = ROLE_LABEL[me.role]; $('#role').className = `badge ${me.role}`;
  if (me.role === 'admin') ensureBootstrapMarker();
  render(true);
});
