// المزامنة: رفع الفواتير (Transaction لكل فاتورة) + سحب المنتجات + فحص الحساب والجهاز
import {
  collection, doc, onSnapshot, getDocFromServer, setDoc, updateDoc, runTransaction,
  serverTimestamp, increment, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { auth, db, withTimeout, isNetworkError, idb } from './common.js';
import { APP_VERSION } from './firebase-config.js';
import {
  S, emit, deviceId, deviceCode, deviceName, pending, pendingCount, conflictCount,
  saveInvoice, invoiceTotal, loadInvoices,
} from './store.js';

let running = false, again = false, started = false;
let lastAccountCheck = 0, lastHeartbeat = 0;
let unsubProducts = null, unsubShop = null;
const ACCOUNT_EVERY = 5 * 60 * 1000;

// ---------------------------------------------------------------- lifecycle
export function startSync() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => { S.sync.online = true; emit(); syncNow(); });
  window.addEventListener('offline', () => { S.sync.online = false; emit(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow({ force: false });
  });
  setInterval(() => syncNow({ force: false }), 45000);
  startListeners();
  syncNow();
}

export function stopSync() {
  stopListeners();
}

function startListeners() {
  if (unsubProducts || !db) return;
  unsubProducts = onSnapshot(collection(db, 'products'), (snap) => {
    const map = new Map();
    snap.forEach((d) => {
      const m = d.data();
      if (m.deleted === true) return;
      map.set(d.id, {
        id: d.id, name: m.name || '', barcode: m.barcode || '',
        price: Number(m.price) || 0, stock: Number(m.stock) || 0,
      });
    });
    S.products = map;
    emit();
  }, (e) => console.warn('products listener', e));

  unsubShop = onSnapshot(doc(db, 'settings', 'shop'), (d) => {
    if (d.exists()) { S.shop = d.data(); idb.setMeta('shop', S.shop); emit(); }
  }, (e) => console.warn('shop listener', e));
}

function stopListeners() {
  if (unsubProducts) { unsubProducts(); unsubProducts = null; }
  if (unsubShop) { unsubShop(); unsubShop = null; }
}

// -------------------------------------------------------------------- sync
export async function syncNow({ force = true } = {}) {
  if (!auth || !auth.currentUser) return;
  if (running) { again = true; return; }
  running = true;
  S.sync.syncing = true; emit();
  try {
    do { again = false; await cycle(force); } while (again);
  } catch (e) {
    S.sync.lastError = e.code || e.message;
  } finally {
    running = false;
    S.sync.syncing = false; emit();
  }
}

async function cycle(force) {
  if (!navigator.onLine) { S.sync.online = false; emit(); return; }
  S.sync.online = true;
  try {
    const user = await checkAccount(force);
    if (!user) return;
    await pushInvoices(user);
    await heartbeat(user, force);
    pruneOld();
    S.sync.lastSyncAt = Date.now();
    S.sync.lastError = null;
  } catch (e) {
    if (isNetworkError(e)) S.sync.online = false;
    S.sync.lastError = `${e.code || e.message}`;
  }
  emit();
}

// ----------------------------------------------------------------- account
let deviceSnapExists = false;

async function checkAccount(force) {
  const due = Date.now() - lastAccountCheck > ACCOUNT_EVERY;
  if (!force && !S.locked && !due) return S.user;

  const uid = auth.currentUser.uid;
  const snap = await getDocFromServer(doc(db, 'users', uid));
  lastAccountCheck = Date.now();
  if (!snap.exists()) { lock('الحساب اتحذف من النظام.'); return null; }
  const d = snap.data();
  const user = {
    uid, email: auth.currentUser.email || '', name: d.name || auth.currentUser.email,
    role: d.role === 'owner' ? 'owner' : 'cashier', active: d.active === true,
  };
  await idb.setMeta('profile', user);
  if (!user.active) { lock('الحساب موقوف من المالك.'); return null; }

  const dev = await getDocFromServer(doc(db, 'devices', deviceId()));
  deviceSnapExists = dev.exists();
  if (dev.exists() && dev.data().blocked === true) { lock('الجهاز ده محظور من المالك.'); return null; }

  S.user = user;
  if (S.locked) { S.locked = null; startListeners(); }
  emit();
  return user;
}

function lock(reason) {
  S.locked = reason;
  stopListeners();
  emit();
}

async function heartbeat(user, force) {
  if (!force && Date.now() - lastHeartbeat < ACCOUNT_EVERY) return;
  const ref = doc(db, 'devices', deviceId());
  const base = {
    name: deviceName(), code: deviceCode(), uid: user.uid, userName: user.name,
    platform: navigator.userAgentData?.platform || navigator.platform || 'web',
    appVersion: APP_VERSION,
    lastSeenAt: serverTimestamp(), lastSyncAt: serverTimestamp(),
    pendingInvoices: pendingCount(), conflictInvoices: conflictCount(),
  };
  if (deviceSnapExists) await updateDoc(ref, base);
  else { await setDoc(ref, { ...base, blocked: false, registeredAt: serverTimestamp() }); deviceSnapExists = true; }
  lastHeartbeat = Date.now();
}

// ----------------------------------------------------------------- invoices
async function pushInvoices(user) {
  for (const inv of pending()) {
    if (inv.cashierId !== user.uid) continue; // فاتورة كاشير تاني: تتزامن لما هو يدخل
    try {
      const r = await withTimeout(pushInvoice(inv));
      await saveInvoice({ ...inv, status: r.status, conflictNotes: r.notes, lastError: null });
      emit();
    } catch (e) {
      await saveInvoice({ ...inv, attempts: (inv.attempts || 0) + 1, lastError: e.code || e.message });
      if (isNetworkError(e)) throw e;   // مفيش اتصال: وقف الدورة
      // أخطاء تانية (permission-denied...): كمّل بالباقي
    }
  }
}

/** Transaction واحدة: تقرأ المنتجات، تكشف التعارض، تكتب الفاتورة + تخصم المخزون + حركة مخزون */
function pushInvoice(inv) {
  const invRef = doc(db, 'invoices', inv.id);
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(invRef);
    if (existing.exists()) {
      // اترفعت قبل كده: ما نكرّرش الخصم
      const cs = existing.data().conflicts || [];
      return { status: cs.length ? 'conflict' : 'synced', notes: cs.map((c) => c.detail) };
    }

    const refs = inv.items.map((i) => doc(db, 'products', i.productId));
    const snaps = [];
    for (const r of refs) snaps.push(await tx.get(r));   // كل القراءات قبل الكتابة

    const conflicts = [];
    const live = new Map(); // productId -> رصيد بعد البيع
    inv.items.forEach((item, k) => {
      const d = snaps[k].exists() ? snaps[k].data() : null;
      if (!d || d.deleted === true) {
        conflicts.push({ type: 'product_missing', productId: item.productId, productName: item.name,
          detail: `المنتج "${item.name}" محذوف أو مش موجود على السيرفر` });
        return;
      }
      const stock = Number(d.stock) || 0;
      const price = Number(d.price);
      const after = stock - item.qty;
      live.set(item.productId, after);
      if (after < 0) {
        conflicts.push({ type: 'insufficient_stock', productId: item.productId, productName: item.name,
          detail: `مخزون "${item.name}" على السيرفر ${stock} وتم بيع ${item.qty} (الرصيد بقى ${after})` });
      }
      if (Number.isFinite(price) && Math.abs(price - item.unitPrice) > 0.009) {
        conflicts.push({ type: 'price_changed', productId: item.productId, productName: item.name,
          detail: `سعر "${item.name}" على السيرفر ${price.toFixed(2)} وتم البيع بـ ${item.unitPrice.toFixed(2)}` });
      }
    });

    tx.set(invRef, {
      number: inv.number, deviceId: inv.deviceId, deviceCode: inv.deviceCode,
      cashierId: inv.cashierId, cashierName: inv.cashierName,
      items: inv.items.map((i) => ({ ...i, total: i.qty * i.unitPrice })),
      itemCount: inv.items.reduce((s, i) => s + i.qty, 0),
      total: invoiceTotal(inv),
      createdAt: Timestamp.fromMillis(inv.createdAt),
      syncedAt: serverTimestamp(),
      status: conflicts.length ? 'conflict' : 'confirmed',
      conflicts, resolved: false,
    });

    inv.items.forEach((item, k) => {
      if (!live.has(item.productId)) return;
      tx.update(refs[k], { stock: increment(-item.qty), updatedAt: serverTimestamp() });
      tx.set(doc(db, 'stockMovements', `${inv.id}_${item.productId}`), {
        productId: item.productId, productName: item.name, type: 'sale',
        delta: -item.qty, balanceAfter: live.get(item.productId),
        invoiceId: inv.id, invoiceNumber: inv.number, deviceId: inv.deviceId,
        userId: inv.cashierId, userName: inv.cashierName,
        createdAt: Timestamp.fromMillis(inv.createdAt), syncedAt: serverTimestamp(),
      });
    });

    return { status: conflicts.length ? 'conflict' : 'synced', notes: conflicts.map((c) => c.detail) };
  });
}

function pruneOld() {
  const limit = Date.now() - 90 * 86400000;
  S.invoices.filter((i) => i.status === 'synced' && i.createdAt < limit)
    .forEach((i) => idb.del('invoices', i.id));
}

export { loadInvoices };
