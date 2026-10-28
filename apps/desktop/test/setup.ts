// jsdom has no layout engine: give elements a size so the virtual table renders its rows, and
// stub the browser APIs the screens touch. Main-process tests run in plain Node and skip all this.
import { vi } from 'vitest';

if (typeof HTMLElement !== 'undefined') stubLayout();

function stubLayout(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1100);
  HTMLElement.prototype.scrollIntoView = () => undefined;
}
