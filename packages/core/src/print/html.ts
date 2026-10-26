// A document as a self-contained HTML page for plain paper and PDF: what the phone hands to the
// system print dialog or saves as a PDF, and what the desktop app prints to an ordinary printer.
// No external fonts, scripts or images: everything is inline so it renders offline.
import type { PrintBlock, PrintDocument, PrintField, PrintImage } from './document.js';
import type { PaperSettings } from './paper.js';

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

/** A value this long reads better across the whole width than squeezed into half of it. */
const WIDE_FIELD_CHARS = 38;

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
      return `<div class="ruler"><div class="ruler-scale"></div><p>${esc(b.caption)}</p></div>`;
  }
}

function copy(doc: PrintDocument, label: string | null, carbonless: boolean): string {
  const header = `<header class="store">${img(doc.header.logo, 'logo')}<div><div class="store-name">${esc(
    doc.header.name,
  )}</div>${doc.header.lines.map((l) => `<div class="store-line">${esc(l)}</div>`).join('')}</div></header>`;
  const title = `<div class="doc"><div><div class="title">${esc(doc.title)}</div>${doc.meta
    .map((m) => `<div class="meta">${esc(m)}</div>`)
    .join('')}</div><div class="doc-right">${
    label === null ? '' : `<div class="copy-label">${esc(label)}</div>`
  }<div class="ref">${esc(doc.reference)}</div></div></div>`;
  const notes = [doc.footer, carbonless ? doc.plyNote : null].filter(
    (n): n is string => n !== null && n !== '',
  );
  const footer =
    notes.length === 0 ? '' : `<footer>${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</footer>`;
  return `<section class="copy">${header}${title}<main>${doc.blocks.map(block).join('')}</main>${footer}</section>`;
}

function styles(paper: PaperSettings): string {
  const narrow = paper.widthMm < 130;
  const pad = paper.widthMm < 160 ? 8 : 12;
  return `
@page { size: ${paper.widthMm}mm ${paper.heightMm}mm; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #fff; }
body { font: 9pt/1.4 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.copy { width: ${paper.widthMm}mm; min-height: ${paper.heightMm}mm; padding: ${pad}mm;
  display: flex; flex-direction: column; break-after: page; page-break-after: always; }
.copy:last-child { break-after: auto; page-break-after: auto; }
.store { display: flex; align-items: center; gap: 4mm; padding-bottom: 3mm; border-bottom: 1.2pt solid #111; }
.logo { max-height: 15mm; max-width: 36mm; object-fit: contain; }
.store-name { font-size: 13pt; font-weight: 700; line-height: 1.2; }
.store-line { font-size: 8pt; color: #444; }
.doc { display: flex; justify-content: space-between; align-items: flex-end; gap: 4mm; margin: 3.5mm 0 1mm; }
.title { font-size: 10.5pt; font-weight: 700; letter-spacing: 0.05em; }
.meta { font-size: 8pt; color: #444; }
.doc-right { text-align: right; }
.copy-label { display: inline-block; border: 0.8pt solid #111; border-radius: 99px; padding: 0.3mm 2.5mm;
  font-size: 7.5pt; font-weight: 600; margin-bottom: 1mm; }
.ref { font-size: 16pt; font-weight: 700; white-space: nowrap; }
h2 { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #555;
  margin: 3.5mm 0 1.2mm; break-after: avoid; page-break-after: avoid; }
.fields { display: grid; grid-template-columns: ${narrow ? '1fr' : '1fr 1fr'}; gap: 0.8mm 6mm; }
.field { display: grid; grid-template-columns: 24mm 1fr; gap: 2mm; }
.field.wide { grid-column: 1 / -1; }
.field dt { color: #555; }
.field dd { font-weight: 500; overflow-wrap: anywhere; }
.para { overflow-wrap: anywhere; }
.muted { color: #555; }
.list { list-style: none; columns: ${narrow ? 2 : 3}; column-gap: 6mm; }
.list li { break-inside: avoid; padding-left: 3mm; text-indent: -3mm; }
.list li::before { content: "\\2022"; display: inline-block; width: 3mm; text-indent: 0; }
.terms { padding-left: 4.5mm; font-size: 7.5pt; color: #333; }
.amounts { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.amounts td { padding: 0.6mm 0; vertical-align: top; }
.amounts .amt { text-align: right; white-space: nowrap; padding-left: 6mm; }
.amounts .line td { border-bottom: 0.4pt solid #ddd; }
.amounts .total td:first-child { text-align: right; color: #444; }
.amounts .total.first td { padding-top: 1.5mm; }
.amounts .strong td { font-weight: 700; color: #111; font-size: 10pt; }
.signatures { display: flex; gap: 10mm; padding-top: 5mm; break-inside: avoid; page-break-inside: avoid; }
.sig { flex: 1; text-align: center; }
.sig-role { font-size: 8pt; color: #444; }
.sig-space { height: 17mm; display: flex; align-items: flex-end; justify-content: center; }
.sig-img { max-height: 16mm; max-width: 100%; object-fit: contain; }
.sig-line { border-top: 0.8pt solid #111; padding-top: 1mm; min-height: 5mm; font-weight: 500; }
footer { margin-top: 4mm; padding-top: 2mm; border-top: 0.5pt solid #bbb; font-size: 7.5pt; color: #555; }
.ruler { border: 0.8pt solid #111; padding: 3mm; margin-top: 3mm; }
.ruler-scale { height: 4mm; background: repeating-linear-gradient(90deg, #111 0 0.3mm, transparent 0.3mm 10mm); }
.ruler p { margin-top: 2mm; }
@media screen { body { background: #e5e5e5; } .copy { background: #fff; margin: 6mm auto; box-shadow: 0 1px 4px rgba(0,0,0,.2); } }
`;
}

/** A complete HTML document: one page-sized section per copy (one on carbonless paper). */
export function renderHtml(doc: PrintDocument, paper: PaperSettings): string {
  const copies: (string | null)[] =
    paper.carbonless || doc.copies.length === 0 ? [null] : [...doc.copies];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(
    doc.jobName,
  )}</title><style>${styles(paper)}</style></head><body>${copies
    .map((label) => copy(doc, label, paper.carbonless))
    .join('')}</body></html>`;
}
