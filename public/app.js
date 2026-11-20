// واجهة تطبيق الكاشير (PWA)
import { configured, auth, db, $, $$, esc, fmtMoney, fmtInt, fmtDateTime, toast, idb, isNetworkError } from './common.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { doc, getDocFromServer }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  S, onChange, emit, loadInvoices, addToCart, clearCart, cartTotal, completeSale, localStock,
  pendingCount, conflictCount, invoiceTotal, invoiceCount, deviceName, deviceCode, setDeviceName,
} from './store.js';
import { startSync, syncNow } from './sync.js';
import {
  printReceipt, connectPrinter, bleName, bleSupported, paperMm, setPaperMm,
} from './print.js';
import { APP_VERSION } from './firebase-config.js';

const root = $('#app');
let mode = '';          // login | shell | locked
let tab = 'sell';       // sell | inv | acc
let installEvent = null;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (mode === 'shell' && tab === 'acc') renderTab(); });

if (!configured) {
  root.innerHTML = `<div class="login"><div class="card"><h2>Firebase مش متضبط</h2>
    <p>افتح الملف <code>firebase-config.js</code> والصق إعدادات تطبيق الويب (التفاصيل في SETUP-PWA.md).</p></div></div>`;
} else {
  boot();
}

// =================================================================== boot
function boot() {
  onChange(onStateChange);
  onAuthStateChanged(auth, handleAuth);
}

async function fetchProfile(u) {
  const snap = await getDocFromServer(doc(db, 'users', u.uid));
  if (!snap.exists()) throw new Error('الحساب مش مسجّل في النظام. اطلب من المالك يضيفك من لوحة التحكم.');
  const d = snap.data();
  if (d.active !== true) throw new Error('الحساب ده موقوف. كلّم المالك.');
  return { uid: u.uid, email: u.email || '', name: d.name || u.email, role: d.role === 'owner' ? 'owner' : 'cashier', active: true };
}

async function handleAuth(u) {
  if (!u) {
    S.user = null;
    showLogin();
    return;
  }
  await loadInvoices();
  let profile = await idb.getMeta('profile');
  if (!profile || profile.uid !== u.uid) {
    try {
      profile = await fetchProfile(u);
      await idb.setMeta('profile', profile);
    } catch (e) {
      await signOut(auth);
      showLogin(isNetworkError(e) ? 'أول تسجيل دخول محتاج إنترنت.' : e.message);
      return;
    }
  }
  S.user = profile;
  S.shop = (await idb.getMeta('shop')) || S.shop;
  if (profile.active === false) S.locked = 'الحساب موقوف من المالك.';
  showShell();
  startSync();
}

function onStateChange() {
  if (!S.user) return;
  if (S.locked && mode !== 'locked') { showLocked(); return; }
  if (!S.locked && mode === 'locked') { showShell(); return; }
  if (mode !== 'shell') return;
  updateHeader();
  if (tab === 'sell') updateSell(); else renderTab();
}

// =================================================================== login
function showLogin(error = '') {
  mode = 'login';
  stopCam();
  root.innerHTML = `
    <form class="login" id="lf">
      <div class="center" style="font-size:56px">🧾</div>
      <h2 class="center">تسجيل الدخول</h2>
      <p class="center muted">أول مرة بس محتاج إنترنت</p>
      <label>البريد الإلكتروني</label>
      <input type="email" id="em" autocomplete="username" dir="ltr" required>
      <label>كلمة المرور</label>
      <input type="password" id="pw" autocomplete="current-password" dir="ltr" required>
      <p id="le" class="neg center">${esc(error)}</p>
      <button class="btn block" id="lb">دخول</button>
    </form>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#lb'); btn.disabled = true; $('#le').textContent = '';
    try {
      await signInWithEmailAndPassword(auth, $('#em').value.trim(), $('#pw').value);
    } catch (err) {
      const c = err.code || '';
      $('#le').textContent = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(c)
        ? 'البريد أو كلمة المرور غلط.'
        : c === 'auth/network-request-failed' ? 'مفيش اتصال بالإنترنت.'
        : c === 'auth/too-many-requests' ? 'محاولات كتير. استنى شوية.' : `فشل الدخول (${c})`;
      btn.disabled = false;
    }
  };
}

function showLocked() {
  mode = 'locked';
  stopCam();
  root.innerHTML = `
    <div class="login center">
      <div style="font-size:60px">🔒</div>
      <h2>الجهاز متوقف</h2>
      <p>${esc(S.locked)}</p>
      <p class="muted">الفواتير المحفوظة على الجهاز مش هتضيع، وهتتزامن لما الحساب يتفعّل.</p>
      <button class="btn block" id="retry">إعادة المحاولة</button>
      <button class="btn sec block gap" id="lo">تسجيل الخروج</button>
    </div>`;
  $('#retry').onclick = () => { syncNow(); toast('بنتأكد من حالة الحساب…'); };
  $('#lo').onclick = logout;
}

async function logout() {
  if (pendingCount() > 0) {
    toast(`فيه ${pendingCount()} فاتورة لسه ما اتزامنتش. وصّل النت وزامن الأول.`, true);
    return;
  }
  await idb.delMeta('profile');
  await signOut(auth);
  location.reload();
}

// =================================================================== shell
function showShell() {
  mode = 'shell';
  root.innerHTML = `
    <div class="app">
      <div class="topbar"><h1 id="shopname"></h1><button class="chip" id="chip"></button></div>
      <div id="view"></div>
    </div>
    <nav class="tabs">
      <button data-t="sell"><span>🛒</span>البيع</button>
      <button data-t="inv"><span>🧾</span>الفواتير والمزامنة</button>
      <button data-t="acc"><span>👤</span>حسابي</button>
    </nav>`;
  $$('.tabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.t); });
  $('#chip').onclick = () => switchTab('inv');
  switchTab(tab);
}

function switchTab(t) {
  stopCam();
  tab = t;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  updateHeader();
  if (t === 'sell') buildSell(); else renderTab();
}

function updateHeader() {
  $('#shopname').textContent = (S.shop && S.shop.name) || 'نقطة البيع';
  const s = S.sync, p = pendingCount(), c = conflictCount();
  let cls, txt;
  if (c > 0) { cls = 'er'; txt = `⚠ تعارض ${c}`; }
  else if (s.syncing) { cls = 'bl'; txt = '⟳ مزامنة…'; }
  else if (!s.online) { cls = 'wa'; txt = p ? `☁ أوفلاين • ${p}` : '☁ أوفلاين'; }
  else if (p > 0) { cls = 'wa'; txt = `⬆ معلّق ${p}`; }
  else { cls = 'ok'; txt = '✔ متزامن'; }
  const chip = $('#chip');
  chip.className = `chip ${cls}`;
  chip.textContent = txt;
}

// =================================================================== البيع
let detector = null, stream = null, scanTimer = null, html5 = null;
const lastScan = new Map();

function buildSell() {
  $('#view').innerHTML = `
    <div class="card">
      <div id="scan-box" hidden><video id="video" playsinline muted></video><div id="qr-reader"></div></div>
      <div class="row">
        <button class="btn sec" id="cam">📷 تشغيل الكاميرا</button>
        <input id="q" class="grow" placeholder="باركود أو اسم منتج (Enter)" autocomplete="off" inputmode="search">
      </div>
      <div id="results" class="results"></div>
    </div>
    <div class="card" id="cart"></div>
    <div id="checkout"></div>`;
  $('#cam').onclick = () => (stream || html5 ? stopCam() : startCam());
  const q = $('#q');
  q.oninput = renderResults;
  q.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = q.value.trim();
    if (!v) return;
    const exact = [...S.products.values()].find((p) => p.barcode === v);
    if (exact) { pick(exact.id); return; }
    const m = matches(v);
    if (m.length === 1) pick(m[0].id); else if (!m.length) toast(`مفيش منتج: ${v}`, true);
  };
  $('#results').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) pick(b.dataset.id); };
  $('#cart').onclick = (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    addToCart(b.dataset.id, b.dataset.act === 'inc' ? 1 : -1);
  };
  updateSell();
}

const matches = (v) => {
  v = v.toLowerCase();
  return [...S.products.values()]
    .filter((p) => p.name.toLowerCase().includes(v) || p.barcode.toLowerCase().includes(v)).slice(0, 8);
};

function pick(id) {
  if (S.lastInvoice) clearCart();
  addToCart(id, 1);
  const q = $('#q'); if (q) { q.value = ''; q.focus(); }
  renderResults();
}

function onCode(code) {
  const now = Date.now();
  if (now - (lastScan.get(code) || 0) < 2000) return;
  lastScan.set(code, now);
  const p = [...S.products.values()].find((x) => x.barcode === code);
  if (navigator.vibrate) navigator.vibrate(60);
  if (!p) { toast(`مفيش منتج بالباركود ${code}`, true); return; }
  if (S.lastInvoice) clearCart();
  addToCart(p.id, 1);
  toast(`أُضيف: ${p.name}`);
}

function updateSell() {
  if (!$('#cart')) return;
  renderResults(); renderCart(); renderCheckout();
}

function renderResults() {
  const box = $('#results'); if (!box) return;
  const v = ($('#q').value || '').trim();
  if (!v) { box.innerHTML = ''; return; }
  const m = matches(v);
  box.innerHTML = m.length ? m.map((p) => `
    <button data-id="${esc(p.id)}"><span>${esc(p.name)}</span>
      <span class="muted">${fmtMoney(p.price)} • مخزون ${localStock(p)}</span></button>`).join('')
    : '<p class="muted center">مفيش نتائج</p>';
}

function renderCart() {
  const box = $('#cart');
  if (S.lastInvoice) {
    box.innerHTML = S.lastInvoice.items.map((i) => `
      <div class="line"><div class="grow">${esc(i.name)}<div class="muted">${fmtMoney(i.unitPrice)} × ${i.qty}</div></div>
      <b>${fmtMoney(i.unitPrice * i.qty)}</b></div>`).join('');
    return;
  }
  if (!S.cart.length) { box.innerHTML = '<p class="muted center" style="margin:24px 0">السلة فاضية. امسح باركود أو اكتب اسم منتج.</p>'; return; }
  box.innerHTML = S.cart.map((l) => {
    const p = S.products.get(l.productId);
    if (!p) return '';
    const st = localStock(p);
    return `<div class="line">
      <div class="grow"><div>${esc(p.name)}</div>
        <div class="muted">${fmtMoney(p.price)} ${st < l.qty ? `<span class="neg"> • المخزون ${st}</span>` : ''}</div></div>
      <div class="qty"><button data-act="dec" data-id="${esc(p.id)}">−</button><b>${l.qty}</b>
        <button data-act="inc" data-id="${esc(p.id)}">+</button></div>
      <b style="min-width:84px;text-align:left">${fmtMoney(p.price * l.qty)}</b></div>`;
  }).join('');
}

function renderCheckout() {
  const box = $('#checkout');
  const inv = S.lastInvoice;
  if (inv) {
    box.innerHTML = `<div class="card center">
      <div class="big-ok">✅</div><b>تم حفظ الفاتورة ${esc(inv.number)}</b>
      <div class="total"><span>الإجمالي</span><span>${fmtMoney(invoiceTotal(inv))}</span></div>
      <button class="btn block" id="prt">🖨 طباعة الإيصال</button>
      <button class="btn sec block gap" id="new">بيع جديد</button></div>`;
    $('#prt').onclick = () => doPrint(inv);
    $('#new').onclick = () => { clearCart(); const q = $('#q'); if (q) q.focus(); };
    return;
  }
  if (!S.cart.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card">
    <div class="total"><span>الإجمالي</span><span>${fmtMoney(cartTotal())}</span></div>
    <button class="btn block" id="cp">تأكيد وطباعة</button>
    <button class="btn sec block gap" id="co">تأكيد بدون طباعة</button>
    <button class="btn red block gap" id="cc">مسح السلة</button></div>`;
  $('#cp').onclick = () => confirmSale(true);
  $('#co').onclick = () => confirmSale(false);
  $('#cc').onclick = () => { S.cart = []; emit(); };
}

async function confirmSale(print) {
  try {
    const inv = await completeSale();
    if (!inv) return;
    syncNow();
    if (print) await doPrint(inv);
  } catch (e) { toast(`فشل حفظ الفاتورة: ${e.message}`, true); }
}

async function doPrint(inv) {
  try {
    const how = await printReceipt(inv, S.shop);
    if (how === 'bluetooth') toast('اتطبعت ✔');
  } catch (e) { toast(`فشلت الطباعة: ${e.message}`, true); }
}

// ----------------------------------------------------------------- الكاميرا
function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Html5Qrcode) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('تعذّر تحميل مكتبة الكاميرا (محتاجة نت أول مرة).'));
    document.head.appendChild(s);
  });
}

async function startCam() {
  $('#scan-box').hidden = false;
  $('#cam').textContent = '⏹ إيقاف الكاميرا';
  try {
    if ('BarcodeDetector' in window) {
      detector = new BarcodeDetector();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = $('#video'); v.srcObject = stream; await v.play();
      scanTimer = setInterval(async () => {
        try { for (const c of await detector.detect(v)) onCode(c.rawValue); } catch { /* تجاهل */ }
      }, 350);
      return;
    }
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js');
    $('#video').hidden = true;
    html5 = new window.Html5Qrcode('qr-reader');
    await html5.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 160 } }, onCode, () => {});
  } catch (e) {
    toast(`تعذّر تشغيل الكاميرا: ${e.message || e}`, true);
    stopCam();
  }
}

function stopCam() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (html5) { html5.stop().catch(() => {}).finally(() => { try { html5.clear(); } catch { /* */ } }); html5 = null; }
  const box = $('#scan-box'); if (box) box.hidden = true;
  const v = $('#video'); if (v) { v.srcObject = null; v.hidden = false; }
  const b = $('#cam'); if (b) b.textContent = '📷 تشغيل الكاميرا';
}

// =============================================================== فواتير ومزامنة
function dialog(html) {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d);
  d.showModal();
  return d;
}

function renderTab() {
  const v = $('#view'); if (!v) return;
  if (tab === 'inv') renderInvoicesTab(v); else renderAccount(v);
}

function statusPill(i) {
  return i.status === 'synced' ? '<span class="pill ok">متزامنة</span>'
    : i.status === 'conflict' ? '<span class="pill er">تعارض</span>' : '<span class="pill wa">معلّقة</span>';
}

function renderInvoicesTab(v) {
  const s = S.sync;
  const title = s.syncing ? '⟳ جاري المزامنة…' : !s.online ? '☁ أوفلاين — البيع شغال والفواتير محفوظة'
    : pendingCount() ? '⬆ في انتظار المزامنة' : '✔ كل شيء متزامن';
  v.innerHTML = `
    <div class="card">
      <b>${title}</b>
      <div class="muted gap">فواتير معلّقة: ${pendingCount()} • فيها تعارض: <span class="${conflictCount() ? 'neg' : ''}">${conflictCount()}</span></div>
      <div class="muted">آخر مزامنة: ${s.lastSyncAt ? fmtDateTime(s.lastSyncAt) : '—'}</div>
      ${s.lastError ? `<div class="neg" style="font-size:12px">آخر خطأ: ${esc(s.lastError)}</div>` : ''}
      <div class="muted" style="font-size:12px">الجهاز: ${esc(deviceName())} (${deviceCode()})</div>
      <button class="btn block gap" id="sn" ${s.syncing ? 'disabled' : ''}>زامن الآن</button>
    </div>
    ${S.invoices.length ? S.invoices.map((i) => `
      <div class="inv" data-id="${esc(i.id)}">
        <div><b>${esc(i.number)}</b><div class="muted">${fmtDateTime(i.createdAt)} • ${invoiceCount(i)} قطعة</div></div>
        <div style="text-align:left"><b>${fmtMoney(invoiceTotal(i))}</b><div>${statusPill(i)}</div></div>
      </div>`).join('') : '<p class="muted center">لا توجد فواتير بعد</p>'}`;
  $('#sn').onclick = () => syncNow();
  $$('.inv', v).forEach((el) => { el.onclick = () => showInvoice(S.invoices.find((x) => x.id === el.dataset.id)); });
}

function showInvoice(i) {
  if (!i) return;
  const d = dialog(`
    <h3 style="margin-top:0">${esc(i.number)}</h3>
    <div class="muted">${fmtDateTime(i.createdAt)} • ${esc(i.cashierName)} ${statusPill(i)}</div>
    <div class="gap">${i.items.map((x) => `<div class="kv"><span>${x.qty} × ${esc(x.name)}</span><b>${fmtMoney(x.qty * x.unitPrice)}</b></div>`).join('')}</div>
    <div class="total"><span>الإجمالي</span><span>${fmtMoney(invoiceTotal(i))}</span></div>
    ${i.conflictNotes && i.conflictNotes.length ? `<p class="neg">ملاحظات التعارض (المالك هيراجعها):</p>${i.conflictNotes.map((n) => `<div>• ${esc(n)}</div>`).join('')}` : ''}
    ${i.lastError ? `<p class="muted">آخر خطأ مزامنة: ${esc(i.lastError)}</p>` : ''}
    <div class="row gap"><button class="btn grow" id="rp">🖨 إعادة طباعة</button><button class="btn sec" id="cl">إغلاق</button></div>`);
  $('#rp', d).onclick = () => doPrint(i);
  $('#cl', d).onclick = () => d.close();
}

// =================================================================== حسابي
function renderAccount(v) {
  const u = S.user;
  v.innerHTML = `
    <div class="card"><b>${esc(u.name)}</b>
      <div class="muted">${esc(u.email)} • ${u.role === 'owner' ? 'مالك' : 'كاشير'}</div></div>
    <div class="card"><b>الجهاز</b>
      <label>اسم الجهاز</label>
      <div class="row"><input id="dn" value="${esc(deviceName())}"><button class="btn sec" id="dns">حفظ</button></div></div>
    <div class="card"><b>الطابعة</b>
      <div class="muted gap">${bleName() ? `متوصلة: ${esc(bleName())}` : 'مش متوصلة — هيتم الطباعة من المتصفح'}</div>
      <label>عرض الورق</label>
      <select id="pm"><option value="58" ${paperMm() === 58 ? 'selected' : ''}>58 مم</option>
        <option value="80" ${paperMm() === 80 ? 'selected' : ''}>80 مم</option></select>
      <button class="btn sec block gap" id="bp" ${bleSupported() ? '' : 'disabled'}>🔵 ربط طابعة بلوتوث (BLE)</button>
      ${bleSupported() ? '' : '<div class="muted" style="font-size:12px">Web Bluetooth غير مدعوم في المتصفح ده (استخدم Chrome على أندرويد).</div>'}
    </div>
    ${installEvent ? '<button class="btn block" id="ins">📲 تثبيت التطبيق على الجهاز</button>' : ''}
    <button class="btn red block gap" id="lo">تسجيل الخروج</button>
    <p class="muted center">الإصدار ${esc(APP_VERSION)}</p>`;
  $('#dns').onclick = () => { setDeviceName($('#dn').value.trim() || deviceName()); toast('اتحفظ'); };
  $('#pm').onchange = (e) => setPaperMm(e.target.value);
  $('#bp').onclick = async () => {
    try { const n = await connectPrinter(); toast(`اتوصلت: ${n}`); renderTab(); }
    catch (e) { if (e.name !== 'NotFoundError') toast(e.message, true); }
  };
  const ins = $('#ins');
  if (ins) ins.onclick = async () => { installEvent.prompt(); installEvent = null; };
  $('#lo').onclick = logout;
}
