// لوحة المالك (HTML/JS) — نفس قاعدة Firebase بتاعة تطبيق الكاشير
import {
  configured, firebaseConfig, auth, db, $, $$, esc, fmtMoney, fmtInt, fmtDateTime, timeAgo,
  toast, startOfDay,
} from '../common.js';
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  collection, doc, query, where, orderBy, limit, onSnapshot, getDocs, setDoc, updateDoc,
  runTransaction, writeBatch, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const root = $('#app');
const LOW = 5;                       // مخزون منخفض
const STALE = 15 * 60 * 1000;        // جهاز غير متصل بعد 15 دقيقة
let unsubs = [], unsubBadge = null, main = null;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

if (!configured) {
  root.innerHTML = '<div class="login"><div class="card"><h2>Firebase مش متضبط</h2><p>افتح <code>firebase-config.js</code> والصق إعدادات تطبيق الويب.</p></div></div>';
} else {
  onAuthStateChanged(auth, (u) => (u ? gate(u) : showLogin()));
}

// ------------------------------------------------------------------- أدوات
const toDate = (v) => (v && v.toDate ? v.toDate() : v instanceof Date ? v : null);
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const invOf = (d) => ({ ...d, createdAt: toDate(d.createdAt) || new Date(), syncedAt: toDate(d.syncedAt),
  total: Number(d.total) || 0, conflicts: d.conflicts || [], items: d.items || [] });
const listen = (q, cb) => { unsubs.push(onSnapshot(q, cb, (e) => {
  main.innerHTML = `<p class="neg">خطأ في تحميل البيانات: ${esc(e.code || e.message)}</p>`; })); };
const pill = (t, c) => `<span class="pill ${c}">${esc(t)}</span>`;
const table = (heads, body) => `<div class="scroll"><table class="tbl"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
const me = () => auth.currentUser;
const meLabel = () => me().email || me().uid;
const CONFLICT_LABEL = { insufficient_stock: 'مخزون غير كافٍ', price_changed: 'السعر اتغيّر', product_missing: 'منتج محذوف' };
const MOVE_LABEL = { sale: 'بيع', initial: 'رصيد افتتاحي', receive: 'استلام بضاعة', adjustment: 'تسوية جرد' };

async function run(fn, ok) {
  try { await fn(); if (ok) toast(ok); } catch (e) { toast(`فشل: ${e.message || e.code}`, true); }
}
function dialog(html) {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d); d.showModal(); return d;
}
function formDialog(title, fields, submitLabel, onSubmit) {
  const d = dialog(`<form method="dialog" id="fd"><h3 style="margin-top:0">${esc(title)}</h3>${fields}
    <div class="row gap"><button class="btn grow">${esc(submitLabel)}</button>
    <button type="button" class="btn sec" id="fx">إلغاء</button></div></form>`);
  $('#fx', d).onclick = () => d.close();
  $('#fd', d).onsubmit = async (e) => {
    e.preventDefault();
    try { await onSubmit(new FormData(e.target)); d.close(); } catch (err) { toast(`فشل: ${err.message || err.code}`, true); }
  };
  return d;
}

// ------------------------------------------------------------------- دخول
function showLogin(err = '') {
  cleanup();
  root.innerHTML = `<form class="login" id="lf"><div class="center" style="font-size:56px">📊</div>
    <h2 class="center">لوحة المالك</h2>
    <label>البريد الإلكتروني</label><input type="email" id="em" dir="ltr" required>
    <label>كلمة المرور</label><input type="password" id="pw" dir="ltr" required>
    <p class="neg center" id="le">${esc(err)}</p><button class="btn block">دخول</button></form>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try { await signInWithEmailAndPassword(auth, $('#em').value.trim(), $('#pw').value); }
    catch (x) {
      $('#le').textContent = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(x.code)
        ? 'البريد أو كلمة المرور غلط.' : `فشل الدخول (${x.code})`;
    }
  };
}

let profileUnsub = null;
function gate(u) {
  if (profileUnsub) profileUnsub();
  profileUnsub = onSnapshot(doc(db, 'users', u.uid), (d) => {
    const p = d.exists() ? d.data() : null;
    if (!p) return denied('الحساب مش مسجّل في جدول المستخدمين (users).');
    if (p.active !== true || p.role !== 'owner') return denied('الدخول للوحة مسموح للمالك فقط.');
    if (!main) showShell(p);
  }, (e) => denied(`تعذّر التحقق من الصلاحيات: ${e.code}`));
}
function denied(msg) {
  cleanup();
  root.innerHTML = `<div class="login center"><div style="font-size:56px">🔒</div><p>${esc(msg)}</p>
    <button class="btn block" id="lo">تسجيل الخروج</button></div>`;
  $('#lo').onclick = () => signOut(auth);
}
function cleanup() {
  unsubs.forEach((u) => u()); unsubs = [];
  if (unsubBadge) { unsubBadge(); unsubBadge = null; }
  main = null;
}

// ------------------------------------------------------------------- الهيكل
const ROUTES = {
  overview: ['📊', 'نظرة عامة', pageOverview],
  invoices: ['🧾', 'الفواتير', pageInvoices],
  inventory: ['📦', 'المخزون', pageInventory],
  movements: ['↕️', 'حركات المخزون', pageMovements],
  conflicts: ['⚠️', 'المزامنة والتعارضات', pageConflicts],
  devices: ['📱', 'الأجهزة', pageDevices],
  users: ['👥', 'المستخدمون', pageUsers],
  shop: ['🏪', 'بيانات المحل', pageShop],
};

function showShell(profile) {
  root.innerHTML = `<div class="dash"><nav class="side"><h2>${esc(profile.name || 'المالك')}</h2>
    ${Object.entries(ROUTES).map(([k, [i, t]]) => `<a href="#/${k}" data-r="${k}">${i} ${t}<span class="badge hide" id="b-${k}"></span></a>`).join('')}
    <a href="#" id="lo">🚪 تسجيل الخروج</a></nav><div class="main" id="main"></div></div>`;
  main = $('#main');
  $('#lo').onclick = (e) => { e.preventDefault(); signOut(auth); };
  unsubBadge = onSnapshot(query(collection(db, 'invoices'), where('status', '==', 'conflict'), where('resolved', '==', false)),
    (s) => { const b = $('#b-conflicts'); if (b) { b.textContent = s.size; b.classList.toggle('hide', !s.size); } });
  window.onhashchange = navigate;
  navigate();
}

function navigate() {
  if (!main) return;
  unsubs.forEach((u) => u()); unsubs = [];
  const key = (location.hash.replace('#/', '') || 'overview');
  const r = ROUTES[key] || ROUTES.overview;
  $$('.side a[data-r]').forEach((a) => a.classList.toggle('on', a.dataset.r === (ROUTES[key] ? key : 'overview')));
  main.onclick = null;
  main.innerHTML = `<h1>${r[1]}</h1><div id="page"><p class="muted">جاري التحميل…</p></div>`;
  r[2]($('#page'));
}

// =================================================================== نظرة عامة
function pageOverview(el) {
  const from = new Date(startOfDay().getTime() - 29 * 86400000);
  let inv = null, prods = null, devs = null;
  const draw = () => {
    if (!inv || !prods || !devs) return;
    const now = Date.now(), t0 = startOfDay().getTime();
    const today = inv.filter((i) => i.createdAt.getTime() >= t0);
    const sum = (a) => a.reduce((s, i) => s + i.total, 0);
    const month = sum(inv), avg = inv.length ? month / inv.length : 0;
    const days = [...Array(7)].map((_, k) => t0 - (6 - k) * 86400000);
    const per = days.map((d) => sum(inv.filter((i) => { const x = i.createdAt.getTime(); return x >= d && x < d + 86400000; })));
    const max = Math.max(...per, 1);
    const byP = {}, byC = {};
    inv.forEach((i) => {
      i.items.forEach((it) => { const o = byP[it.productId] || (byP[it.productId] = { name: it.name, qty: 0, rev: 0 }); o.qty += it.qty; o.rev += it.qty * it.unitPrice; });
      const k = i.cashierName || i.cashierId; byC[k] = (byC[k] || 0) + i.total;
    });
    const top = Object.values(byP).sort((a, b) => b.rev - a.rev).slice(0, 7);
    const cash = Object.entries(byC).sort((a, b) => b[1] - a[1]).slice(0, 7);
    const active = prods.filter((p) => !p.deleted);
    const low = active.filter((p) => (p.stock || 0) <= LOW).length;
    const open = inv.filter((i) => i.status === 'conflict' && !i.resolved).length;
    const stale = devs.filter((d) => !d.blocked && (!toDate(d.lastSeenAt) || now - toDate(d.lastSeenAt) > STALE)).length;
    const pend = devs.reduce((s, d) => s + (d.pendingInvoices || 0), 0);
    const st = (l, v, h = '') => `<div class="card stat"><div class="l">${l}</div><div class="v">${v}</div><div class="h">${h}</div></div>`;
    el.innerHTML = `<div class="grid">
      ${st('مبيعات اليوم', fmtMoney(sum(today)), `${today.length} فاتورة`)}
      ${st('مبيعات آخر 30 يوم', fmtMoney(month), `متوسط الفاتورة ${fmtMoney(avg)}`)}
      ${st('منتجات مخزونها منخفض', fmtInt(low), `من ${active.length} منتج`)}
      ${st('تعارضات مفتوحة', fmtInt(open))}
      ${st('أجهزة غير متصلة', fmtInt(stale), `من ${devs.length} جهاز`)}
      ${st('فواتير لسه على الأجهزة', fmtInt(pend), 'لم تُزامَن بعد')}</div>
      <div class="card"><b>المبيعات — آخر 7 أيام</b><div class="bars gap">
        ${days.map((d, k) => { const dt = new Date(d); return `<div class="bar"><span>${per[k] ? fmtInt(per[k]) : ''}</span><i style="height:${Math.max(2, per[k] / max * 80)}%"></i><span>${dt.getDate()}/${dt.getMonth() + 1}</span></div>`; }).join('')}
      </div></div>
      <div class="two">
        <div class="card"><b>أكثر المنتجات مبيعاً (30 يوم)</b>${top.length ? top.map((t) => `<div class="kv"><span>${esc(t.name)}</span><span class="muted">${fmtInt(t.qty)} قطعة • ${fmtMoney(t.rev)}</span></div>`).join('') : '<p class="muted">لا توجد مبيعات بعد</p>'}</div>
        <div class="card"><b>مبيعات الكاشير (30 يوم)</b>${cash.length ? cash.map(([n, v]) => `<div class="kv"><span>${esc(n)}</span><span class="muted">${fmtMoney(v)}</span></div>`).join('') : '<p class="muted">لا توجد مبيعات بعد</p>'}</div>
      </div>
      <p class="muted" style="font-size:12px">الأرقام من الفواتير اللي وصلت للسيرفر فقط؛ المعلّقة على الأجهزة تظهر بعد المزامنة.</p>`;
  };
  listen(query(collection(db, 'invoices'), where('createdAt', '>=', Timestamp.fromDate(from)), orderBy('createdAt', 'desc'), limit(3000)),
    (s) => { inv = rows(s).map(invOf); draw(); });
  listen(collection(db, 'products'), (s) => { prods = rows(s); draw(); });
  listen(collection(db, 'devices'), (s) => { devs = rows(s); draw(); });
}

// =================================================================== الفواتير
function invoiceDialog(i) {
  const d = dialog(`<h3 style="margin-top:0">فاتورة ${esc(i.number)}</h3>
    <div class="kv"><span>التاريخ</span><span>${fmtDateTime(i.createdAt)}</span></div>
    <div class="kv"><span>وصلت للسيرفر</span><span>${fmtDateTime(i.syncedAt)}</span></div>
    <div class="kv"><span>الكاشير</span><span>${esc(i.cashierName)}</span></div>
    <div class="kv"><span>الجهاز</span><span>${esc(i.deviceCode)}</span></div>
    <div class="gap">${i.items.map((x) => `<div class="kv"><span>${x.qty} × ${esc(x.name)}</span><b>${fmtMoney(x.qty * x.unitPrice)}</b></div>`).join('')}</div>
    <div class="kv"><b>الإجمالي</b><b>${fmtMoney(i.total)}</b></div>
    ${i.conflicts.length ? `<p class="neg">التعارضات:</p>${i.conflicts.map((c) => `<div>• ${esc(CONFLICT_LABEL[c.type] || c.type)}: ${esc(c.detail)}</div>`).join('')}
      ${i.resolved ? `<p class="muted">تم الحل: ${esc(i.resolutionNote || '')}</p>` : ''}` : ''}
    <button class="btn sec block gap" id="cl">إغلاق</button>`);
  $('#cl', d).onclick = () => d.close();
}

function pageInvoices(el) {
  let days = 7, status = 'all', q = '', all = [];
  el.innerHTML = `<div class="tools">
    <select id="dy"><option value="1">اليوم</option><option value="7" selected>7 أيام</option><option value="30">30 يوم</option></select>
    <select id="st"><option value="all">كل الحالات</option><option value="confirmed">معتمدة</option><option value="conflict">فيها تعارض</option></select>
    <input id="q" placeholder="رقم فاتورة / كاشير / جهاز"></div><div id="sum" class="muted" style="margin-bottom:8px"></div><div id="tb"></div>`;
  const draw = () => {
    const list = all.filter((i) => (status === 'all' || i.status === status)
      && (!q || `${i.number} ${i.cashierName} ${i.deviceCode}`.toLowerCase().includes(q)));
    $('#sum').innerHTML = `<b>${fmtInt(list.length)} فاتورة • الإجمالي ${fmtMoney(list.reduce((s, i) => s + i.total, 0))}</b>`;
    $('#tb').innerHTML = list.length ? table(['الرقم', 'التاريخ', 'الكاشير', 'الجهاز', 'القطع', 'الإجمالي', 'الحالة'],
      list.slice(0, 500).map((i) => `<tr class="click" data-id="${esc(i.id)}"><td>${esc(i.number)}</td><td>${fmtDateTime(i.createdAt)}</td>
        <td>${esc(i.cashierName)}</td><td>${esc(i.deviceCode)}</td><td>${i.itemCount || ''}</td><td>${fmtMoney(i.total)}</td>
        <td>${i.status === 'conflict' ? (i.resolved ? pill('تعارض (اتحل)', 'gr') : pill('تعارض', 'er')) : pill('معتمدة', 'ok')}</td></tr>`).join(''))
      : '<p class="muted center">لا توجد فواتير</p>';
  };
  const sub = () => {
    unsubs.forEach((u) => u()); unsubs = [];
    const from = new Date(startOfDay().getTime() - (days - 1) * 86400000);
    listen(query(collection(db, 'invoices'), where('createdAt', '>=', Timestamp.fromDate(from)), orderBy('createdAt', 'desc'), limit(3000)),
      (s) => { all = rows(s).map(invOf); draw(); });
  };
  $('#dy').onchange = (e) => { days = +e.target.value; sub(); };
  $('#st').onchange = (e) => { status = e.target.value; draw(); };
  $('#q').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  main.onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) invoiceDialog(all.find((x) => x.id === tr.dataset.id)); };
  sub();
}

// =================================================================== المخزون
function pageInventory(el) {
  let all = [], q = '', lowOnly = false, archived = false;
  el.innerHTML = `<div class="tools"><button class="btn" id="add">+ منتج جديد</button>
    <input id="q" placeholder="اسم أو باركود">
    <label class="row" style="margin:0"><input type="checkbox" id="lo" style="width:auto"> المنخفض فقط</label>
    <label class="row" style="margin:0"><input type="checkbox" id="ar" style="width:auto"> إظهار المؤرشف</label></div><div id="tb"></div>`;
  const draw = () => {
    const list = all.filter((p) => (archived || !p.deleted) && (!lowOnly || (p.stock || 0) <= LOW)
      && (!q || `${p.name} ${p.barcode}`.toLowerCase().includes(q)));
    $('#tb').innerHTML = list.length ? table(['المنتج', 'الباركود', 'السعر', 'المخزون', ''], list.map((p) => {
      const s = p.stock || 0;
      return `<tr><td>${esc(p.name)} ${p.deleted ? pill('مؤرشف', 'gr') : ''}</td><td dir="ltr">${esc(p.barcode)}</td><td>${fmtMoney(p.price)}</td>
        <td class="${s < 0 ? 'neg' : s <= LOW ? 'low' : ''}">${s}</td>
        <td>${p.deleted ? '' : `<button class="btn sm sec" data-a="stock" data-id="${p.id}">المخزون</button> `}
        <button class="btn sm sec" data-a="edit" data-id="${p.id}">تعديل</button>
        <button class="btn sm red" data-a="arc" data-id="${p.id}">${p.deleted ? 'استرجاع' : 'أرشفة'}</button></td></tr>`;
    }).join('')) : '<p class="muted center">لا توجد منتجات</p>';
  };
  $('#q').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  $('#lo').onchange = (e) => { lowOnly = e.target.checked; draw(); };
  $('#ar').onchange = (e) => { archived = e.target.checked; draw(); };
  $('#add').onclick = () => productDialog(null);
  main.onclick = (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const p = all.find((x) => x.id === b.dataset.id);
    if (b.dataset.a === 'edit') productDialog(p);
    else if (b.dataset.a === 'stock') stockDialog(p);
    else if (confirm(p.deleted ? 'استرجاع المنتج؟' : 'هيختفي من الأجهزة (الفواتير القديمة ما بتتأثرش). أرشفة؟'))
      run(() => updateDoc(doc(db, 'products', p.id), { deleted: !p.deleted, updatedAt: serverTimestamp() }));
  };
  listen(collection(db, 'products'), (s) => { all = rows(s).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')); draw(); });
}

function productDialog(p) {
  formDialog(p ? `تعديل ${p.name}` : 'منتج جديد', `
    <label>اسم المنتج</label><input name="name" required value="${esc(p?.name || '')}">
    <label>الباركود</label><input name="barcode" dir="ltr" required value="${esc(p?.barcode || '')}">
    <label>السعر</label><input name="price" type="number" step="0.01" min="0" required value="${p ? p.price : ''}">
    ${p ? '' : '<label>رصيد افتتاحي</label><input name="stock" type="number" step="1" value="0">'}`,
  'حفظ', async (f) => {
    const name = f.get('name').trim(), barcode = f.get('barcode').trim(), price = parseFloat(f.get('price'));
    if (p) { await updateDoc(doc(db, 'products', p.id), { name, barcode, price, updatedAt: serverTimestamp() }); return; }
    const dup = await getDocs(query(collection(db, 'products'), where('barcode', '==', barcode), where('deleted', '==', false), limit(1)));
    if (!dup.empty) throw new Error(`فيه منتج بنفس الباركود: ${dup.docs[0].data().name}`);
    const stock = parseInt(f.get('stock') || '0', 10) || 0;
    const ref = doc(collection(db, 'products'));
    const batch = writeBatch(db);
    batch.set(ref, { name, barcode, price, stock, deleted: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: me().uid });
    if (stock) batch.set(doc(collection(db, 'stockMovements')), { productId: ref.id, productName: name, type: 'initial', delta: stock,
      balanceAfter: stock, userId: me().uid, userName: meLabel(), createdAt: serverTimestamp() });
    await batch.commit();
    toast('تم الحفظ');
  });
}

function stockDialog(p) {
  formDialog(`مخزون ${p.name} (الحالي ${p.stock || 0})`, `
    <label>نوع العملية</label><select name="type"><option value="receive">استلام بضاعة (إضافة)</option><option value="adjustment">تسوية جرد (الرصيد الفعلي)</option></select>
    <label>الكمية / الرصيد الفعلي</label><input name="v" type="number" step="1" required>
    <label>ملاحظة (اختياري)</label><input name="note">`,
  'تسجيل', async (f) => {
    const type = f.get('type'), v = parseInt(f.get('v'), 10), note = f.get('note').trim() || null;
    if (Number.isNaN(v)) throw new Error('رقم غير صحيح');
    const ref = doc(db, 'products', p.id), mref = doc(collection(db, 'stockMovements'));
    await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists()) throw new Error('المنتج مش موجود');
      const cur = Number(s.data().stock) || 0;
      const delta = type === 'adjustment' ? v - cur : v;
      const after = cur + delta;
      tx.update(ref, { stock: after, updatedAt: serverTimestamp() });
      tx.set(mref, { productId: p.id, productName: s.data().name, type, delta, balanceAfter: after, note,
        userId: me().uid, userName: meLabel(), createdAt: serverTimestamp() });
    });
    toast('تم تسجيل الحركة');
  });
}

// =================================================================== حركات المخزون
function pageMovements(el) {
  let all = [], type = 'all';
  el.innerHTML = `<div class="tools"><select id="ty"><option value="all">كل الأنواع</option>
    ${Object.entries(MOVE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div><div id="tb"></div>`;
  const draw = () => {
    const list = all.filter((m) => type === 'all' || m.type === type);
    $('#tb').innerHTML = list.length ? table(['التاريخ', 'المنتج', 'النوع', 'الكمية', 'الرصيد بعد', 'بواسطة', 'مرجع / ملاحظة'],
      list.map((m) => `<tr><td>${fmtDateTime(toDate(m.createdAt) || new Date())}</td><td>${esc(m.productName)}</td><td>${esc(MOVE_LABEL[m.type] || m.type)}</td>
        <td class="${m.delta < 0 ? 'neg' : ''}" dir="ltr" style="color:${m.delta < 0 ? '' : 'var(--ok)'}"><b>${m.delta > 0 ? '+' : ''}${m.delta}</b></td>
        <td>${m.balanceAfter ?? '—'}</td><td>${esc(m.userName)}</td><td>${esc(m.invoiceNumber || m.note || '')}</td></tr>`).join(''))
      : '<p class="muted center">لا توجد حركات</p>';
  };
  $('#ty').onchange = (e) => { type = e.target.value; draw(); };
  listen(query(collection(db, 'stockMovements'), orderBy('createdAt', 'desc'), limit(300)), (s) => { all = rows(s); draw(); });
}

// =================================================================== المزامنة والتعارضات
function pageConflicts(el) {
  let devs = null, cons = null;
  const draw = () => {
    if (!devs || !cons) return;
    const online = (d) => toDate(d.lastSeenAt) && Date.now() - toDate(d.lastSeenAt) < STALE;
    el.innerHTML = `<h3>حالة الأجهزة</h3>
      ${devs.length ? `<div class="card">${devs.map((d) => `<div class="kv"><span>${online(d) ? '☁️✔' : '☁️✖'} ${esc(d.name)} • ${esc(d.userName)}<br>
        <span class="muted">آخر مزامنة: ${fmtDateTime(toDate(d.lastSyncAt))} (${timeAgo(toDate(d.lastSyncAt))})</span></span>
        <span>${d.pendingInvoices ? pill(`${d.pendingInvoices} معلّقة`, 'wa') : ''} ${d.conflictInvoices ? pill(`${d.conflictInvoices} تعارض`, 'er') : ''} ${d.blocked ? pill('محظور', 'er') : ''}</span></div>`).join('')}</div>`
        : '<p class="muted">لا توجد أجهزة مسجّلة بعد</p>'}
      <h3>تعارضات تنتظر قرارك</h3>
      <p class="muted" style="font-size:12px">البيعة حصلت فعلاً في المحل فالفاتورة معتمدة والمخزون اتخصم. التعارض تنبيه لمراجعة المخزون أو السعر.</p>
      ${cons.length ? cons.map((i) => `<div class="card"><b>فاتورة ${esc(i.number)} • ${fmtDateTime(i.createdAt)} • ${esc(i.cashierName)}</b> <span style="float:left">${fmtMoney(i.total)}</span>
        <div class="gap">${i.conflicts.map((c) => `<div>${pill(CONFLICT_LABEL[c.type] || c.type, 'er')} ${esc(c.detail)}</div>`).join('')}</div>
        <div class="row gap"><button class="btn sec sm" data-a="view" data-id="${i.id}">تفاصيل الفاتورة</button>
        <button class="btn sm" data-a="res" data-id="${i.id}">تم الحل</button></div></div>`).join('') : '<p class="muted center">مفيش تعارضات مفتوحة 👌</p>'}`;
  };
  main.onclick = (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = cons.find((x) => x.id === b.dataset.id);
    if (b.dataset.a === 'view') return invoiceDialog(i);
    formDialog(`قفل تعارض ${i.number}`, '<label>اللي اتعمل (مثلاً: ضبطت المخزون بالجرد)</label><input name="n">', 'تأكيد', async (f) => {
      await updateDoc(doc(db, 'invoices', i.id), { resolved: true, resolvedBy: meLabel(), resolvedAt: serverTimestamp(),
        resolutionNote: f.get('n').trim() || 'تمت المراجعة' });
      toast('تم قفل التعارض');
    });
  };
  listen(collection(db, 'devices'), (s) => { devs = rows(s).sort((a, b) => (toDate(b.lastSeenAt) || 0) - (toDate(a.lastSeenAt) || 0)); draw(); });
  listen(query(collection(db, 'invoices'), where('status', '==', 'conflict'), where('resolved', '==', false)),
    (s) => { cons = rows(s).map(invOf).sort((a, b) => b.createdAt - a.createdAt); draw(); });
}

// =================================================================== الأجهزة
function pageDevices(el) {
  let all = [];
  const draw = () => {
    el.innerHTML = all.length ? table(['الجهاز', 'آخر مستخدم', 'الحالة', 'آخر اتصال', 'معلّقة', 'النظام / الإصدار', ''], all.map((d) => {
      const on = toDate(d.lastSeenAt) && Date.now() - toDate(d.lastSeenAt) < STALE;
      return `<tr><td>${esc(d.name)} (${esc(d.code)})</td><td>${esc(d.userName)}</td>
        <td>${d.blocked ? pill('محظور', 'er') : on ? pill('متصل', 'ok') : pill('غير متصل', 'wa')}</td>
        <td>${timeAgo(toDate(d.lastSeenAt))}</td><td>${d.pendingInvoices || 0}</td><td>${esc(d.platform)} / ${esc(d.appVersion)}</td>
        <td><button class="btn sm sec" data-a="ren" data-id="${d.id}">الاسم</button>
        <button class="btn sm ${d.blocked ? '' : 'red'}" data-a="blk" data-id="${d.id}">${d.blocked ? 'فك الحظر' : 'حظر'}</button></td></tr>`;
    }).join('')) : '<p class="muted center">الأجهزة بتظهر هنا أوتوماتيك أول ما تسجّل دخول وتزامن من التطبيق</p>';
  };
  main.onclick = (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const d = all.find((x) => x.id === b.dataset.id);
    if (b.dataset.a === 'ren') {
      formDialog('اسم الجهاز', `<input name="n" required value="${esc(d.name)}">`, 'حفظ',
        (f) => updateDoc(doc(db, 'devices', d.id), { name: f.get('n').trim() }));
    } else if (confirm(d.blocked ? 'فك حظر الجهاز؟' : 'الجهاز هيتقفل عند أول اتصال بالنت. المبيعات المحفوظة عليه ما بتضيعش. حظر؟')) {
      run(() => updateDoc(doc(db, 'devices', d.id), { blocked: !d.blocked }));
    }
  };
  listen(collection(db, 'devices'), (s) => { all = rows(s).sort((a, b) => (toDate(b.lastSeenAt) || 0) - (toDate(a.lastSeenAt) || 0)); draw(); });
}

// =================================================================== المستخدمون
function pageUsers(el) {
  let all = [];
  el.innerHTML = '<div class="tools"><button class="btn" id="add">+ مستخدم جديد</button></div><div id="tb"></div>';
  const draw = () => {
    $('#tb').innerHTML = table(['الاسم', 'البريد', 'الدور', 'الحالة', ''], all.map((u) => {
      const self = u.id === me().uid;
      return `<tr><td>${esc(u.name)}</td><td dir="ltr">${esc(u.email)}</td><td>${u.role === 'owner' ? pill('مالك', 'bl') : pill('كاشير', 'gr')}</td>
        <td>${u.active ? pill('مفعّل', 'ok') : pill('موقوف', 'er')}</td>
        <td><button class="btn sm sec" data-a="rst" data-id="${u.id}">رابط كلمة المرور</button>
        ${self ? '' : `<button class="btn sm sec" data-a="role" data-id="${u.id}">${u.role === 'owner' ? 'تحويل لكاشير' : 'ترقية لمالك'}</button>
        <button class="btn sm ${u.active ? 'red' : ''}" data-a="act" data-id="${u.id}">${u.active ? 'إيقاف' : 'تفعيل'}</button>`}</td></tr>`;
    }).join(''));
  };
  $('#add').onclick = () => formDialog('مستخدم جديد', `
    <label>الاسم</label><input name="name" required>
    <label>البريد الإلكتروني</label><input name="email" type="email" dir="ltr" required>
    <label>كلمة مرور (6 حروف على الأقل)</label><input name="pw" type="password" dir="ltr" minlength="6" required>
    <label>الدور</label><select name="role"><option value="cashier">كاشير</option><option value="owner">مالك</option></select>`,
  'إنشاء', async (f) => {
    // تطبيق Firebase تاني مؤقت علشان حساب المالك الحالي ما يتسجّلش خروج
    const sec = initializeApp(firebaseConfig, `sec-${Date.now()}`);
    try {
      const sa = getAuth(sec);
      const cred = await createUserWithEmailAndPassword(sa, f.get('email').trim(), f.get('pw'));
      await setDoc(doc(db, 'users', cred.user.uid), { name: f.get('name').trim(), email: f.get('email').trim(),
        role: f.get('role'), active: true, createdAt: serverTimestamp(), createdBy: me().uid });
      await signOut(sa);
      toast('تم إنشاء الحساب');
    } finally { await deleteApp(sec); }
  });
  main.onclick = (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const u = all.find((x) => x.id === b.dataset.id);
    if (b.dataset.a === 'rst') run(() => sendPasswordResetEmail(auth, u.email), `اتبعت رابط لـ ${u.email}`);
    else if (b.dataset.a === 'act') run(() => updateDoc(doc(db, 'users', u.id), { active: !u.active }));
    else if (confirm(u.role === 'owner' ? `هيبقى ${u.name} كاشير.` : `هيبقى ${u.name} مالك ويقدر يعدّل كل حاجة.`))
      run(() => updateDoc(doc(db, 'users', u.id), { role: u.role === 'owner' ? 'cashier' : 'owner' }));
  };
  listen(collection(db, 'users'), (s) => { all = rows(s).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')); draw(); });
}

// =================================================================== بيانات المحل
function pageShop(el) {
  let loaded = false;
  listen(doc(db, 'settings', 'shop'), (s) => {
    if (loaded) return; loaded = true;
    const d = s.exists() ? s.data() : {};
    const f = (n, l) => `<label>${l}</label><input name="${n}" value="${esc(d[n] || '')}">`;
    el.innerHTML = `<form class="card" id="sf" style="max-width:520px">${f('name', 'اسم المحل')}${f('addressLine1', 'العنوان (سطر 1)')}
      ${f('addressLine2', 'العنوان (سطر 2)')}${f('phoneNumber', 'الهاتف')}${f('footerText', 'رسالة أسفل الفاتورة')}
      <button class="btn block gap">حفظ</button><p class="muted" style="font-size:12px">بتنزل لكل الأجهزة أوتوماتيك وبتتطبع على الإيصال (العربي مدعوم).</p></form>`;
    $('#sf').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      run(() => setDoc(doc(db, 'settings', 'shop'), { name: fd.get('name').trim(), addressLine1: fd.get('addressLine1').trim(),
        addressLine2: fd.get('addressLine2').trim(), phoneNumber: fd.get('phoneNumber').trim(), footerText: fd.get('footerText').trim(),
        updatedAt: serverTimestamp() }), 'تم الحفظ — هتوصل للأجهزة تلقائياً');
    };
  });
}
