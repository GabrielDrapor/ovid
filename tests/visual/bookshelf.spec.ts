import { test, expect } from '@playwright/test';

// Mock book data matching production structure
const MOCK_BOOKS = [
  {
    id: 1,
    uuid: 'test-book-1',
    title: '血字的研究',
    original_title: 'A Study in Scarlet',
    author: 'Sir Arthur Conan Doyle',
    language_pair: 'en-zh',
    book_cover_img_url: null,
    book_spine_img_url: null,
    user_id: null,
    status: 'ready',
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
  },
  {
    id: 2,
    uuid: 'test-book-2',
    title: '四签名',
    original_title: 'The Sign of the Four',
    author: 'Sir Arthur Conan Doyle',
    language_pair: 'en-zh',
    book_cover_img_url: null,
    book_spine_img_url: null,
    user_id: null,
    status: 'ready',
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
  },
];

const MOCK_USER_BOOKS = [
  {
    id: 10,
    uuid: 'user-book-1',
    title: '局外人',
    original_title: 'The Stranger',
    author: 'Albert Camus',
    language_pair: 'en-zh',
    book_cover_img_url: null,
    book_spine_img_url: null,
    user_id: 1,
    status: 'ready',
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
  },
];

// The classic 2D shelf is now only a fallback for browsers without WebGL.
// Snapshot tests force that path by stubbing out the WebGL contexts; the 3D
// closet gets a smoke test (WebGL output is not pixel-stable enough for
// snapshot comparison).
const disableWebGL = () => {
  const original = HTMLCanvasElement.prototype.getContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function (
    type: string,
    ...args: unknown[]
  ) {
    if (
      type === 'webgl' ||
      type === 'webgl2' ||
      type === 'experimental-webgl'
    ) {
      return null;
    }
    return (original as any).call(this, type, ...args);
  };
};

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
    await page.addInitScript(disableWebGL);
    await page.goto('/');
    // Wait for books to render (opacity transition)
    await page.waitForTimeout(1000);

    // Screenshot the entire bookshelf wall (the key area)
    const wall = page.locator('.bookshelf-wall');
    await expect(wall).toHaveScreenshot('bookshelf-wall.png', {
      maxDiffPixelRatio: 0.01, // 1% tolerance for antialiasing
    });
  });

  test('book spine positions relative to shelf background', async ({
    page,
  }) => {
    await page.addInitScript(disableWebGL);
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
    await page.addInitScript(disableWebGL);
    await page.goto('/');
    await page.waitForTimeout(1000);

    await expect(page).toHaveScreenshot('bookshelf-full.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('3d closet view renders a WebGL canvas by default', async ({ page }) => {
    await page.goto('/');

    // The closet is lazy-loaded; wait for its canvas to appear.
    await expect(page.locator('.closet3d-root canvas')).toBeVisible({
      timeout: 15000,
    });
  });

  test('falls back to the classic shelf without WebGL', async ({ page }) => {
    await page.addInitScript(disableWebGL);
    await page.goto('/');
    await expect(
      page.locator('.bookshelf-wall:not(.closet-mode)')
    ).toBeVisible();
    await expect(page.locator('.book-spine-container').first()).toBeVisible();
  });
});
