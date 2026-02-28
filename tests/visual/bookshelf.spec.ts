import { test, expect } from '@playwright/test';

// Mock book data matching production structure
const MOCK_BOOKS = [
  {
    id: 1, uuid: 'test-book-1', title: '血字的研究', original_title: 'A Study in Scarlet',
    author: 'Sir Arthur Conan Doyle', language_pair: 'en-zh',
    book_cover_img_url: null, book_spine_img_url: null,
    user_id: null, status: 'ready', created_at: '2025-01-01', updated_at: '2025-01-01',
  },
  {
    id: 2, uuid: 'test-book-2', title: '四签名', original_title: 'The Sign of the Four',
    author: 'Sir Arthur Conan Doyle', language_pair: 'en-zh',
    book_cover_img_url: null, book_spine_img_url: null,
    user_id: null, status: 'ready', created_at: '2025-01-01', updated_at: '2025-01-01',
  },
];

const MOCK_USER_BOOKS = [
  {
    id: 10, uuid: 'user-book-1', title: '局外人', original_title: 'The Stranger',
    author: 'Albert Camus', language_pair: 'en-zh',
    book_cover_img_url: null, book_spine_img_url: null,
    user_id: 1, status: 'ready', created_at: '2025-01-01', updated_at: '2025-01-01',
  },
];

test.describe('Bookshelf Visual Regression', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the books API
    await page.route('**/api/v2/books', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([...MOCK_BOOKS, ...MOCK_USER_BOOKS]),
      });
    });

    // Mock progress API
    await page.route('**/api/book/*/progress', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ progress: null }),
      });
    });
  });

  test('bookshelf layout - books aligned on shelves', async ({ page }) => {
    await page.goto('/');
    // Wait for books to render (opacity transition)
    await page.waitForTimeout(1000);

    // Screenshot the entire bookshelf wall (the key area)
    const wall = page.locator('.bookshelf-wall');
    await expect(wall).toHaveScreenshot('bookshelf-wall.png', {
      maxDiffPixelRatio: 0.01, // 1% tolerance for antialiasing
    });
  });

  test('book spine positions relative to shelf background', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Screenshot each shelf row individually for regression comparison
    const rows = page.locator('[class*="books-row"]');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toHaveScreenshot(`shelf-row-${i}.png`, {
        maxDiffPixelRatio: 0.01,
      });
    }
  });

  test('full page screenshot', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    await expect(page).toHaveScreenshot('bookshelf-full.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
