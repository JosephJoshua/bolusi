// Plain-text layout helpers for fixed-pitch printing.

const PUNCTUATION: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  '…': '...',
  '•': '*',
  '·': '-',
  '×': 'x',
  ' ': ' ',
};

/**
 * Printable ASCII only. Dot-matrix code pages differ between models, and ASCII is the part every
 * Epson-compatible printer agrees on: accents are dropped ("é" → "e"), typographic punctuation
 * becomes its ASCII look-alike, and anything else becomes "?". Line breaks become spaces, or with
 * `keepLineBreaks` stay as `\n` for running text that `wrapText` lays out.
 */
export function toPrinterAscii(text: string, keepLineBreaks = false): string {
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n').normalize('NFKD')) {
    const code = ch.codePointAt(0) ?? 0;
    // Combining accents (0300-036F), split off by NFKD, are dropped.
    if (code >= 0x300 && code <= 0x36f) continue;
    if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (ch === '\n') out += keepLineBreaks ? '\n' : ' ';
    else if (ch === '\t') out += ' ';
    else out += PUNCTUATION[ch] ?? '?';
  }
  return out;
}

/**
 * Wrap at spaces into lines of at most `width` characters; a word longer than a line is cut.
 * Explicit line breaks are kept. Always returns at least one line.
 */
export function wrapText(text: string, width: number): string[] {
  const size = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      let rest = word;
      while (rest.length > 0) {
        const room = line === '' ? size : size - line.length - 1;
        if (rest.length <= room) {
          line = line === '' ? rest : `${line} ${rest}`;
          rest = '';
        } else if (line === '') {
          lines.push(rest.slice(0, size));
          rest = rest.slice(size);
        } else {
          lines.push(line);
          line = '';
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

export function padRight(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

export function padLeft(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : ' '.repeat(width - text.length) + text;
}

export function center(text: string, width: number): string {
  const cut = text.slice(0, width);
  return padRight(' '.repeat(Math.floor((width - cut.length) / 2)) + cut, width);
}
