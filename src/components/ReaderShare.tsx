import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { ConfirmOptions } from './Dialogs';
import { Icon, Spinner } from './Icon';

interface ReaderShareProps {
  /** The book's share link, or null while it has none. */
  url: string | null;
  onCreate: () => Promise<void>;
  onStop: () => Promise<void>;
  /** From useConfirm, rendered by the reader so it sits above the menu. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

type Status = { tone: 'ok' | 'error'; text: string };

/**
 * The Share page of the reader menu. The link is shown in full, so it can
 * be copied by hand when the clipboard isn't available; copying says
 * whether it worked, and stopping the share asks first, because every link
 * already sent stops working.
 */
const ReaderShare: React.FC<ReaderShareProps> = ({
  url,
  onCreate,
  onStop,
  confirm,
}) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'create' | 'stop' | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  // After creating or stopping, focus moves to the button that replaced
  // the one just pressed.
  const [focusNext, setFocusNext] = useState<'copy' | 'create' | null>(null);
  const canShareVia =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (status?.tone !== 'ok') return;
    const timer = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  const run = async (
    kind: 'create' | 'stop',
    action: () => Promise<void>,
    failed: string
  ) => {
    setBusy(kind);
    setStatus(null);
    try {
      await action();
      setFocusNext(kind === 'create' ? 'copy' : 'create');
    } catch {
      setStatus({ tone: 'error', text: failed });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setStatus({ tone: 'ok', text: t.reader.copied });
    } catch {
      // No clipboard (or no permission): select the link for a manual copy.
      linkRef.current?.select();
      setStatus({ tone: 'error', text: t.reader.copyFailed });
    }
  };

  const shareVia = async () => {
    if (!url) return;
    try {
      await navigator.share({ url });
    } catch {
      // Closing the share sheet rejects too; nothing to report.
    }
  };

  const stop = async () => {
    const ok = await confirm({
      title: t.reader.stopSharingTitle,
      message: t.reader.stopSharingMessage,
      confirmLabel: t.reader.stopSharing,
      destructive: true,
    });
    if (ok) await run('stop', onStop, t.book.revokeShareFailed);
  };

  return (
    <div className="fab-share">
      <p className="fab-share-note">{t.reader.shareIntro}</p>
      {url ? (
        <>
          <input
            ref={linkRef}
            className="fab-share-link"
            type="text"
            readOnly
            value={url}
            aria-label={t.reader.shareLink}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="fab-share-actions">
            <button
              type="button"
              className="fab-share-btn fab-share-btn-primary"
              autoFocus={focusNext === 'copy'}
              onClick={copy}
            >
              {t.reader.copyLink}
            </button>
            {canShareVia && (
              <button
                type="button"
                className="fab-share-btn"
                onClick={shareVia}
              >
                {t.reader.shareVia}
              </button>
            )}
          </div>
        </>
      ) : (
        <button
          type="button"
          className="fab-share-btn fab-share-btn-primary"
          autoFocus={focusNext === 'create'}
          disabled={busy !== null}
          onClick={() => run('create', onCreate, t.book.createShareFailed)}
        >
          {busy === 'create' ? <Spinner /> : t.reader.createShareLink}
        </button>
      )}
      {status && (
        <p
          className={`fab-share-status fab-share-status-${status.tone}`}
          role={status.tone === 'error' ? 'alert' : 'status'}
        >
          {status.tone === 'ok' && <Icon name="check" />}
          {status.text}
        </p>
      )}
      {url && (
        <button
          type="button"
          className="fab-share-stop"
          disabled={busy !== null}
          onClick={stop}
        >
          {busy === 'stop' ? <Spinner /> : t.reader.stopSharing}
        </button>
      )}
    </div>
  );
};

export default ReaderShare;
