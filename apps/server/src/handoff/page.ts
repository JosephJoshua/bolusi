// The page a store phone opens from the counter PC's QR. It stays open while the phone is paired:
// each photo or signature the counter asks for shows up here by itself, and what the phone takes
// goes back to the PC through this server. Plain HTML with one inline script, so it works in any
// phone browser without installing anything. The phone's own camera app takes the photo (a file
// input with `capture`); the page scales it down to the phone pipeline's 1600 px before sending. A
// signature takes the whole screen on its side, as wide as the phone allows.
import type { HandoffPageLabels } from '@bolusi/schemas';

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** JSON that is safe inside a <script>: nothing in it can close the tag. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;background:#f4f5f7;color:#16181d;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 32px;display:flex;flex-direction:column;gap:16px}
h1{font-size:22px;line-height:1.25;margin:0}
p{margin:0}
.muted{color:#5b6170}
.frame{background:#fff;border:1px solid #d9dce3;border-radius:10px;overflow:hidden}
.frame img{display:block;width:100%;height:auto}
canvas{display:block;width:100%;height:100%;touch-action:none;background:#fff}
.row{display:flex;flex-direction:column;gap:12px}
#photo-send{order:-1}
section{display:flex;flex-direction:column;gap:16px}
header{display:flex;flex-direction:column;gap:4px}
button,label.button{flex:1;display:flex;align-items:center;justify-content:center;min-height:52px;padding:0 16px;border-radius:10px;border:1px solid #c9ccd4;background:#fff;color:#16181d;font-family:inherit;font-size:17px;font-weight:600;line-height:1.2;cursor:pointer;text-align:center}
button.primary,label.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
button:disabled{opacity:.5}
input[type=file]{position:absolute;width:1px;height:1px;opacity:0}
.note{padding:12px 14px;border-radius:10px;font-weight:600}
.ok{background:#e7f6ec;color:#14632f}
.bad{background:#fdecec;color:#9b1c1c}
.center{min-height:50vh;display:flex;align-items:center;justify-content:center;text-align:center}
[hidden]{display:none!important}
body.sign main{max-width:none;height:100vh;height:100dvh;padding:10px 14px;gap:8px}
body.sign h1{font-size:18px}
#sign{flex:1;min-height:0;display:flex;gap:12px}
#sign .frame{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;border:0;background:none}
#pad-box{width:min(100%,calc((100vh - 64px)*2));width:min(100%,calc((100dvh - 64px)*2));aspect-ratio:2/1;border:1px solid #d9dce3;border-radius:10px;overflow:hidden;background:#fff}
#sign .side{width:190px;display:flex;flex-direction:column;justify-content:center;gap:12px}
#sign .side button{flex:0 0 auto}
#rotate{flex:1;display:none;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center}
#rotate svg{width:72px;height:72px}
#rotate button{flex:0 0 auto;padding:0 24px}
#sign-view{display:contents}
@media (orientation:portrait){body.sign #sign{display:none}body.sign #rotate{display:flex}}
`;

const SCRIPT = `
const L = JSON.parse(document.getElementById('labels').textContent);
const PAD = { width: Number(document.body.dataset.w), height: Number(document.body.dataset.h) };
const MAX_STROKES = Number(document.body.dataset.strokes);
const MAX_POINTS = Number(document.body.dataset.points);
const BASE = location.pathname;
const $ = (id) => document.getElementById(id);
const note = $('note');
const show = (text, ok) => { note.textContent = text; note.className = 'note ' + (ok ? 'ok' : 'bad'); note.hidden = false; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let version = -1;
let ask = null;
let sentSeq = 0;
let ended = false;

function view(name) {
  for (const id of ['waiting', 'photo', 'sign-view']) $(id).hidden = id !== name;
  document.body.classList.toggle('sign', name === 'sign-view');
}

function end(text) {
  ended = true;
  view('waiting');
  $('waiting-text').textContent = text;
  note.hidden = true;
}

function setAsk(next) {
  if (next === null) {
    if (ask !== null && ask.seq !== sentSeq) show(L.withdrawn, false);
    ask = null;
    view('waiting');
    return;
  }
  if (ask !== null && ask.seq === next.seq) return;
  ask = next;
  // "Sent" stays up over the next step, so the person sees the last one went through.
  if (!note.classList.contains('ok')) note.hidden = true;
  if (next.kind === 'photo') {
    $('photo-title').textContent = next.title;
    resetPhoto();
    view('photo');
  } else {
    note.hidden = true;
    $('sign-title').textContent = next.title;
    resetPad();
    view('sign-view');
  }
}

async function poll() {
  let fails = 0;
  while (!ended) {
    try {
      const res = await fetch(BASE + '/next?v=' + version);
      if (res.status === 410) { end(L.expired); return; }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (fails >= 3) note.hidden = true;
      fails = 0;
      version = body.v;
      setAsk(body.ask);
    } catch {
      fails += 1;
      if (fails === 3) show(L.failed, false);
      await sleep(3000);
    }
  }
}

async function send(button, body, type) {
  if (ask === null) return;
  const seq = ask.seq;
  button.disabled = true;
  button.textContent = L.sending;
  note.hidden = true;
  try {
    const res = await fetch(BASE + '/send?seq=' + seq, { method: 'POST', headers: { 'Content-Type': type }, body });
    if (res.ok) {
      sentSeq = seq;
      if (ask !== null && ask.seq === seq) { ask = null; view('waiting'); }
      show(L.sent, true);
    } else if (res.status === 410) {
      end(L.expired);
    } else if (res.status === 409) {
      show(L.withdrawn, false);
    } else {
      show(L.failed, false);
    }
  } catch { show(L.failed, false); }
  button.disabled = false;
  button.textContent = L.send;
}

// ── photo ──
const MAX = 1600;
let photo = null;
const decode = async (file) => {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  // Older phone browsers lack createImageBitmap; an <img> reads the file there.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, img };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
};
function resetPhoto() {
  photo = null;
  $('shot').hidden = true;
  $('take-label').textContent = L.take;
  $('take').classList.add('primary');
  $('photo-send').hidden = true;
}
$('file').addEventListener('change', async () => {
  const input = $('file');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || ask === null) return;
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
    const old = $('preview').src;
    $('preview').src = URL.createObjectURL(photo);
    if (old) URL.revokeObjectURL(old);
    $('shot').hidden = false;
    $('take-label').textContent = L.retake;
    $('take').classList.remove('primary');
    $('photo-send').hidden = false;
  } catch { photo = null; show(L.unreadable, false); }
});
$('photo-send').addEventListener('click', () => { if (photo) send($('photo-send'), photo, 'image/jpeg'); });

// ── signature ──
const pad = $('pad');
const ctx = pad.getContext('2d');
let strokes = [];
let points = 0;
let drawing = null;
function resetPad() {
  strokes = [];
  points = 0;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PAD.width, PAD.height);
  ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
  $('sign-send').disabled = true; $('clear').disabled = true;
}
const at = (e) => {
  const box = pad.getBoundingClientRect();
  return { x: (e.clientX - box.left) / box.width * PAD.width, y: (e.clientY - box.top) / box.height * PAD.height };
};
pad.addEventListener('pointerdown', (e) => {
  // The PC takes at most this much; past it the pad stops drawing.
  if (ask === null || strokes.length >= MAX_STROKES || points >= MAX_POINTS) return;
  pad.setPointerCapture(e.pointerId);
  drawing = e.pointerId;
  points += 1;
  const p = at(e);
  strokes.push([p]);
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y + 0.1); ctx.stroke();
  $('sign-send').disabled = false; $('clear').disabled = false;
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
$('clear').addEventListener('click', resetPad);
$('sign-send').addEventListener('click', () => { if (strokes.length) send($('sign-send'), JSON.stringify({ strokes }), 'application/json'); });
// Where the browser allows it (Android), turn the screen for the customer; elsewhere they turn the phone.
$('rotate-now').addEventListener('click', async () => {
  try {
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock('landscape');
  } catch {}
});

resetPad();
view('waiting');
poll();
`;

const PHONE_SIDEWAYS = `<svg viewBox="0 0 24 24" fill="none" stroke="#5b6170" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M18 11v2"/><path d="M8 3a6 6 0 0 1 8 0"/><path d="M15 2l1 1-1.2 1"/></svg>`;

export function handoffPage(
  labels: HandoffPageLabels,
  nonce: string,
  pad: { readonly width: number; readonly height: number },
  limits: { readonly strokes: number; readonly points: number },
): string {
  const text = (key: keyof HandoffPageLabels): string => escapeHtml(labels[key]);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Bolusi</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body data-w="${String(pad.width)}" data-h="${String(pad.height)}" data-strokes="${String(limits.strokes)}" data-points="${String(limits.points)}">
<main>
<p class="note" id="note" role="status" hidden></p>
<div id="waiting" class="center"><p class="muted" id="waiting-text">${text('waiting')}</p></div>
<section id="photo" hidden>
<header><h1 id="photo-title"></h1><p class="muted">${text('photoHint')}</p></header>
<div class="frame" id="shot" hidden><img id="preview" alt=""></div>
<div class="row">
<label class="button primary" id="take"><input type="file" id="file" accept="image/*" capture="environment"><span id="take-label">${text('take')}</span></label>
<button type="button" class="primary" id="photo-send" hidden>${text('send')}</button>
</div>
</section>
<section id="sign-view" hidden>
<h1 id="sign-title"></h1>
<div id="sign">
<div class="frame"><div id="pad-box"><canvas id="pad" width="${String(pad.width)}" height="${String(pad.height)}"></canvas></div></div>
<div class="side">
<button type="button" class="primary" id="sign-send">${text('send')}</button>
<button type="button" id="clear">${text('clear')}</button>
</div>
</div>
<div id="rotate">${PHONE_SIDEWAYS}<p>${text('rotate')}</p><p class="muted">${text('signatureHint')}</p><button type="button" id="rotate-now">${text('rotateNow')}</button></div>
</section>
</main>
<script type="application/json" id="labels" nonce="${nonce}">${scriptJson(labels)}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
