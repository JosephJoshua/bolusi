// A document as a self-contained HTML page for plain paper and PDF: what the phone hands to the
// system print dialog or saves as a PDF, and what the desktop app prints to an ordinary printer.
// No external fonts, scripts or images: everything is inline so it renders offline.
import type { PrintBlock, PrintDocument, PrintField, PrintImage, PrintLink } from './document.js';
import { isLandscape, type PaperSettings } from './paper.js';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only inline raster images: a document never makes the renderer fetch anything. */
const SAFE_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function img(image: PrintImage | null, className: string): string {
  if (image === null || !SAFE_IMAGE.test(image.dataUri)) return '';
  return `<img class="${className}" src="${image.dataUri}" alt="">`;
}

/** A value longer than this gets a field row of its own rather than half of one. */
const WIDE_FIELD_CHARS = 24;
// Centimetre ticks across the widest paper (420 mm); the frame cuts them at the printable edge.
const RULER_TICKS = 42;

function fields(list: readonly PrintField[]): string {
  const items = list
    .map(
      (f) =>
        `<div class="field${f.value.length > WIDE_FIELD_CHARS ? ' wide' : ''}"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`,
    )
    .join('');
  return `<dl class="fields">${items}</dl>`;
}

function block(b: PrintBlock): string {
  switch (b.kind) {
    case 'heading':
      return `<h2>${esc(b.text)}</h2>`;
    case 'fields':
      return fields(b.fields);
    case 'paragraph':
      return `<p class="para${b.muted === true ? ' muted' : ''}">${esc(b.text)}</p>`;
    case 'list':
      return `<ul class="list">${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'terms':
      return `<ol class="terms">${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>`;
    case 'amounts': {
      const row = (r: { label: string; amount: string; strong?: boolean }, cls: string): string =>
        `<tr class="${cls}${r.strong === true ? ' strong' : ''}"><td>${esc(r.label)}</td><td class="amt">${esc(r.amount)}</td></tr>`;
      return `<table class="amounts"><tbody>${b.rows.map((r) => row(r, 'line')).join('')}${b.totals
        .map((r, i) => row(r, i === 0 ? 'total first' : 'total'))
        .join('')}</tbody></table>`;
    }
    case 'signatures':
      return `<div class="signatures">${b.slots
        .map(
          (s) =>
            `<div class="sig"><div class="sig-role">${esc(s.role)}</div><div class="sig-space">${img(s.image, 'sig-img')}</div><div class="sig-line">${esc(s.name ?? '')}</div></div>`,
        )
        .join('')}</div>`;
    case 'ruler':
      // A tick every centimetre, drawn as borders: printers drop thin background gradients.
      return `<div class="ruler"><div class="ruler-scale">${'<span></span>'.repeat(
        RULER_TICKS,
      )}</div><p>${esc(b.caption)}</p></div>`;
  }
}

const blocks = (list: readonly PrintBlock[]): string => list.map(block).join('');

/** On landscape paper the aside is a column beside the body; on portrait it follows the body. */
function main(doc: PrintDocument, paper: PaperSettings): string {
  if (doc.aside.length === 0) return `<main>${blocks(doc.blocks)}</main>`;
  const layout = isLandscape(paper) ? 'columns' : 'stacked';
  return `<main class="${layout}"><div class="body">${blocks(doc.blocks)}</div><aside>${blocks(
    doc.aside,
  )}</aside></main>`;
}

/** A QR code as an inline SVG: one path, a rectangle per run of dark modules, a 4-module margin. */
function qrSvg(modules: PrintLink['modules']): string {
  const quiet = 4;
  const size = modules.length + 2 * quiet;
  const runs: string[] = [];
  modules.forEach((row, y) => {
    let start = -1;
    row.forEach((dark, x) => {
      if (dark && start < 0) start = x;
      if (start >= 0 && (!dark || x === row.length - 1)) {
        const end = dark ? x + 1 : x;
        runs.push(
          `M${String(start + quiet)} ${String(y + quiet)}h${String(end - start)}v1h-${String(end - start)}z`,
        );
        start = -1;
      }
    });
  });
  return `<svg class="qr" viewBox="0 0 ${String(size)} ${String(size)}" shape-rendering="crispEdges" aria-hidden="true"><path d="${runs.join('')}"/></svg>`;
}

function link(value: PrintLink): string {
  return `<div class="link">${qrSvg(value.modules)}<div class="link-text"><div class="link-title">${esc(
    value.title,
  )}</div><div class="link-address">${esc(value.address)}</div></div></div>`;
}

/** The signatures, and the link beside them. */
function closing(doc: PrintDocument): string {
  const linked = doc.link ?? null;
  if (doc.closing.length === 0 && linked === null) return '';
  return `<div class="closing${linked === null ? '' : ' with-link'}"><div class="closing-blocks">${blocks(
    doc.closing,
  )}</div>${linked === null ? '' : link(linked)}</div>`;
}

function copy(doc: PrintDocument, label: string | null, paper: PaperSettings): string {
  const header = `<header class="store">${img(doc.header.logo, 'logo')}<div><div class="store-name">${esc(
    doc.header.name,
  )}</div>${doc.header.lines.map((l) => `<div class="store-line">${esc(l)}</div>`).join('')}</div></header>`;
  const title = `<div class="doc"><div><div class="title">${esc(doc.title)}</div>${doc.meta
    .map((m) => `<div class="meta">${esc(m)}</div>`)
    .join('')}</div><div class="doc-right">${
    label === null ? '' : `<div class="copy-label">${esc(label)}</div>`
  }<div class="ref">${esc(doc.reference)}</div></div></div>`;
  return `<section class="copy">${header}${title}${main(doc, paper)}<div class="end">${closing(
    doc,
  )}</div></section>`;
}

function styles(paper: PaperSettings): string {
  // A small sheet (A5, a half form) keeps the type size but gets tighter margins and vertical
  // spacing, so an ordinary slip still fits one sheet. Plain paper otherwise gets room to breathe.
  const small = Math.min(paper.widthMm, paper.heightMm) < 160;
  const pad = small ? 9 : 13;
  const v = (mm: number): string => `${Math.round(mm * (small ? 0.7 : 1) * 10) / 10}mm`;
  return `
@page { size: ${paper.widthMm}mm ${paper.heightMm}mm; margin: ${pad}mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #fff; }
body { font: 9pt/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* The page margin, not padding, keeps the edges clear on every sheet a copy runs onto. */
.copy { break-after: page; page-break-after: always; }
.copy:last-child { break-after: auto; page-break-after: auto; }
.store { display: flex; align-items: center; gap: 4mm; padding-bottom: ${v(3.5)}; border-bottom: 1.2pt solid #111; }
.store > div { min-width: 0; }
.logo { max-height: 15mm; max-width: 36mm; object-fit: contain; flex: none; }
.store-name { font-size: 14pt; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
.store-line { font-size: 8pt; color: #444; overflow-wrap: anywhere; }
.doc { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; margin: ${v(5)} 0 1mm; }
.doc > div:first-child { flex: 1 1 auto; min-width: 45%; }
.title { font-size: 11pt; font-weight: 700; letter-spacing: 0.04em; }
.meta { font-size: 8pt; color: #444; }
.doc-right { text-align: right; flex: 0 1 auto; min-width: 0; }
.copy-label { display: inline-block; border: 0.8pt solid #111; border-radius: 99px; padding: 0.3mm 2.5mm;
  font-size: 7.5pt; font-weight: 600; margin-bottom: 1.2mm; }
.ref { font-size: 17pt; font-weight: 700; line-height: 1.1; overflow-wrap: anywhere; }
main.columns { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 9mm; }
h2 { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #555;
  margin: ${v(5.5)} 0 ${v(3)}; break-after: avoid; page-break-after: avoid; overflow-wrap: anywhere; }
main.columns h2:first-child, aside > h2:first-child { margin-top: ${v(4)}; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(58mm, 1fr)); gap: ${v(1.6)} 7mm; }
.body > .fields:first-child, main > .fields:first-child { margin-top: ${v(4.5)}; }
.field { display: grid; grid-template-columns: 22mm minmax(0, 1fr); gap: 2.5mm; }
.field.wide { grid-column: 1 / -1; }
.field dt { color: #555; overflow-wrap: anywhere; }
.field dd { font-weight: 500; overflow-wrap: anywhere; }
.para { overflow-wrap: anywhere; white-space: pre-line; }
.para + .para { margin-top: 1.5mm; }
.muted { color: #555; }
.list { list-style: none; column-width: 44mm; column-gap: 7mm; }
.list li { break-inside: avoid; padding-left: 3mm; text-indent: -3mm; margin-bottom: 0.6mm; overflow-wrap: anywhere; }
.list li::before { content: "\\2022"; display: inline-block; width: 3mm; text-indent: 0; }
.terms { padding-left: 4.5mm; font-size: 7.5pt; line-height: 1.45; color: #333; }
.terms li { margin-bottom: 0.8mm; overflow-wrap: anywhere; }
.amounts { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; table-layout: auto; }
.amounts td { padding: ${v(1.2)} 0; vertical-align: top; overflow-wrap: anywhere; }
.amounts .amt { text-align: right; white-space: nowrap; padding-left: 6mm; width: 1%; }
.amounts .line td { border-bottom: 0.4pt solid #ddd; }
.amounts .total td { padding: 0.8mm 0; }
.amounts .total td:first-child { text-align: right; color: #444; }
.amounts .total.first td { padding-top: ${v(2.4)}; }
.amounts .strong td { font-weight: 700; color: #111; font-size: 10.5pt; }
.end { break-inside: avoid; page-break-inside: avoid; }
.closing { margin-top: ${v(4)}; }
.closing.with-link { display: flex; align-items: flex-end; gap: 8mm; }
.closing-blocks { flex: 1; min-width: 0; }
.link { flex: none; display: flex; flex-direction: column; align-items: center; gap: 1mm; max-width: 42mm; text-align: center; }
.qr { width: ${small ? 20 : 24}mm; height: ${small ? 20 : 24}mm; display: block; }
.link-title { font-size: 7.5pt; color: #444; }
.link-address { font-size: 8.5pt; font-weight: 700; overflow-wrap: anywhere; }
.signatures { display: flex; gap: 12mm; padding-top: ${v(4)}; }
.sig { flex: 1; min-width: 0; text-align: center; }
.sig-role { font-size: 8pt; color: #444; overflow-wrap: anywhere; }
.sig-space { height: ${v(20)}; display: flex; align-items: flex-end; justify-content: center; }
.sig-img { max-height: 19mm; max-width: 100%; object-fit: contain; }
.sig-line { border-top: 0.8pt solid #111; padding-top: 1.2mm; min-height: 5mm; font-weight: 500; overflow-wrap: anywhere; }
.ruler { border: 0.8pt solid #111; padding: 3mm; margin: 4mm 0 3mm; }
.ruler-scale { display: flex; height: 4mm; overflow: hidden; border-right: 0.3mm solid #111; }
.ruler-scale span { flex: 0 0 10mm; border-left: 0.3mm solid #111; }
.ruler p { margin-top: 2mm; }
@media screen { body { background: #e5e5e5; } .copy { width: ${paper.widthMm}mm; min-height: ${paper.heightMm}mm;
  padding: ${pad}mm; background: #fff; margin: 6mm auto; box-shadow: 0 1px 4px rgba(0,0,0,.2); } }
`;
}

/** A complete HTML document: one page-sized section per copy (one on carbonless paper). */
export function renderHtml(doc: PrintDocument, paper: PaperSettings): string {
  const copies: (string | null)[] =
    paper.carbonless || doc.copies.length === 0 ? [null] : [...doc.copies];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(
    doc.jobName,
  )}</title><style>${styles(paper)}</style></head><body>${copies
    .map((label) => copy(doc, label, paper))
    .join('')}</body></html>`;
}
