// مشترك بين تطبيق الكاشير ولوحة المالك
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig, CURRENCY } from './firebase-config.js';

export { firebaseConfig, CURRENCY };
export const configured = !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR_');

export let app = null, auth = null, db = null;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app); // الجلسة بتتحفظ في IndexedDB: بتفضل شغالة أوفلاين
  // كاش Firestore المحلي: قراءة أوفلاين من المنتجات وبيانات المحل
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
}

// ---------- أدوات صغيرة ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** تهريب النصوص قبل وضعها في innerHTML (منع XSS) */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ni = new Intl.NumberFormat('en-US');
export const fmtMoney = (n) => `${nf.format(n || 0)} ${CURRENCY}`;
export const fmtInt = (n) => ni.format(n || 0);

// ---------- الكميات والوحدات ----------
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
/** كمية للعرض: 50 / 37.5 (من غير أصفار زيادة) */
export const fmtQty = (n) => String(round3(n || 0));
/** وحدات مقترحة، والوحدات اللي بتقبل كسور بتتعلّم تلقائياً */
export const UNIT_SUGGESTIONS = ['قطعة', 'علبة', 'مل', 'لتر', 'جرام', 'كجم', 'متر', 'سم'];
export const FRACTIONAL_UNITS = ['مل', 'لتر', 'جرام', 'كجم', 'متر', 'سم'];
const pad = (n) => String(n).padStart(2, '0');
export const fmtDateTime = (d) => {
  if (!d) return '—';
  d = d instanceof Date ? d : new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dayKey = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
export const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const timeAgo = (d) => {
  if (!d) return 'لم يتصل بعد';
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return `من ${m} دقيقة`;
  if (m < 1440) return `من ${Math.floor(m / 60)} ساعة`;
  return `من ${Math.floor(m / 1440)} يوم`;
};

export function toast(msg, error = false) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' err' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

export const isNetworkError = (e) => {
  const c = e && (e.code || '');
  return c === 'unavailable' || c === 'deadline-exceeded' || c === 'auth/network-request-failed'
    || (e && e.message === 'timeout') || !navigator.onLine;
};

export const withTimeout = (p, ms = 25000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// ---------- IndexedDB بسيط (الفواتير + إعدادات) ----------
let _dbp;
function openIdb() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('pos-local', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('invoices', { keyPath: 'id' });
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbp;
}
async function tx(store, mode, fn) {
  const d = await openIdb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
export const idb = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, val, key) => tx(store, 'readwrite', (s) => s.put(val, key)),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  getMeta: (k) => idb.get('meta', k),
  setMeta: (k, v) => idb.put('meta', v, k),
  delMeta: (k) => idb.del('meta', k),
};
