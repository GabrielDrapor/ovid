import React from 'react';
import './Icon.css';

// Small line icons shared by the reader and the shelf. They are drawn on a
// 24×24 grid in the same stroke style as the shelf's trash icon, take the
// surrounding text colour, and default to the surrounding font size. They are
// decorative: the control that wraps one carries the accessible name.
export type IconName =
  | 'close'
  | 'check'
  | 'chevron-right'
  | 'arrow-right'
  | 'plus'
  | 'minus'
  | 'theme-auto';

const SHAPES: Record<IconName, React.ReactNode> = {
  close: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'arrow-right': <path d="M5 12h14M12 5l7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  // Half-filled circle: follow the system's light/dark setting.
  'theme-auto': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  /** Rendered width and height; defaults to the surrounding font size. */
  size?: number | string;
  className?: string;
}

export const Icon: React.FC<IconProps> = ({
  name,
  size = '1em',
  className,
}) => (
  <svg
    className={className ? `ov-icon ${className}` : 'ov-icon'}
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {SHAPES[name]}
  </svg>
);

// Inline busy indicator for a button or value that is still loading. Like
// Icon, it is sized and coloured by the text it stands in for. The
// zero-width space keeps one line of text's height, so swapping a label for
// the spinner doesn't make its button shorter or taller.
export const Spinner: React.FC<{ className?: string }> = ({ className }) => (
  <span
    className={className ? `ov-spinner-line ${className}` : 'ov-spinner-line'}
    aria-hidden="true"
  >
    {'​'}
    <span className="ov-spinner" />
  </span>
);
