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
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

