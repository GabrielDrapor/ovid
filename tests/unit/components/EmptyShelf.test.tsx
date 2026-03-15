import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock CSS import
vi.mock('../../../src/components/BookShelf.css', () => ({}));

const mockLogin = vi.fn();

// Track mock state so tests can change it
let mockUserState: any = {
  user: null,
  loading: false,
  login: mockLogin,
  logout: vi.fn(),
  credits: 0,
  creditPackages: [],
  purchaseCredits: vi.fn(),
  refreshCredits: vi.fn(),
};

vi.mock('../../../src/contexts/UserContext', () => ({
  useUser: () => mockUserState,
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;
global.confirm = vi.fn(() => true);
global.alert = vi.fn();

import BookShelf from '../../../src/components/BookShelf';

describe('Empty Bookshelf Guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserState = {
      user: null,
      loading: false,
      login: mockLogin,
      logout: vi.fn(),
      credits: 0,
      creditPackages: [],
      purchaseCredits: vi.fn(),
      refreshCredits: vi.fn(),
    };
  });

  it('shows welcome message when shelf is empty and user is not logged in', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<BookShelf onSelectBook={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to Ovid')).toBeInTheDocument();
    });

    expect(screen.getByText(/双语阅读器/)).toBeInTheDocument();
    expect(screen.getByText('Sign in to get started')).toBeInTheDocument();
  });

  it('shows upload button when shelf is empty and user is logged in', async () => {
    mockUserState = {
      ...mockUserState,
      user: { id: 1, email: 'test@test.com', name: 'Test', picture: '' },
      credits: 5000,
    };

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] })  // books
      .mockResolvedValueOnce({ ok: true, json: async () => ({ progress: {} }) });  // progress

    render(<BookShelf onSelectBook={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to Ovid')).toBeInTheDocument();
    });

    expect(screen.getByText('Upload your first book')).toBeInTheDocument();
  });

  it('does not show welcome message when books exist', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 1, uuid: 'book-1', title: 'Test Book', original_title: 'Test Book',
          author: 'Author', language_pair: 'en-zh', book_cover_img_url: null,
          book_spine_img_url: null, user_id: null, status: 'ready',
          created_at: '2025-01-01', updated_at: '2025-01-01',
        },
      ],
    });

    render(<BookShelf onSelectBook={vi.fn()} />);

    // Wait for books to load
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Ovid')).not.toBeInTheDocument();
    });
  });
});
