// jsdom has no layout engine: give elements a size so the virtual table renders its rows, and
// stub the browser APIs the screens touch.
import { vi } from 'vitest';

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
