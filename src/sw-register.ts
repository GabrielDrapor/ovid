/**
 * Service worker registration + "new version available" prompt.
 *
 * The SW (public/sw.js) intentionally does NOT skipWaiting on install, so a new
 * build sits in "waiting" until the user taps Refresh. We detect that, show a
 * small toast, and on accept tell the worker to activate and reload once it
 * takes control. Registered in production builds only.
 */

import { detectLocale, getMessages } from './i18n';

const ACCENT = '#4ade80'; // app's green accent (see BookShelf.css)

function showUpdateToast(onRefresh: () => void): void {
  if (document.getElementById('sw-update-toast')) return;
  const t = getMessages(detectLocale());

  const toast = document.createElement('div');
  toast.id = 'sw-update-toast';
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:calc(env(safe-area-inset-bottom, 0px) + 20px)',
    'transform:translateX(-50%) translateY(8px)',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'max-width:calc(100vw - 32px)',
    'padding:10px 10px 10px 16px',
    'border-radius:999px',
    'background:rgba(28,28,30,0.96)',
    'color:#fff',
    'font:500 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'box-shadow:0 8px 28px rgba(0,0,0,0.4)',
    'border:1px solid rgba(255,255,255,0.12)',
    'z-index:2147483000',
    'opacity:0',
    'transition:opacity .2s ease, transform .2s ease',
  ].join(';');

  const label = document.createElement('span');
  label.textContent = t.pwa.newVersion;
  label.style.cssText =
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t.pwa.refresh;
  btn.style.cssText = [
    'flex:0 0 auto',
    'border:0',
    'cursor:pointer',
    `background:${ACCENT}`,
    'color:#05291a',
    'font:600 14px/1 inherit',
    'padding:8px 16px',
    'border-radius:999px',
  ].join(';');
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = t.pwa.updating;
    onRefresh();
  });

  toast.appendChild(label);
  toast.appendChild(btn);
  document.body.appendChild(toast);

  // Trigger the entrance transition on the next frame.
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
}

export function registerServiceWorker(): void {
  if (
    !('serviceWorker' in navigator) ||
    process.env.NODE_ENV !== 'production'
  ) {
    return;
  }

  window.addEventListener('load', () => {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        const promote = (worker: ServiceWorker | null) => {
          if (!worker) return;
          // Only prompt for an UPDATE (a controller already exists) — the very
          // first install shouldn't nag the user.
          if (!navigator.serviceWorker.controller) return;
          showUpdateToast(() => worker.postMessage({ type: 'SKIP_WAITING' }));
        };

        if (reg.waiting) promote(reg.waiting);

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed') promote(reg.waiting);
          });
        });
      })
      .catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
  });
}
