import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  errorDetail,
  useConfirm,
  useToast,
} from '../../../src/components/Dialogs';

function ConfirmHarness({ onResult }: { onResult: (ok: boolean) => void }) {
  const [confirm, dialog] = useConfirm();
  return (
    <>
      <button
        onClick={async () =>
          onResult(
            await confirm({
              title: 'Remove this book?',
              message: 'This can’t be undone.',
              confirmLabel: 'Remove',
              destructive: true,
            })
          )
        }
      >
        open
      </button>
      {dialog}
    </>
  );
}

function ToastHarness() {
  const [showToast, toast] = useToast();
  return (
    <>
      <button
        onClick={() =>
          showToast({
            tone: 'error',
            message: 'Couldn’t remove the book',
            detail: 'Book not found',
          })
        }
      >
        fail
      </button>
      {toast}
    </>
  );
}

describe('useConfirm', () => {
  it('starts on Cancel and resolves false when cancelled', async () => {
    const onResult = vi.fn();
    render(<ConfirmHarness onResult={onResult} />);
    fireEvent.click(screen.getByText('open'));

    const dialog = screen.getByRole('alertdialog', {
      name: 'Remove this book?',
    });
    expect(dialog).toHaveAccessibleDescription('This can’t be undone.');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();

    await act(async () => fireEvent.click(cancel));
    expect(onResult).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('resolves true when confirmed', async () => {
    const onResult = vi.fn();
    render(<ConfirmHarness onResult={onResult} />);
    fireEvent.click(screen.getByText('open'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    );
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it('cancels on Escape and on a click outside the card', async () => {
    const onResult = vi.fn();
    render(<ConfirmHarness onResult={onResult} />);

    fireEvent.click(screen.getByText('open'));
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(onResult).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByText('open'));
    const overlay = document.querySelector('.ov-dialog-overlay')!;
    await act(async () => fireEvent.click(overlay));
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenLastCalledWith(false);
  });
});

describe('useToast', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the message with its detail, then goes away by itself', () => {
    vi.useFakeTimers();
    render(<ToastHarness />);
    fireEvent.click(screen.getByText('fail'));

    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('Couldn’t remove the book');
    expect(toast).toHaveTextContent('Book not found');

    act(() => {
      vi.advanceTimersByTime(7100);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('can be closed', () => {
    render(<ToastHarness />);
    fireEvent.click(screen.getByText('fail'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('errorDetail', () => {
  it('passes server messages through but drops the browser’s network error', () => {
    expect(errorDetail(new Error('Book not found'))).toBe('Book not found');
    expect(errorDetail(new TypeError('Failed to fetch'))).toBeUndefined();
    expect(errorDetail('nope')).toBeUndefined();
  });
});
