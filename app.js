import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, query, where, writeBatch, setDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app), db = getFirestore(app);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scr = (n) => 'SCR ' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const ROLE_LABEL = { admin: 'Admin', sales_associate: 'Sales associate', developer: 'Developer' };
const STATUSES = ['Prospect', 'Pitch Sent', 'Meeting', 'Closed', 'Lost'];

// Link visibility only – the real enforcement is Firestore rules + Cloud Functions.
const NAV = [
  ['pipeline', 'Lead pipeline', ['admin', 'sales_associate']],
  ['commissions', 'Commissions', ['admin', 'sales_associate']],
  ['plans', 'Maintenance plans', ['admin', 'sales_associate']],
  ['support', 'Site health & hours', ['admin', 'developer']],
  ['clients', 'Clients & billing', ['admin']],
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
const nextMonth = () => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };
const list = async (q) => (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
const mine = (col, field) => (me.role === 'admin' ? collection(db, col) : query(collection(db, col), where(field, '==', me.uid)));

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
    const rows = await list(mine('commissions', 'sales_rep_id'));
    const lead = Object.fromEntries((await list(mine('leads', 'sales_rep_id'))).map((l) => [l.id, l]));
    let head = '';
    if (me.role === 'sales_associate') {
      const u = (await getDoc(doc(db, 'users', me.uid))).data() || {};
      head = `<div class="stats"><div><b>${scr(u.pending_commission)}</b><span class="muted">Pending</span></div><div><b>${scr(u.total_earned)}</b><span class="muted">Paid out</span></div></div>`;
    }
    $('#main').innerHTML = `<h2>Commissions</h2>${head}<div class="wrap"><table><tr><th>Deal</th><th>Amount</th><th>Status</th><th>Created</th><th></th></tr>${rows.map((c) => `
      <tr><td>${esc(lead[c.lead_id]?.company_name || c.lead_id)}</td><td>${scr(c.amount)}</td><td>${c.status}</td><td>${c.created_at.slice(0, 10)}</td>
      <td>${me.role === 'admin' && c.status === 'Unpaid' ? `<button data-act="pay" data-id="${c.id}">Mark paid</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No commissions yet. Close a deal to create one.</td></tr>'}</table></div>`;
  },

  async plans() {
    const plans = await list(collection(db, 'plans'));
    const clients = me.role === 'admin' ? await list(collection(db, 'clients')) : null; // linked clients are billing data: admin only
    $('#main').innerHTML = `<h2>Maintenance plans</h2><div class="cards">${plans.map((p) => `<article class="plan"><h3>${esc(p.name)}</h3>
      <b style="font-size:1.4rem">${scr(p.price_monthly)}<span class="muted" style="display:inline"> / month</span></b><span>${p.included_hours} included hours</span>
      <ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${clients ? `<span class="muted">${clients.filter((c) => c.plan_id === p.id).map((c) => esc(c.company_name)).join(', ') || 'No linked clients'}</span>` : ''}</article>`).join('') || '<p class="muted">No plans yet. Add documents to the "plans" collection.</p>'}</div>`;
  },

  async support() {
    const rows = await list(collection(db, 'client_ops'));
    $('#main').innerHTML = `<h2>Site health & hours</h2><div class="wrap"><table><tr><th>Client</th><th>Plan</th><th>Hours</th><th>Uptime</th><th>Backups</th><th>Security</th><th></th></tr>${rows.map((c) => {
      const pct = Math.min(100, (c.hours_used / (c.included_hours || 1)) * 100);
      return `<tr><td>${esc(c.company_name)}</td><td>${esc(c.plan_name)}</td>
        <td>${c.hours_used} / ${c.included_hours}<div class="bar"><i class="${c.hours_used > c.included_hours ? 'over' : ''}" style="width:${pct}%"></i></div></td>
        ${['uptime', 'backups', 'security'].map((k) => `<td><input type="checkbox" style="width:auto" aria-label="${k} for ${esc(c.company_name)}" data-act="health" data-id="${c.id}" data-key="${k}" ${c.site_health[k] ? 'checked' : ''}></td>`).join('')}
        <td><button data-act="hours" data-id="${c.id}">Log hours</button> <button data-act="docs" data-id="${c.id}">Documents</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No clients yet.</td></tr>'}</table></div>`;
  },

  async clients() {
    const [clients, plans] = await Promise.all([list(collection(db, 'clients')), list(collection(db, 'plans'))]);
    const planName = Object.fromEntries(plans.map((p) => [p.id, p.name]));
    const mrr = clients.reduce((s, c) => s + (c.retainer_amount || 0), 0);
    window.__plans = plans;
    $('#main').innerHTML = `<div class="toolbar"><h2>Clients & billing</h2><button class="primary" data-act="new-client">Add client</button></div>
      <div class="stats"><div><b>${scr(mrr)}</b><span class="muted">Monthly recurring revenue</span></div><div><b>${clients.filter((c) => c.payment_status === 'Overdue').length}</b><span class="muted">Overdue</span></div><div><b>${clients.length}</b><span class="muted">Clients</span></div></div>
      <div class="wrap"><table><tr><th>Company</th><th>Plan</th><th>Retainer</th><th>Renews</th><th>Payment</th><th></th></tr>${clients.map((c) => `
      <tr><td>${esc(c.company_name)}<span class="muted">${esc(c.email)}</span></td><td>${esc(planName[c.plan_id] || c.plan_id)}</td><td>${scr(c.retainer_amount)}</td><td>${esc(c.next_renewal_date)}</td>
      <td><select data-act="pay-status" data-id="${c.id}">${['Paid', 'Pending', 'Overdue'].map((s) => `<option ${s === c.payment_status ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td><button data-act="docs" data-id="${c.id}">Documents</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No clients yet.</td></tr>'}</table></div>`;
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

const actions = {
  async docs(el) { await openDocs(el.dataset.id); },
  async 'new-lead'() {
    const f = await ask('New lead', [{ name: 'company_name', label: 'Company' }, { name: 'contact_person', label: 'Contact person' }, { name: 'estimated_value', label: 'Estimated value (SCR)', type: 'number' },
      ...(me.role === 'admin' ? [{ name: 'sales_rep_id', label: 'Sales associate user ID' }] : [])]);
    if (!f) return;
    const r = doc(collection(db, 'leads'));
    await run(() => setDoc(r, { id: r.id, company_name: f.company_name.trim(), contact_person: f.contact_person.trim(), status: 'Prospect',
      estimated_value: Number(f.estimated_value), sales_rep_id: me.role === 'admin' ? f.sales_rep_id.trim() : me.uid, created_at: now(), updated_at: now() }));
  },
  async move(el) { await run(() => updateDoc(ref('leads', el.dataset.id), { status: el.value, updated_at: now() })); },

  // Closing = one atomic batch: lead -> Closed, client + client_ops, commission (retainer x rate), rep balance.
  async close(el) {
    const id = el.dataset.id;
    const [plans, settings, leadSnap] = await Promise.all([list(collection(db, 'plans')), getDoc(ref('settings', 'agency')), getDoc(ref('leads', id))]);
    if (!plans.length) return toast('Add a maintenance plan first.');
    const lead = leadSnap.data();
    const f = await ask('Close deal', [
      { name: 'planId', label: 'Maintenance plan', options: plans.map((p) => [p.id, `${p.name} (${scr(p.price_monthly)})`]) },
      ...(me.role === 'admin' ? [{ name: 'retainerAmount', label: 'Custom monthly retainer (SCR, optional)', type: 'number', opt: true }] : []),
      { name: 'contactEmail', label: 'Client email', type: 'email' }]);
    if (!f) return;
    const plan = plans.find((p) => p.id === f.planId);
    const retainer = me.role === 'admin' && f.retainerAmount ? Number(f.retainerAmount) : plan.price_monthly; // sales close at list price
    const rate = settings.exists() ? Number(settings.data().commission_rate ?? 0.1) : 0.1;
    const amount = r2(retainer * rate);
    const repRef = ref('users', lead.sales_rep_id);
    const rep = (await getDoc(repRef)).data() || {};
    const cRef = doc(collection(db, 'clients'));
    const t = now(), health = { uptime: false, backups: false, security: false };
    const b = writeBatch(db);
    b.update(ref('leads', id), { status: 'Closed', closed_at: t, updated_at: t, client_id: cRef.id });
    b.set(cRef, { id: cRef.id, lead_id: id, company_name: lead.company_name, contact_person: lead.contact_person, email: f.contactEmail.trim(), plan_id: plan.id,
      retainer_amount: retainer, next_renewal_date: nextMonth(), payment_status: 'Pending', hours_used: 0, site_health: health, created_at: t, updated_at: t });
    b.set(ref('client_ops', cRef.id), { id: cRef.id, company_name: lead.company_name, plan_id: plan.id, plan_name: plan.name, included_hours: plan.included_hours, hours_used: 0, site_health: health, updated_at: t });
    b.set(ref('commissions', id), { id, lead_id: id, sales_rep_id: lead.sales_rep_id, amount, status: 'Unpaid', created_at: t });
    b.update(repRef, { pending_commission: r2((rep.pending_commission || 0) + amount), last_commission_id: id });
    await run(() => b.commit());
    toast(`Deal closed. Commission booked: ${scr(amount)}`);
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

  async 'pay-status'(el) { await run(() => updateDoc(ref('clients', el.dataset.id), { payment_status: el.value, updated_at: now() })); },
  async health(el) { await run(() => updateDoc(ref('client_ops', el.dataset.id), { [`site_health.${el.dataset.key}`]: el.checked, updated_at: now() })); },

  async hours(el) {
    const f = await ask('Log maintenance hours', [{ name: 'hoursSpent', label: 'Hours (steps of 0.25)', type: 'number' }, { name: 'description', label: 'What did you do?' }]);
    if (!f) return;
    const h = Number(f.hoursSpent);
    if (!(h > 0 && h <= 24 && h % 0.25 === 0)) return toast('Log hours between 0.25 and 24, in steps of 0.25.');
    const oRef = ref('client_ops', el.dataset.id);
    const o = (await getDoc(oRef)).data();
    const lRef = doc(collection(db, 'maintenance_logs'));
    const b = writeBatch(db);
    b.set(lRef, { id: lRef.id, client_id: el.dataset.id, developer_id: me.uid, hours_spent: h, description: f.description.trim(), date: now().slice(0, 10) });
    b.update(oRef, { hours_used: o.hours_used + h, last_log_id: lRef.id, updated_at: now() });
    await run(() => b.commit());
    toast(`Logged. ${o.hours_used + h} of ${o.included_hours} hours used.`);
  },

  async 'new-client'() {
    const plans = window.__plans || [];
    if (!plans.length) return toast('Add a maintenance plan first.');
    const f = await ask('Add client', [{ name: 'company_name', label: 'Company' }, { name: 'contact_person', label: 'Contact person' }, { name: 'email', label: 'Email', type: 'email' },
      { name: 'plan_id', label: 'Plan', options: plans.map((p) => [p.id, p.name]) }, { name: 'retainer_amount', label: 'Monthly retainer (SCR)', type: 'number' }, { name: 'next_renewal_date', label: 'Next renewal', type: 'date' }]);
    if (!f) return;
    const plan = plans.find((p) => p.id === f.plan_id);
    const cRef = doc(collection(db, 'clients'));
    const t = now(), health = { uptime: false, backups: false, security: false };
    const b = writeBatch(db);
    b.set(cRef, { id: cRef.id, company_name: f.company_name.trim(), contact_person: f.contact_person.trim(), email: f.email.trim(), plan_id: plan.id, retainer_amount: Number(f.retainer_amount),
      next_renewal_date: f.next_renewal_date, payment_status: 'Pending', hours_used: 0, site_health: health, created_at: t, updated_at: t });
    b.set(ref('client_ops', cRef.id), { id: cRef.id, company_name: f.company_name.trim(), plan_id: plan.id, plan_name: plan.name, included_hours: plan.included_hours, hours_used: 0, site_health: health, updated_at: t });
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

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || ['SELECT', 'INPUT'].includes(el.tagName)) return;
  try { await actions[el.dataset.act](el); await render(); } catch { /* toast already shown */ }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  try { await actions[el.dataset.act](el); await render(); } catch { await render(); }
});

/* ---------------------------------- shell ---------------------------------- */
async function render() {
  const allowed = NAV.filter((n) => n[2].includes(me.role));
  const route = location.hash.slice(1);
  const current = allowed.find((n) => n[0] === route) || allowed[0];
  $('#nav').innerHTML = allowed.map((n) => `<a href="#${n[0]}" ${n === current ? 'aria-current="page"' : ''}>${n[1]}</a>`).join('');
  try { await views[current[0]](); }
  catch (e) { console.error(e); $('#main').innerHTML = '<p class="muted">Could not load this page. Check your connection and try again.</p>'; }
}
window.addEventListener('hashchange', () => me && render());

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
  render();
});
