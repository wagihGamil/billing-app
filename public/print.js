// الطباعة: إيصال بيترسم على canvas (بيدعم العربي) ← يتبعت كصورة ESC/POS لطابعة بلوتوث BLE،
// أو يتطبع من المتصفح (window.print) على أي طابعة معرّفة على الجهاز.
import { fmtDateTime, fmtMoney, fmtQty, CURRENCY } from './common.js';
import { invoiceTotal, lineTotal } from './store.js';

const FONT = '"Segoe UI", Tahoma, "Noto Naskh Arabic", Arial, sans-serif';

export const paperMm = () => (localStorage.getItem('paper_mm') === '80' ? 80 : 58);
export const setPaperMm = (v) => localStorage.setItem('paper_mm', String(v));
const widthPx = () => (paperMm() === 80 ? 576 : 384);

/** يرسم الإيصال ويرجّع canvas أبيض/أسود */
export function renderReceipt(inv, shop) {
  const W = widthPx();
  const pad = 10;
  const rows = []; // {t:'text'|'row'|'line'|'gap', ...}
  const s = shop || {};
  const text = (str, o = {}) => rows.push({ t: 'text', str, ...o });

  if (s.name) text(s.name, { size: 30, bold: true, align: 'center' });
  if (s.addressLine1) text(s.addressLine1, { size: 20, align: 'center' });
  if (s.addressLine2) text(s.addressLine2, { size: 20, align: 'center' });
  if (s.phoneNumber) text(s.phoneNumber, { size: 20, align: 'center', ltr: true });
  rows.push({ t: 'gap', h: 6 });
  text(`فاتورة رقم: ${inv.number}`, { size: 20, align: 'center' });
  text(fmtDateTime(inv.createdAt), { size: 20, align: 'center' });
  if (inv.cashierName) text(`الكاشير: ${inv.cashierName}`, { size: 20, align: 'center' });
  rows.push({ t: 'line' });
  for (const it of inv.items) {
    const unit = it.unit || 'قطعة';
    rows.push({
      t: 'row', size: 22,
      right: `${fmtQty(it.qty)} ${unit} × ${it.name}`,
      left: lineTotal(it).toFixed(2),
    });
    if (it.qty !== 1) text(`${it.unitPrice.toFixed(2)} لكل ${unit}`, { size: 17, align: 'right', gray: true });
  }
  rows.push({ t: 'line' });
  rows.push({ t: 'row', size: 28, bold: true, right: 'الإجمالي', left: `${invoiceTotal(inv).toFixed(2)} ${CURRENCY}` });
  rows.push({ t: 'gap', h: 10 });
  if (s.footerText) text(s.footerText, { size: 20, align: 'center' });
  rows.push({ t: 'gap', h: 30 });

  const lineH = (r) => (r.t === 'gap' ? r.h : r.t === 'line' ? 14 : Math.round(r.size * 1.45));
  const H = rows.reduce((a, r) => a + lineH(r), pad * 2);

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#000'; g.textBaseline = 'middle'; g.direction = 'rtl';

  const fit = (str, maxW) => {
    if (g.measureText(str).width <= maxW) return str;
    while (str.length > 1 && g.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    return str + '…';
  };

  let y = pad;
  for (const r of rows) {
    const h = lineH(r);
    const cy = y + h / 2;
    if (r.t === 'line') {
      g.fillRect(pad, y + 6, W - pad * 2, 2);
    } else if (r.t === 'text') {
      g.font = `${r.bold ? 'bold ' : ''}${r.size}px ${FONT}`;
      g.direction = r.ltr ? 'ltr' : 'rtl';
      g.fillStyle = r.gray ? '#444' : '#000';
      const str = fit(r.str, W - pad * 2);
      if (r.align === 'center') { g.textAlign = 'center'; g.fillText(str, W / 2, cy); }
      else if (r.align === 'right') { g.textAlign = 'right'; g.fillText(str, W - pad, cy); }
      else { g.textAlign = 'left'; g.fillText(str, pad, cy); }
      g.fillStyle = '#000';
    } else if (r.t === 'row') {
      g.font = `${r.bold ? 'bold ' : ''}${r.size}px ${FONT}`;
      g.direction = 'ltr'; g.textAlign = 'left';
      const lw = g.measureText(r.left).width;
      g.fillText(r.left, pad, cy);
      g.direction = 'rtl'; g.textAlign = 'right';
      g.fillText(fit(r.right, W - pad * 2 - lw - 12), W - pad, cy);
    }
    y += h;
  }
  return c;
}

/** canvas -> أوامر ESC/POS (صورة رستر GS v 0، على شرائح علشان ذاكرة الطابعة) */
export function toEscPos(canvas) {
  const w = canvas.width, h = canvas.height;
  const bytesPerRow = Math.ceil(w / 8);
  const img = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = [0x1B, 0x40]; // init
  const BAND = 96;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const rowsInBand = Math.min(BAND, h - y0);
    out.push(0x1D, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      rowsInBand & 0xff, (rowsInBand >> 8) & 0xff);
    for (let y = y0; y < y0 + rowsInBand; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < w) {
            const i = (y * w + x) * 4;
            const lum = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
            if (lum < 140) b |= 0x80 >> bit;
          }
        }
        out.push(b);
      }
    }
  }
  out.push(0x0A, 0x0A, 0x0A, 0x1D, 0x56, 0x42, 0x00); // تغذية + قص (لو مدعوم)
  return new Uint8Array(out);
}

// ------------------------------------------------------------- Bluetooth (BLE)
let bleDevice = null, bleChar = null;
const BLE_SERVICES = [
  0x18f0, 0xff00, 0xffe0, 0xfee7,
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
];

export const bleSupported = () => !!navigator.bluetooth;
export const bleName = () => (bleDevice && bleDevice.gatt.connected ? bleDevice.name || 'طابعة' : null);

export async function connectPrinter() {
  if (!bleSupported()) throw new Error('المتصفح ده مش بيدعم Web Bluetooth (استخدم Chrome على أندرويد).');
  bleDevice = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true, optionalServices: BLE_SERVICES,
  });
  bleDevice.addEventListener('gattserverdisconnected', () => { bleChar = null; });
  await openChar();
  return bleDevice.name || 'طابعة';
}

async function openChar() {
  const server = await bleDevice.gatt.connect();
  const services = await server.getPrimaryServices();
  for (const svc of services) {
    const chars = await svc.getCharacteristics();
    const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    if (w) { bleChar = w; return; }
  }
  throw new Error('مفيش خاصية كتابة في الطابعة دي (غالباً طابعة بلوتوث كلاسيك مش BLE).');
}

async function bleSend(bytes) {
  if (!bleDevice) throw new Error('الطابعة مش متوصلة. اربطها من تبويب "حسابي".');
  if (!bleDevice.gatt.connected || !bleChar) await openChar();
  const CH = 100;
  for (let i = 0; i < bytes.length; i += CH) {
    const part = bytes.slice(i, i + CH);
    if (bleChar.properties.writeWithoutResponse) await bleChar.writeValueWithoutResponse(part);
    else await bleChar.writeValue(part);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function printBluetooth(inv, shop) {
  await bleSend(toEscPos(renderReceipt(inv, shop)));
}

// ------------------------------------------------------------- طباعة المتصفح
export function printBrowser(inv, shop) {
  const canvas = renderReceipt(inv, shop);
  let area = document.getElementById('print-area');
  if (!area) { area = document.createElement('div'); area.id = 'print-area'; document.body.appendChild(area); }
  area.innerHTML = '';
  const img = new Image();
  img.style.width = `${paperMm()}mm`;
  img.onload = () => { window.print(); };
  img.src = canvas.toDataURL('image/png');
  area.appendChild(img);
}

/** يحاول البلوتوث لو متوصل، وإلا يطبع من المتصفح */
export async function printReceipt(inv, shop) {
  if (bleName()) {
    try { await printBluetooth(inv, shop); return 'bluetooth'; }
    catch (e) { console.warn('BLE print failed', e); }
  }
  printBrowser(inv, shop);
  return 'browser';
}

export { fmtMoney };
