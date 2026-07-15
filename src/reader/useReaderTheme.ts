import { useCallback, useEffect, useState } from 'react';
import {
  ReaderTheme,
  ReaderThemePref,
  loadThemePref,
  resolveTheme,
  saveThemePref,
} from './themes';

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/**
 * Reader theme state: stored preference ('auto' or a theme id), resolved
 * against the system color scheme. While mounted, paints the document body
 * with the theme background so the area outside the reading column matches.
 */
export function useReaderTheme(): {
  theme: ReaderTheme;
  themePref: ReaderThemePref;
  setThemePref: (pref: ReaderThemePref) => void;
} {
  const [themePref, setPrefState] = useState<ReaderThemePref>(loadThemePref);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    // Older Safari only supports addListener/removeListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  const setThemePref = useCallback((pref: ReaderThemePref) => {
    setPrefState(pref);
    saveThemePref(pref);
  }, []);

  const theme = resolveTheme(themePref, systemDark);

  // Paint the page outside the reading column too (body shows through around
  // the max-width container). Restore on unmount so the shelf is untouched.
  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = theme.colors.bg;
    return () => {
      document.body.style.backgroundColor = prev;
    };
  }, [theme]);

  return { theme, themePref, setThemePref };
}
