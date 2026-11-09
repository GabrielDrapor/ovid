import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../../../src/components/BookShelf.css', () => ({}));

// Signed out unless a test sets a user. The object must keep its identity:
// BookShelf refetches whenever `user` changes.
let mockUser: {
  id: number;
  email: string;
  name: string;
  picture: string;
} | null = null;
vi.mock('../../../src/contexts/UserContext', () => ({
  useUser: () => ({
    user: mockUser,
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    credits: 5000,
    creditPackages: [],
    purchaseCredits: vi.fn(),
    refreshCredits: vi.fn(),
  }),
}));

// The closet reports a spot it would suggest for "Add book" (none when the
// wall has no empty spot). While picking, this stand-in offers one empty
// spot, the fourth bay of the first row, and a Cancel.
const SUGGESTED = {
  shelfSlotId: null,
  row: 1,
  col: 2,
  label: null,
  position: { row: 2, col: 3 },
};
let mockAddTarget: typeof SUGGESTED | null = SUGGESTED;
vi.mock('../../../src/components/shelf3d/BookShelf3D', async () => {
  const React = await import('react');
  return {
    default: ({
      onAddTargetChange,
      onUploadToSlot,
      picking,
      onCancelPick,
    }: any) => {
      React.useEffect(() => {
        onAddTargetChange?.(mockAddTarget);
      }, [onAddTargetChange]);
      return (
        <div data-testid="closet">
          {picking && (
            <>
              <button
                onClick={() =>
                  onUploadToSlot({
                    shelfSlotId: null,
                    row: 0,
                    col: 3,
                    label: null,
                    position: { row: 1, col: 4 },
                  })
                }
              >
                empty spot
              </button>
              <button onClick={onCancelPick}>cancel picking</button>
            </>
          )}
        </div>
      );
    },
  };
});

// Pretend WebGL works so BookShelf renders the closet and its dock.
(window as any).WebGLRenderingContext = function () {};
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as any;

import BookShelf from '../../../src/components/BookShelf';

global.fetch = vi.fn((input: RequestInfo | URL) =>
  Promise.resolve(
    new Response(String(input) === '/api/v2/books' ? '[]' : '{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
) as any;

const touchScreen = (touch: boolean) => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: touch && query === '(hover: none)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as any;
};

beforeEach(() => {
  mockUser = null;
  mockAddTarget = SUGGESTED;
  touchScreen(false);
});

afterEach(() => {
  delete (window as any).matchMedia;
  window.innerWidth = 1024;
});

describe('Add book in the dock', () => {
  it('tells a signed-out visitor to sign in to add their own books', async () => {
    render(<BookShelf onSelectBook={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add book' }));
    expect(
      screen.getByText('Sign in to add your own books to the shelf.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Continue with Google/ })
    ).toBeInTheDocument();
  });

  it('leaves that line out when Sign in is clicked directly', async () => {
    render(<BookShelf onSelectBook={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      screen.queryByText('Sign in to add your own books to the shelf.')
    ).not.toBeInTheDocument();
  });

  it('asks where the book goes, then opens the form for that spot', async () => {
    mockUser = { id: 1, email: 'a@b.c', name: 'A', picture: '' };
    render(<BookShelf onSelectBook={vi.fn()} />);
    await screen.findByTestId('closet');
    const add = screen.getByRole('button', { name: 'Add book' });
    fireEvent.click(add);
    expect(add).toHaveAttribute('aria-pressed', 'true');
    // No form yet: the shelf shows the empty spots first.
    expect(
      screen.queryByRole('dialog', { name: 'Add book here' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'empty spot' }));
    const form = await screen.findByRole('dialog', { name: 'Add book here' });
    expect(form).toHaveTextContent('Row 1, bay 4');
    expect(
      screen.queryByRole('button', { name: 'empty spot' })
    ).not.toBeInTheDocument();
  });

  it('stops asking on Cancel or a second click of Add book', async () => {
    mockUser = { id: 1, email: 'a@b.c', name: 'A', picture: '' };
    render(<BookShelf onSelectBook={vi.fn()} />);
    await screen.findByTestId('closet');
    const add = screen.getByRole('button', { name: 'Add book' });
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('button', { name: 'cancel picking' }));
    expect(
      screen.queryByRole('button', { name: 'empty spot' })
    ).not.toBeInTheDocument();
    expect(add).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(add);
    fireEvent.click(add);
    expect(
      screen.queryByRole('button', { name: 'empty spot' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('dialog', { name: 'Add book here' })
    ).not.toBeInTheDocument();
  });

  it('opens the form straight away when the wall has no empty spot', async () => {
    mockUser = { id: 1, email: 'a@b.c', name: 'A', picture: '' };
    mockAddTarget = null;
    render(<BookShelf onSelectBook={vi.fn()} />);
    await screen.findByTestId('closet');
    fireEvent.click(screen.getByRole('button', { name: 'Add book' }));
    expect(
      await screen.findByRole('dialog', { name: 'Upload book' })
    ).toBeInTheDocument();
  });
});

describe('shelf hints', () => {
  it('use mouse wording with a mouse', async () => {
    render(<BookShelf onSelectBook={vi.fn()} />);
    expect(
      await screen.findByText(
        'Move to look around · Scroll to zoom · Click to open'
      )
    ).toBeInTheDocument();
  });

  it('use touch wording on a touch screen', async () => {
    touchScreen(true);
    render(<BookShelf onSelectBook={vi.fn()} />);
    expect(
      await screen.findByText(
        'Drag to look around · Pinch to zoom · Tap to open'
      )
    ).toBeInTheDocument();
  });

  it('show on phones above the dock until the first touch', async () => {
    touchScreen(true);
    window.innerWidth = 375;
    const { container } = render(<BookShelf onSelectBook={vi.fn()} />);
    await screen.findByTestId('closet');
    await waitFor(() =>
      expect(container.querySelector('.closet-touch-hint')).toHaveTextContent(
        'Drag to look around'
      )
    );
    fireEvent.pointerDown(screen.getByTestId('closet'));
    expect(container.querySelector('.closet-touch-hint')).toBeNull();
  });
});
