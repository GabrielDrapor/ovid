/**
 * Book cover generator using Google Gemini Nano Banana Pro
 * Generates book cover and spine images based on book metadata
 */

import { GoogleGenAI, Modality } from '@google/genai';

export interface BookMetadata {
  title: string;
  originalTitle?: string;
  author: string;
}

export interface GeneratedCovers {
  coverImageBase64: string;
  spineImageBase64: string;
  coverMimeType: string;
  spineMimeType: string;
}

export class CoverGenerator {
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model: string = 'gemini-2.0-flash-exp') {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  /**
   * Generate book cover image
   */
  async generateCover(metadata: BookMetadata): Promise<{ base64: string; mimeType: string }> {
    const prompt = this.buildCoverPrompt(metadata);

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
        },
      });

      // Extract image from response
      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts) {
        throw new Error('No response parts received');
      }

      for (const part of parts) {
        if (part.inlineData?.data && part.inlineData?.mimeType) {
          return {
            base64: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          };
        }
      }

      throw new Error('No image found in response');
    } catch (error) {
      console.error('Cover generation failed:', error);
      throw error;
    }
  }

  /**
   * Generate book spine image
   */
  async generateSpine(metadata: BookMetadata): Promise<{ base64: string; mimeType: string }> {
    const prompt = this.buildSpinePrompt(metadata);

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
        },
      });

      // Extract image from response
      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts) {
        throw new Error('No response parts received');
      }

      for (const part of parts) {
        if (part.inlineData?.data && part.inlineData?.mimeType) {
          return {
            base64: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          };
        }
      }

      throw new Error('No image found in response');
    } catch (error) {
      console.error('Spine generation failed:', error);
      throw error;
    }
  }

  /**
   * Generate both cover and spine images
   */
  async generateBoth(metadata: BookMetadata): Promise<GeneratedCovers> {
    // Generate cover and spine in parallel
    const [cover, spine] = await Promise.all([
      this.generateCover(metadata),
      this.generateSpine(metadata),
    ]);

    return {
      coverImageBase64: cover.base64,
      spineImageBase64: spine.base64,
      coverMimeType: cover.mimeType,
      spineMimeType: spine.mimeType,
    };
  }

  /**
   * Build prompt for cover image generation
   */
  private buildCoverPrompt(metadata: BookMetadata): string {
    const title = metadata.originalTitle || metadata.title;
    const author = metadata.author || 'Unknown Author';

    return `Generate a beautiful, professional book cover image for a book with the following details:

Title: "${title}"
Author: ${author}

Requirements:
- Create an elegant, artistic book cover design
- The cover should be in portrait orientation (aspect ratio approximately 2:3)
- Include the book title "${title}" prominently on the cover with clear, legible typography
- Include the author name "${author}" on the cover
- Use a sophisticated color palette that evokes literary elegance
- The design should look like a real published book cover
- Make the text sharp and readable
- Do NOT include any placeholder text like "TITLE" or "AUTHOR" - use the actual title and author provided

Generate only the book cover image, nothing else.`;
  }

  /**
   * Build prompt for spine image generation
   */
  private buildSpinePrompt(metadata: BookMetadata): string {
    const title = metadata.originalTitle || metadata.title;
    const author = metadata.author || 'Unknown Author';

    return `Generate a book spine image for a book with the following details:

Title: "${title}"
Author: ${author}

Requirements:
- Create a vertical book spine design (tall and narrow, approximately 1:6 aspect ratio width:height)
- The spine should look realistic, like the edge of a hardcover or paperback book
- Include the book title "${title}" written vertically (rotated 90 degrees, readable when the book is standing on a shelf)
- Include the author name "${author}" written vertically
- Use elegant typography that matches a literary book
- Use a color that would complement a book cover
- Make the text sharp and readable even at small sizes
- The design should look like a real book spine you'd see on a bookshelf
- Do NOT include any placeholder text - use the actual title and author provided

Generate only the book spine image, nothing else.`;
  }
}

/**
 * Upload generated image to R2 bucket and return the public URL
 */
export async function uploadCoverToR2(
  bucket: R2Bucket,
  imageBase64: string,
  mimeType: string,
  bookUuid: string,
  imageType: 'cover' | 'spine'
): Promise<string> {
  const extension = mimeType.split('/')[1] || 'png';
  const key = `${bookUuid}/${imageType}.${extension}`;

  // Convert base64 to ArrayBuffer
  const binaryString = atob(imageBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  await bucket.put(key, bytes.buffer, {
    httpMetadata: {
      contentType: mimeType,
    },
  });

  // Return the public URL (assuming the bucket is configured for public access)
  // The URL format depends on your R2 public access configuration
  return `/api/covers/${key}`;
}
