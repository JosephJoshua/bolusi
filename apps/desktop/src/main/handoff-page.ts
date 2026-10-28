// The page a store phone opens from the counter's QR: one photo or one signature, sent back to the
// PC that showed the code. Plain HTML with one inline script, so it works in any phone browser
// without installing anything. The phone's own camera app takes the photo (a file input with
// `capture`, which works on a plain http address where the browser camera API is refused); the
// page scales it down to the phone pipeline's 1600 px before sending.
import type { HandoffKind, HandoffPageLabels } from './bridge.js';

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** JSON that is safe inside a <script>: nothing in it can close the tag. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, '');

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;background:#f4f5f7;color:#16181d;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 32px;display:flex;flex-direction:column;gap:16px}
h1{font-size:22px;line-height:1.25;margin:0}
p{margin:0}
.muted{color:#5b6170}
.frame{background:#fff;border:1px solid #d9dce3;border-radius:10px;overflow:hidden}
.frame img{display:block;width:100%;height:auto}
canvas{display:block;width:100%;aspect-ratio:2/1;touch-action:none;background:#fff}
.row{display:flex;gap:12px}
button,label.button{flex:1;display:flex;align-items:center;justify-content:center;min-height:52px;padding:0 16px;border-radius:10px;border:1px solid #c9ccd4;background:#fff;color:#16181d;font-family:inherit;font-size:17px;font-weight:600;line-height:1.2;cursor:pointer;text-align:center}
button.primary,label.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
button:disabled{opacity:.5}
input[type=file]{position:absolute;width:1px;height:1px;opacity:0}
.note{padding:12px 14px;border-radius:10px;font-weight:600}
.ok{background:#e7f6ec;color:#14632f}
.bad{background:#fdecec;color:#9b1c1c}
[hidden]{display:none!important}
`;

const SCRIPT = `
const L = JSON.parse(document.getElementById('labels').textContent);
const KIND = document.body.dataset.kind;
const PAD = { width: Number(document.body.dataset.w), height: Number(document.body.dataset.h) };
const MAX_STROKES = Number(document.body.dataset.strokes);
const MAX_POINTS = Number(document.body.dataset.points);
const $ = (id) => document.getElementById(id);
const note = $('note');
const show = (text, ok) => { note.textContent = text; note.className = 'note ' + (ok ? 'ok' : 'bad'); note.hidden = false; };
let done = false;

async function send(body, type) {
  $('send').disabled = true;
  $('send').textContent = L.sending;
  note.hidden = true;
  try {
    const res = await fetch(location.pathname + '/send', { method: 'POST', headers: { 'Content-Type': type }, body });
    if (res.ok) { done = true; show(L.sent, true); $('actions').hidden = true; return; }
    if (res.status === 410) { done = true; show(L.expired, false); $('actions').hidden = true; return; }
    show(L.failed, false);
  } catch { show(L.failed, false); }
  $('send').disabled = false;
  $('send').textContent = L.send;
}

if (KIND === 'photo') {
  const MAX = 1600;
  // Older phone browsers lack createImageBitmap; an <img> reads the file there.
  const decode = async (file) => {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight, img };
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  };
  let photo = null;
  const input = $('file');
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || done) return;
    note.hidden = true;
    try {
      const bitmap = await decode(file);
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap.img || bitmap, 0, 0, canvas.width, canvas.height);
      photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!photo) throw new Error('encode');
      $('preview').src = URL.createObjectURL(photo);
      $('shot').hidden = false;
      $('take-label').textContent = L.retake;
      $('take').classList.remove('primary');
      $('send').hidden = false;
    } catch { photo = null; show(L.unreadable, false); }
  });
  $('send').addEventListener('click', () => { if (photo) send(photo, 'image/jpeg'); });
} else {
  const pad = $('pad');
  const ctx = pad.getContext('2d');
  let strokes = [];
  let points = 0;
  let drawing = null;
  const reset = () => {
    strokes = [];
    points = 0;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PAD.width, PAD.height);
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    $('send').disabled = true; $('clear').disabled = true;
  };
  const at = (e) => {
    const box = pad.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width * PAD.width, y: (e.clientY - box.top) / box.height * PAD.height };
  };
  // The PC takes at most this much; past it the pad stops drawing.
  pad.addEventListener('pointerdown', (e) => {
    if (done || strokes.length >= MAX_STROKES || points >= MAX_POINTS) return;
    points += 1;
    pad.setPointerCapture(e.pointerId);
    drawing = e.pointerId;
    const p = at(e);
    strokes.push([p]);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y + 0.1); ctx.stroke();
    $('send').disabled = false; $('clear').disabled = false;
  });
  pad.addEventListener('pointermove', (e) => {
    if (drawing !== e.pointerId || points >= MAX_POINTS) return;
    points += 1;
    const p = at(e);
    strokes[strokes.length - 1].push(p);
    ctx.lineTo(p.x, p.y); ctx.stroke();
  });
  const up = (e) => { if (drawing === e.pointerId) drawing = null; };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  $('clear').addEventListener('click', reset);
  $('send').addEventListener('click', () => { if (strokes.length) send(JSON.stringify({ strokes }), 'application/json'); });
  reset();
}
`;

export function handoffPage(
  kind: HandoffKind,
  labels: HandoffPageLabels,
  nonce: string,
  pad: { readonly width: number; readonly height: number },
  limits: { readonly strokes: number; readonly points: number },
): string {
  const t = (key: keyof HandoffPageLabels): string => escapeHtml(labels[key]);
  const body =
    kind === 'photo'
      ? `<div class="frame" id="shot" hidden><img id="preview" alt="${t('title')}"></div>
<div class="row" id="actions">
<label class="button primary" id="take"><input type="file" id="file" accept="image/*" capture="environment"><span id="take-label">${t('take')}</span></label>
<button type="button" class="primary" id="send" hidden>${t('send')}</button>
</div>`
      : `<div class="frame"><canvas id="pad" width="${String(pad.width)}" height="${String(pad.height)}" aria-label="${t('title')}"></canvas></div>
<div class="row" id="actions">
<button type="button" id="clear">${t('clear')}</button>
<button type="button" class="primary" id="send">${t('send')}</button>
</div>`;
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${t('title')}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body data-kind="${kind}" data-w="${String(pad.width)}" data-h="${String(pad.height)}" data-strokes="${String(limits.strokes)}" data-points="${String(limits.points)}">
<main>
<h1>${t('title')}</h1>
<p class="muted">${t('hint')}</p>
${body}
<p class="note" id="note" role="status" hidden></p>
</main>
<script type="application/json" id="labels" nonce="${nonce}">${scriptJson(labels)}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
