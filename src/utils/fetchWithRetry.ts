/**
 * Fetch with retry logic for network errors and 5xx responses.
 * Retries up to 3 times with exponential backoff (300ms, 900ms, 2700ms).
 * Does NOT retry on 4xx errors.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(input, init);

      // Don't retry on success or 4xx client errors
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }

      // 5xx server error - retry if we have attempts left
      if (attempt < maxRetries) {
        const delay = 300 * Math.pow(3, attempt); // 300ms, 900ms, 2700ms
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      return response;
    } catch (error) {
      // Network error - retry if we have attempts left
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delay = 300 * Math.pow(3, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  throw lastError || new Error('fetchWithRetry failed');
}
