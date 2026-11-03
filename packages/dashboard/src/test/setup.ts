import '@testing-library/jest-dom/vitest';

// jsdom does not implement matchMedia, which the theme bootstrap reads.
if (!window.matchMedia) {
  const matcher = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: matcher,
  });
}
