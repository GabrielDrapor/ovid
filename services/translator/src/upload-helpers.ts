/**
 * Await cover/spine generation without ever rejecting. Cover art is
 * decorative — a fully parsed book is readable without it (the shelf falls
 * back to generated textures) — so a cover failure must never fail the
 * surrounding import, flip the book to 'error', or trigger a credit refund.
 */
export async function settleCoverGeneration(
  coverGeneration: Promise<unknown>,
  bookUuid: string
): Promise<void> {
  try {
    await coverGeneration;
  } catch (err) {
    console.warn(`[upload] Cover generation failed for ${bookUuid}:`, err);
  }
}
