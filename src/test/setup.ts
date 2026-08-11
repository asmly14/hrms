/**
 * jsdom UI-test setup — runs once per test FILE (ui project only).
 *
 * Covers what jsdom does not implement out of the box:
 *  - jest-dom matchers (toBeInTheDocument, …)
 *  - matchMedia / ResizeObserver / IntersectionObserver / scrollIntoView
 *    (used by use-mobile, radix-ui, recharts and shell components)
 *  - geolocation (attendance clock panel reads navigator.geolocation)
 *  - recharts ResponsiveContainer — jsdom has no layout engine, so the
 *    container measures 0×0 and renders nothing; stub it with a fixed-size
 *    box so chart children mount (charts are asserted structurally, not
 *    pixel-wise).
 */
import '@testing-library/jest-dom/vitest';
import { createElement, type ReactNode } from 'react';
import { vi } from 'vitest';

// ── matchMedia ──────────────────────────────────────────────────────────────
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// ── ResizeObserver ──────────────────────────────────────────────────────────
if (!globalThis.ResizeObserver) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverStub,
  });
}

// ── IntersectionObserver ────────────────────────────────────────────────────
if (!globalThis.IntersectionObserver) {
  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    writable: true,
    value: IntersectionObserverStub,
  });
}

// ── scrollIntoView ──────────────────────────────────────────────────────────
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ── geolocation ─────────────────────────────────────────────────────────────
if (!('geolocation' in navigator)) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (_success: unknown, error?: (e: unknown) => void) =>
        error?.({ code: 1, message: 'geolocation unavailable in tests' }),
      watchPosition: () => 0,
      clearWatch: () => {},
    },
  });
}

// ── recharts: ResponsiveContainer needs a real layout engine ────────────────
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: ReactNode }) =>
      createElement(
        'div',
        { 'data-testid': 'responsive-container', style: { width: 800, height: 400 } },
        children,
      ),
  };
});
