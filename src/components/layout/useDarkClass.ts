import { useEffect, useState } from 'react';

/**
 * Tracks the app's class-based dark mode: AppLayout's theme toggle flips the
 * `dark` class on <html> (persisted under 'myhrms:theme'). Components mounted
 * outside AppLayout (e.g. the app-level sonner Toaster) observe that class
 * here instead of next-themes, which this app deliberately does not wire up.
 */
export function useDarkClass(): boolean {
  const [dark, setDark] = useState<boolean>(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setDark(el.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
