#!/usr/bin/env ts-node

/**
 * Simple UUID v4 generator for books
 * This generates a proper UUID v4 format for use when adding new books
 */

function generateUUID(): string {
  // Generate UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Generate a new UUID
const uuid = generateUUID();
console.log(uuid);

export { generateUUID };
