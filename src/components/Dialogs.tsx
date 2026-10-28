import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import './Dialogs.css';

// In-app replacements for window.confirm and window.alert, styled like the
// shelf's paper cards. Both come as hooks that return a function to call and
// an element to render, so a screen needs no provider to use them.

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

  useEffect(() => {
    // Focus starts on Cancel, so Enter never confirms a destructive action
    // by accident; focus goes back where it was when the dialog closes.
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    // Capture phase: the dialog sits on top, so it answers Escape before
    // whatever is underneath (a book panel, a menu) does.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onCancel]);

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
