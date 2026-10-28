import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import './Dialogs.css';

// In-app replacements for window.confirm and window.alert, styled like the
// shelf's paper cards. Both come as hooks that return a function to call and
// an element to render, so a screen needs no provider to use them.

// Open dialogs, oldest first. Escape closes only the newest one, so a
// dialog opened on top of another (buy credits over the upload form, a
// confirm over a book card) never takes the one underneath with it.
const escapeLayers: Array<() => void> = [];

function onEscapeKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || escapeLayers.length === 0) return;
  // Capture phase on document, so the menus and panels underneath that
  // listen for Escape themselves don't also close.
  e.stopPropagation();
  escapeLayers[escapeLayers.length - 1]();
}

/** Register an open dialog: Escape calls `onEscape` while it is the newest
 *  open one. Pass `active: false` to leave the stack (e.g. while busy). */
export function useEscapeLayer(onEscape: () => void, active = true) {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const layer = () => handlerRef.current();
    escapeLayers.push(layer);
    if (escapeLayers.length === 1) {
      document.addEventListener('keydown', onEscapeKey, true);
    }
    return () => {
      escapeLayers.splice(escapeLayers.indexOf(layer), 1);
      if (escapeLayers.length === 0) {
        document.removeEventListener('keydown', onEscapeKey, true);
      }
    };
  }, [active]);
}

/** True while any layer from useEscapeLayer is open, e.g. so arrow keys
 *  don't turn pages behind a panel. */
export const hasOpenLayer = () => escapeLayers.length > 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * While `active`, keyboard focus belongs to the element in `ref`: it moves
 * to `initial()` (or the first control) on open, Tab wraps inside it when
 * `trap` is set, and on close it goes back where it was, or to `fallback()`
 * when that element is gone (e.g. a menu item that closed with its menu).
 * Focus moves never scroll the page.
 */
export function useFocusReturn(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  {
    initial,
    fallback,
    trap = false,
  }: {
    initial?: () => HTMLElement | null | undefined;
    fallback?: () => HTMLElement | null | undefined;
    trap?: boolean;
  } = {}
) {
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = document.activeElement as HTMLElement | null;
    const first =
      initialRef.current?.() ??
      root.querySelector<HTMLElement>(FOCUSABLE) ??
      root;
    first.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (!trap || e.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === items[0]) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        items[0].focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      // Leave focus alone if it already moved somewhere else on purpose.
      const now = document.activeElement;
      if (now && now !== document.body && !root.contains(now)) return;
      const back =
        previous && previous.isConnected && previous !== document.body
          ? previous
          : fallbackRef.current?.();
      back?.focus({ preventScroll: true });
    };
  }, [ref, active, trap]);
}

// Open scroll locks; the page scrolls again when the last one closes.
let scrollLocks = 0;

/** Keep the page behind an open panel from scrolling. Only `overflow`
 *  changes, so the page stays where it was (the reader saves progress from
 *  what is on screen); a classic scrollbar's width is padded so the text
 *  doesn't reflow. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (scrollLocks++ === 0) {
      const scrollbar = window.innerWidth - root.clientWidth;
      root.style.overflow = 'hidden';
      if (scrollbar > 0) root.style.paddingRight = `${scrollbar}px`;
    }
    return () => {
      if (--scrollLocks === 0) {
        root.style.overflow = '';
        root.style.paddingRight = '';
      }
    };
  }, [active]);
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Red confirm button, for actions that can't be undone. */
  destructive?: boolean;
}

interface ConfirmDialogProps extends ConfirmOptions {
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}) => {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEscapeLayer(onCancel);

  useEffect(() => {
    // Focus starts on Cancel, so Enter never confirms a destructive action
    // by accident; focus goes back where it was when the dialog closes.
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div className="ov-dialog-overlay" onClick={onCancel}>
      <div
        className="ov-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ov-dialog-title"
        aria-describedby={message ? 'ov-dialog-message' : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="ov-dialog-title" className="ov-dialog-title">
          {title}
        </h2>
        {message && (
          <p id="ov-dialog-message" className="ov-dialog-message">
            {message}
          </p>
        )}
        <div className="ov-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="ov-dialog-btn"
            onClick={onCancel}
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            className={`ov-dialog-btn ov-dialog-btn-primary${
              destructive ? ' ov-dialog-btn-danger' : ''
            }`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * `const [confirm, confirmDialog] = useConfirm();` then
 * `if (!(await confirm({ ... }))) return;` and render `{confirmDialog}`.
 */
export function useConfirm(): [
  (options: ConfirmOptions) => Promise<boolean>,
  React.ReactNode,
] {
  const [request, setRequest] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    []
  );

  const settle = useCallback(
    (ok: boolean) => {
      request?.resolve(ok);
      setRequest(null);
    },
    [request]
  );
  const onCancel = useCallback(() => settle(false), [settle]);
  const onConfirm = useCallback(() => settle(true), [settle]);

  const dialog = request ? (
    <ConfirmDialog
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      destructive={request.destructive}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  ) : null;

  return [confirm, dialog];
}

export interface ToastOptions {
  message: string;
  /** Smaller second line, e.g. the server's own error text. */
  detail?: string;
  tone?: 'error' | 'info';
}

// Errors stay a little longer, since they usually need reading.
const TOAST_MS = { error: 7000, info: 4000 };

/**
 * `const [showToast, toast] = useToast();` then `showToast({ message })` and
 * render `{toast}`. One toast at a time; a new one replaces the old.
 */
export function useToast(): [(options: ToastOptions) => void, React.ReactNode] {
  const { t } = useI18n();
  const [toast, setToast] = useState<(ToastOptions & { id: number }) | null>(
    null
  );

  const showToast = useCallback((options: ToastOptions) => {
    setToast({ ...options, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => setToast(null),
      TOAST_MS[toast.tone ?? 'info']
    );
    return () => clearTimeout(timer);
  }, [toast]);

  const element = toast ? (
    <div
      key={toast.id}
      className={`ov-toast ov-toast-${toast.tone ?? 'info'}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="ov-toast-text">
        <span>{toast.message}</span>
        {toast.detail && toast.detail !== toast.message && (
          <span className="ov-toast-detail">{toast.detail}</span>
        )}
      </div>
      <button
        type="button"
        className="ov-toast-close"
        aria-label={t.common.close}
        onClick={() => setToast(null)}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  ) : null;

  return [showToast, element];
}

/** Second line for an error toast: the server's own message when it sent
 *  one. A TypeError is the browser's "Failed to fetch", which says less than
 *  the headline, so it is left out. */
export function errorDetail(err: unknown): string | undefined {
  if (err instanceof TypeError) return undefined;
  return err instanceof Error && err.message ? err.message : undefined;
}
