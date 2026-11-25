/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The design guide's mechanical rules, checked on a rendered page: run it wherever a browser test
 * takes a screenshot and a broken layout fails the test instead of waiting for someone to look.
 *
 * Rules (docs/design-guide.md §3, §9):
 * - `text-clipped`: a label cut off or ellipsized. Only a long user-entered value in a list row may
 *   ellipsize, and it says so with `dataSet={{ ellipsis: 'value' }}` (`data-ellipsis`).
 * - `text-overlap`: two pieces of visible text drawn over each other.
 * - `value-split`: an amount ("Rp 50.000"), a code ("PO-W4M-0002") or a phone number broken
 *   across lines.
 * - `page-overflow`: the page scrolls sideways.
 * - `type-ladder`: a font size off the type scale.
 * - `contrast`: text under 4.5:1 (3:1 for large text) against what is behind it.
 * - `target-size`: a control smaller than the platform's floor.
 * - `two-primaries`: more than one button filled with the primary colour in view.
 */

export type LayoutRule =
  | 'text-clipped'
  | 'text-overlap'
  | 'value-split'
  | 'page-overflow'
  | 'type-ladder'
  | 'contrast'
  | 'target-size'
  | 'two-primaries';

export interface LayoutIssue {
  readonly rule: LayoutRule;
  /** testID, accessible name or the start of the text: enough to find it on the screenshot. */
  readonly where: string;
  readonly detail: string;
}

export interface LayoutAuditOptions {
  /** Font sizes on the type ladder, in px at font scale 1. */
  readonly ladder: readonly number[];
  /** The large-font multiplier the page is drawn at (1 = normal). */
  readonly fontScale: number;
  /** Smallest drawn width and height of a control, in px. */
  readonly minTarget: number;
  /** The fill of a primary button, as `#rrggbb`. */
  readonly primaryFill?: string;
  readonly skip?: readonly LayoutRule[];
}

/**
 * Runs inside the page (Playwright serializes it), so it must stay self-contained: no imports and
 * nothing from the enclosing module.
 */
export function auditLayout(options: LayoutAuditOptions): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const skip = new Set(options.skip ?? []);
  const report = (rule: LayoutRule, where: string, detail: string): void => {
    if (!skip.has(rule)) issues.push({ rule, where, detail });
  };
  const viewWidth = document.documentElement.clientWidth;
  const viewHeight = document.documentElement.clientHeight;

  const name = (el: Element): string => {
    const id =
      el.getAttribute('data-testid') ?? el.closest('[data-testid]')?.getAttribute('data-testid');
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return [id, el.getAttribute('aria-label'), text ? `"${text}"` : null]
      .filter((part) => part !== null && part !== undefined && part !== '')
      .join(' ');
  };
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
  };
  /** Whether the point is drawn by this element: false under a sheet, a dialog or another layer. */
  const onTop = (el: Element, box: DOMRect): boolean => {
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x >= viewWidth || y >= viewHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const iconOnly = (text: string): boolean => /^[\s-\u{F0000}-\u{FFFFD}]*$/u.test(text);

  if (document.documentElement.scrollWidth > viewWidth + 1) {
    report(
      'page-overflow',
      'page',
      `${String(document.documentElement.scrollWidth)}px wide in ${String(viewWidth)}px`,
    );
  }

  const texts: Element[] = [];
  for (const el of document.body.querySelectorAll('*')) {
    const ownText = [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('');
    if (ownText.trim() === '' || iconOnly(ownText)) continue;
    if (el.closest('script, style, noscript, [data-qa-ignore]') !== null || !shown(el)) continue;
    texts.push(el);
  }

  // An amount, a code like PO-W4M-0002 or K7Q-0012, a phone number like 0812-3456-7890.
  const WHOLE_VALUES =
    /[−-]?Rp[\s\u00A0]?[\d.,]+|\b[A-Z0-9]{2,4}[-\u2011][A-Z0-9]{3,4}(?:[-\u2011]\d{2,})?\b|\b0\d{3}[-\u2011]\d{3,4}[-\u2011]\d{3,5}\b/g;
  const ladder = new Set<number>();
  for (const size of options.ladder) {
    ladder.add(Math.round(size * 10));
    ladder.add(Math.round(size * options.fontScale * 10));
  }

  for (const el of texts) {
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    if (![-1, 0, 1].some((nudge) => ladder.has(Math.round(size * 10) + nudge))) {
      report('type-ladder', name(el), `${String(size)}px`);
    }

    const wide = el.scrollWidth > el.clientWidth + 1;
    const tall = el.scrollHeight > el.clientHeight + 1;
    const clipsX = wide && (style.overflowX !== 'visible' || style.textOverflow === 'ellipsis');
    const clipsY = tall && style.overflowY !== 'visible' && style.webkitLineClamp !== 'none';
    if ((clipsX || clipsY) && el.closest('[data-ellipsis]') === null) {
      report('text-clipped', name(el), clipsX ? 'cut at the side' : 'lines cut off');
    }

    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      for (const match of (node.textContent ?? '').matchAll(WHOLE_VALUES)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const lines = new Set(
          [...range.getClientRects()]
            .filter((box) => box.width > 0)
            .map((box) => Math.round(box.top)),
        );
        if (lines.size > 1) report('value-split', name(el), match[0]);
      }
    }
  }

  const boxes = texts.map((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const own = el.getBoundingClientRect();
    const clips = getComputedStyle(el).overflowX !== 'visible';
    const lines = [...range.getClientRects()].map((box) =>
      clips
        ? new DOMRect(
            Math.max(box.left, own.left),
            box.top,
            Math.min(box.right, own.right) - Math.max(box.left, own.left),
            box.height,
          )
        : box,
    );
    return { el, lines: lines.filter((box) => box.width > 1 && box.height > 1) };
  });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const hit = a.lines.find((p) =>
        b.lines.some((q) => {
          const across = Math.min(p.right, q.right) - Math.max(p.left, q.left);
          const down = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
          return across > 2 && down > 2 && onTop(a.el, p) && onTop(b.el, q);
        }),
      );
      if (hit !== undefined)
        report('text-overlap', `${name(a.el)} / ${name(b.el)}`, 'drawn over each other');
    }
  }

  const rgba = (value: string): [number, number, number, number] | null => {
    const parts = /rgba?\(([^)]+)\)/
      .exec(value)?.[1]
      ?.split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts === undefined || parts.length < 3) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  };
  const luminance = ([r, g, b]: readonly number[]): number => {
    const channel = (v: number): number => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  };
  const behind = (el: Element): [number, number, number, number] | null => {
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') return null;
      const fill = rgba(style.backgroundColor);
      if (fill !== null && fill[3] > 0.6) return fill;
    }
    return [255, 255, 255, 1];
  };
  for (const el of texts) {
    if (el.closest('[aria-disabled="true"], :disabled') !== null) continue;
    const style = getComputedStyle(el);
    const fore = rgba(style.color);
    const back = behind(el);
    if (fore === null || back === null || fore[3] < 0.6) continue;
    const [hi, lo] = [luminance(fore), luminance(back)].sort((x, y) => y - x) as [number, number];
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(style.fontSize) / options.fontScale;
    const large = size >= 24 || (size >= 18 && Number(style.fontWeight) >= 600);
    if (ratio < (large ? 3 : 4.5) - 0.05) report('contrast', name(el), ratio.toFixed(2));
  }

  const controls = document.body.querySelectorAll(
    'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=switch], [role=tab], [role=radio], [role=menuitem]',
  );
  for (const el of controls) {
    if (!shown(el) || el.closest('[data-qa-ignore]') !== null) continue;
    if (el.parentElement?.closest('button, [role=button], a[href]') !== null) continue;
    // React Native Web draws a switch smaller than the phone does; its row is the target there.
    if (el.matches('[role=switch]')) continue;
    const box = el.getBoundingClientRect();
    if (!onTop(el, box)) continue;
    if (box.width < options.minTarget - 0.5 || box.height < options.minTarget - 0.5) {
      report(
        'target-size',
        name(el),
        `${String(Math.round(box.width))}x${String(Math.round(box.height))}`,
      );
    }
  }

  const fill = options.primaryFill;
  const primaryRgb =
    fill === undefined
      ? null
      : `rgb(${[1, 3, 5].map((at) => String(parseInt(fill.slice(at, at + 2), 16))).join(', ')})`;
  const primaries = [...controls].filter(
    (el) =>
      primaryRgb !== null &&
      el.matches('button, [role=button]') &&
      !['aria-checked', 'aria-selected', 'aria-pressed'].some(
        (attr) => el.getAttribute(attr) === 'true',
      ) &&
      getComputedStyle(el).backgroundColor === primaryRgb &&
      shown(el) &&
      onTop(el, el.getBoundingClientRect()),
  );
  if (primaries.length > 1) {
    report(
      'two-primaries',
      primaries.map(name).join(' / '),
      `${String(primaries.length)} filled buttons`,
    );
  }

  return issues;
}

/**
 * An init script that draws the page as a phone set to a larger system font: every font size and
 * line height the page styles is multiplied by `scale`. React Native Web always reports a font
 * scale of 1, so this is the browser's stand-in for Android's and iOS's text size setting.
 */
export function fontScaleScript(scale: number): string {
  if (scale === 1) return '';
  return `(() => {
    const scale = ${String(scale)};
    const grow = (text) => String(text).replace(/(font-size|line-height)(\\s*:\\s*)([\\d.]+)px/g,
      (_, prop, sep, px) => prop + sep + (parseFloat(px) * scale).toFixed(2) + 'px');
    const insertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) { return insertRule.call(this, grow(rule), index); };
    for (const prop of ['fontSize', 'lineHeight']) {
      const own = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop);
      if (own === undefined || own.set === undefined) continue;
      Object.defineProperty(CSSStyleDeclaration.prototype, prop, { ...own, set(value) {
        const px = typeof value === 'number' ? value : /^[\\d.]+px$/.test(value) ? parseFloat(value) : null;
        own.set.call(this, px === null ? value : px * scale + 'px');
      } });
    }
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (prop, value, priority) {
      const sized = (prop === 'font-size' || prop === 'line-height') && /^[\\d.]+px$/.test(String(value));
      return setProperty.call(this, prop, sized ? parseFloat(value) * scale + 'px' : value, priority);
    };
  })();`;
}

/** The slice of Playwright's `Page` the audit needs, so this package does not depend on it. */
interface AuditPage {
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
}

/** Throws one readable error listing every issue on the page, for a failing test to show. */
export async function expectCleanLayout(
  page: AuditPage,
  options: LayoutAuditOptions,
  label = '',
): Promise<void> {
  const issues = await page.evaluate(auditLayout, options);
  if (issues.length === 0) return;
  const lines = issues.map((issue) => `  ${issue.rule}: ${issue.where} (${issue.detail})`);
  throw new Error(`Layout check failed${label ? ` on ${label}` : ''}:\n${lines.join('\n')}`);
}
