// حالة تطبيق الكاشير + الفواتير المحلية (IndexedDB)
import { idb, dayKey, round2, round3 } from './common.js';

export const S = {
  user: null,            // {uid,email,name,role,active}
  shop: null,            // بيانات المحل من السيرفر
  products: new Map(),   // id -> {id,name,barcode,price,stock}
  invoices: [],          // كل الفواتير المحلية (الأحدث أولاً)
  cart: [],              // [{productId, qty}]
  lastInvoice: null,     // آخر فاتورة اتأكدت (شاشة النجاح)
  locked: null,          // سبب القفل لو الحساب/الجهاز موقوف
  sync: { online: navigator.onLine, syncing: false, lastSyncAt: null, lastError: null },
};

const subs = new Set();
export const onChange = (fn) => subs.add(fn);
export const emit = () => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

// ---------- هوية الجهاز ----------
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));
export { uuid };

export function deviceId() {
  let id = localStorage.getItem('device_id');
  if (!id) { id = uuid(); localStorage.setItem('device_id', id); }
  return id;
}
export const deviceCode = () => deviceId().replace(/-/g, '').slice(0, 4).toUpperCase();
export const deviceName = () => localStorage.getItem('device_name') || `جهاز ${deviceCode()}`;
export const setDeviceName = (n) => localStorage.setItem('device_name', n);

// ---------- الفواتير ----------
export async function loadInvoices() {
  const all = await idb.all('invoices');
  all.sort((a, b) => b.createdAt - a.createdAt);
  S.invoices = all;
}

export async function saveInvoice(inv) {
  await idb.put('invoices', inv);
  const i = S.invoices.findIndex((x) => x.id === inv.id);
  if (i >= 0) S.invoices[i] = inv; else S.invoices.unshift(inv);
  S.invoices.sort((a, b) => b.createdAt - a.createdAt);
}

export const pending = () => S.invoices.filter((i) => i.status === 'pending')
  .sort((a, b) => a.createdAt - b.createdAt);
export const pendingCount = () => S.invoices.filter((i) => i.status === 'pending').length;
export const conflictCount = () => S.invoices.filter((i) => i.status === 'conflict').length;

/** المبيعات المحلية اللي لسه ما اتزامنتش لمنتج معيّن */
export function pendingQty(productId) {
  let q = 0;
  for (const inv of S.invoices) {
    if (inv.status !== 'pending') continue;
    for (const it of inv.items) if (it.productId === productId) q += it.qty;
  }
  return round3(q);
}
/** المخزون المعروض = مخزون السيرفر − المبيعات المعلّقة */
export const localStock = (p) => round3(p.stock - pendingQty(p.id));

export const lineTotal = (i) => round2(i.qty * i.unitPrice);
export const invoiceTotal = (inv) => round2(inv.items.reduce((s, i) => s + lineTotal(i), 0));
/** عدد الأصناف في الفاتورة (مش مجموع الكميات، لأن الكميات ممكن تبقى مل/جرام) */
export const invoiceCount = (inv) => inv.items.length;

function nextSeq(day) {
  const k = `seq_${day}`;
  const n = (parseInt(localStorage.getItem(k) || '0', 10) || 0) + 1;
  localStorage.setItem(k, String(n));
  return n;
}

// ---------- السلة ----------
export function addToCart(productId, delta = 1) {
  const line = S.cart.find((l) => l.productId === productId);
  if (line) {
    line.qty = round3(line.qty + delta);
    if (line.qty <= 0) S.cart = S.cart.filter((l) => l !== line);
  } else if (delta > 0) {
    S.cart.push({ productId, qty: round3(delta) });
  }
  emit();
}
/** تحديد كمية بالظبط (للمنتجات العشرية زي المل/الجرام) — صفر أو أقل بيشيل السطر */
export function setQty(productId, qty) {
  qty = round3(qty);
  if (!(qty > 0)) S.cart = S.cart.filter((l) => l.productId !== productId);
  else {
    const line = S.cart.find((l) => l.productId === productId);
    if (line) line.qty = qty; else S.cart.push({ productId, qty });
  }
  emit();
}
export const clearCart = () => { S.cart = []; S.lastInvoice = null; emit(); };
export const cartTotal = () => S.cart.reduce((s, l) => {
  const p = S.products.get(l.productId); return round2(s + (p ? round2(p.price * l.qty) : 0));
}, 0);

/** تأكيد البيع: بيحفظ الفاتورة محلياً فوراً (قبل أي اتصال) */
export async function completeSale() {
  if (!S.cart.length || S.lastInvoice) return null;
  if (!S.user) throw new Error('لازم تسجّل الدخول');
  const now = new Date();
  const dk = dayKey(now);
  const items = S.cart.map((l) => {
    const p = S.products.get(l.productId);
    return { productId: p.id, name: p.name, barcode: p.barcode, unit: p.unit, qty: l.qty, unitPrice: p.price };
  });
  const inv = {
    id: uuid(),
    number: `${deviceCode()}-${dk}-${String(nextSeq(dk)).padStart(4, '0')}`,
    deviceId: deviceId(),
    deviceCode: deviceCode(),
    cashierId: S.user.uid,
    cashierName: S.user.name,
    items,
    createdAt: now.getTime(),
    status: 'pending',      // pending | synced | conflict
    conflictNotes: [],
    lastError: null,
    attempts: 0,
  };
  await saveInvoice(inv);
  S.lastInvoice = inv;
  emit();
  return inv;
}
