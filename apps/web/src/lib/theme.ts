'use client';

import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

const snapshot = (): Theme =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
const serverSnapshot = (): Theme => 'dark';

/** The active theme, read from the <html data-theme> attribute (the single source of truth). */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const toggle = useCallback(() => {
    const next: Theme = snapshot() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('tf-theme', next);
    } catch {
      /* storage may be unavailable; the theme still applies for this session */
    }
  }, []);
  return { theme, toggle };
}

const noopSubscribe = () => () => undefined;

/** False during server rendering and hydration, true afterwards, without a setState-in-effect. */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
