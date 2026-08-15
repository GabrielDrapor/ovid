import '@testing-library/jest-dom';

// Polyfill ResizeObserver for jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Polyfill localStorage for jsdom (not available by default in vitest's jsdom env)
const localStorageMap = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key) => localStorageMap.get(key) ?? null,
  setItem: (key, value) => { localStorageMap.set(key, String(value)); },
  removeItem: (key) => { localStorageMap.delete(key); },
  clear: () => { localStorageMap.clear(); },
  key: (index) => Array.from(localStorageMap.keys())[index] ?? null,
  get length() { return localStorageMap.size; },
};
// Node-environment suites (the self-host adapters) have no window; the
// browser polyfills above simply don't apply there.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });
}

