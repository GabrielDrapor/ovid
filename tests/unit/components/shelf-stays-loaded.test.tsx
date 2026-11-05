import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom';

// Going back from a book to the shelf used to mount the shelf again, so the
// whole 3D wall loaded from scratch every time.

const shelfMounts = vi.fn();
const shelfActive: boolean[] = [];
vi.mock('../../../src/components/BookShelf', () => ({
  default: ({ onSelectBook, active }: any) => {
    React.useEffect(() => shelfMounts(), []);
    shelfActive.push(active);
    return <button onClick={() => onSelectBook('book-1')}>open book</button>;
  },
}));
vi.mock('../../../src/AppV2', () => ({
  default: ({ onBackToShelf }: any) => (
    <button onClick={onBackToShelf}>back to shelf</button>
  ),
}));
const providerMounts = vi.fn();
vi.mock('../../../src/contexts/UserContext', () => ({
  UserProvider: ({ children }: any) => {
    React.useEffect(() => providerMounts(), []);
    return <>{children}</>;
  },
}));

import App from '../../../src/App';

beforeEach(() => {
  shelfMounts.mockClear();
  providerMounts.mockClear();
  shelfActive.length = 0;
  window.history.replaceState({}, '', '/');
});

describe('shelf stays loaded while reading', () => {
  it('keeps one shelf and one sign-in provider across opening a book and going back', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'open book' }));
    expect(window.location.pathname).toBe('/book/book-1');
    expect(shelfActive[shelfActive.length - 1]).toBe(false);
    // Hidden, not removed: the shelf's button is still in the document.
    expect(
      screen.getByRole('button', { name: 'open book', hidden: true })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'back to shelf' }));
    expect(shelfActive[shelfActive.length - 1]).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'back to shelf' })
    ).not.toBeInTheDocument();
    expect(shelfMounts).toHaveBeenCalledTimes(1);
    expect(providerMounts).toHaveBeenCalledTimes(1);
  });

  it('does not load the shelf for a book opened straight from a link', () => {
    window.history.replaceState({}, '', '/book/book-1');
    render(<App />);
    expect(
      screen.getByRole('button', { name: 'back to shelf' })
    ).toBeInTheDocument();
    expect(shelfMounts).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'back to shelf' }));
    });
    expect(shelfMounts).toHaveBeenCalledTimes(1);
  });
});
