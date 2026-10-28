import { useEffect, useState } from 'react';

/**
 * Whether a book has chapters to read. A book whose translation failed
 * keeps what was parsed before the failure; when that includes chapters,
 * the original can still be read. Pass null to skip the request.
 */
export function useChaptersAvailable(bookUuid: string | null): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(false);
    if (!bookUuid) return;
    const controller = new AbortController();
    fetch(`/api/book/${bookUuid}/chapters`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : []))
      .then((chapters: unknown) =>
        setAvailable(Array.isArray(chapters) && chapters.length > 0)
      )
      .catch(() => {
        // Aborted or offline: offer nothing rather than a broken button.
      });
    return () => controller.abort();
  }, [bookUuid]);
  return available;
}
