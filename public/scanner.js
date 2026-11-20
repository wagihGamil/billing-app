// ماسح باركود بالكاميرا (نافذة منبثقة). بيستخدم BarcodeDetector لو متاح،
// وإلا بيحمّل مكتبة html5-qrcode (بتشتغل على الكمبيوتر والموبايل).
import { toast } from './common.js';

const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';

function loadLib() {
  return new Promise((res, rej) => {
    if (window.Html5Qrcode) return res();
    const s = document.createElement('script');
    s.src = LIB; s.onload = res;
    s.onerror = () => rej(new Error('تعذّر تحميل مكتبة المسح (محتاجة إنترنت).'));
    document.head.appendChild(s);
  });
}

/** يفتح الكاميرا، ولما يقرأ باركود يقفل ويستدعي onCode(code) */
export function openScanner(onCode) {
  const d = document.createElement('dialog');
  d.innerHTML = `
    <h3 style="margin-top:0">امسح الباركود</h3>
    <div style="background:#000;border-radius:12px;overflow:hidden;min-height:120px">
      <video id="sc-video" playsinline muted style="width:100%;max-height:320px;object-fit:cover;display:block"></video>
      <div id="sc-qr"></div>
    </div>
    <p class="muted center" id="sc-msg">وجّه الكاميرا ناحية الباركود…</p>
    <button type="button" class="btn sec block" id="sc-x">إغلاق</button>`;
  document.body.appendChild(d);
  d.showModal();

  let stream = null, timer = null, h5 = null, done = false;

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (h5) { const x = h5; h5 = null; x.stop().catch(() => {}).finally(() => { try { x.clear(); } catch { /* */ } }); }
  };
  const finish = (code) => {
    if (done) return;
    done = true;
    if (navigator.vibrate) navigator.vibrate(60);
    stop(); d.close(); onCode(String(code).trim());
  };
  d.addEventListener('close', () => { stop(); d.remove(); });
  d.querySelector('#sc-x').onclick = () => d.close();

  (async () => {
    try {
      if ('BarcodeDetector' in window) {
        const det = new BarcodeDetector();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        const v = d.querySelector('#sc-video');
        v.srcObject = stream; await v.play();
        timer = setInterval(async () => {
          try { const r = await det.detect(v); if (r.length) finish(r[0].rawValue); } catch { /* تجاهل */ }
        }, 300);
        return;
      }
      await loadLib();
      d.querySelector('#sc-video').style.display = 'none';
      h5 = new window.Html5Qrcode('sc-qr');
      await h5.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 160 } }, finish, () => {});
    } catch (e) {
      d.querySelector('#sc-msg').textContent = 'تعذّر تشغيل الكاميرا. اتأكد إنك سمحت للمتصفح باستخدامها.';
      toast(e.message || String(e), true);
    }
  })();
}
