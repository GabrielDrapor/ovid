import React from 'react';
import { themeCssVars } from '../reader/themes';
import { useReaderTheme } from '../reader/useReaderTheme';
import './BilingualReader.css';

// Full-page message shown in place of the reader while a book loads. It uses
// the reader's theme, so a dark-theme reader doesn't see a white page first.
const ReaderStatus: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { theme } = useReaderTheme();
  return (
    <div
      className="reader-status"
      role="status"
      style={themeCssVars(theme) as React.CSSProperties}
    >
      {children}
    </div>
  );
};

export default ReaderStatus;
