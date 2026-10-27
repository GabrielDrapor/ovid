import React from 'react';
import { themeCssVars } from '../reader/themes';
import { useReaderTheme } from '../reader/useReaderTheme';
import './BilingualReader.css';

interface ReaderStatusProps {
  title?: string;
  /** The message: what is happening, or what went wrong. */
  children?: React.ReactNode;
  /** Small technical line under the message, e.g. an HTTP status. */
  detail?: string;
  /** Buttons; give the main one the class reader-status-btn-primary. */
  actions?: React.ReactNode;
}

// Full-page message shown in place of the reader: while a book loads, or when
// it can't be shown. It uses the reader's theme, so a dark-theme reader
// doesn't see a white page first.
const ReaderStatus: React.FC<ReaderStatusProps> = ({
  title,
  children,
  detail,
  actions,
}) => {
  const { theme } = useReaderTheme();
  return (
    <div
      className="reader-status"
      role="status"
      style={themeCssVars(theme) as React.CSSProperties}
    >
      {title && <h1 className="reader-status-title">{title}</h1>}
      {children && <p className="reader-status-message">{children}</p>}
      {detail && <p className="reader-status-detail">{detail}</p>}
      {actions && <div className="reader-status-actions">{actions}</div>}
    </div>
  );
};

export default ReaderStatus;
