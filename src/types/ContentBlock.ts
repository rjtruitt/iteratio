/** Union of multi-modal content block types. */
export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

/** Plain text content block. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** Image content block with base64 or URL source. */
export interface ImageBlock {
  type: 'image';
  source: ImageSource;
}

/** Image source -- either inline base64 or a URL reference. */
export type ImageSource = Base64ImageSource | URLImageSource;

/** Base64-encoded image data with MIME type. */
export interface Base64ImageSource {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

/** URL-referenced image source. */
export interface URLImageSource {
  type: 'url';
  url: string;
}

/** Document content block (PDF, etc.) with optional extracted text. */
export interface DocumentBlock {
  type: 'document';
  source: DocumentSource;
  text?: string;
  metadata?: {
    filename?: string;
    mimeType?: string;
    size?: number;
    pages?: number;
  };
}

/** Document source -- either inline base64 or a URL reference. */
export type DocumentSource = Base64DocumentSource | URLDocumentSource;

/** Base64-encoded document data with MIME type. */
export interface Base64DocumentSource {
  type: 'base64';
  media_type: string;
  data: string;
}

/** URL-referenced document source. */
export interface URLDocumentSource {
  type: 'url';
  url: string;
}

/** Create a text content block. */
export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

/** Create a base64 image content block. */
export function imageBlock(
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
  data: string
): ImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data }
  };
}

/** Create a URL-referenced image content block. */
export function imageBlockFromURL(url: string): ImageBlock {
  return {
    type: 'image',
    source: { type: 'url', url }
  };
}

/** Create a base64 document content block. */
export function documentBlock(
  mediaType: string,
  data: string,
  text?: string,
  metadata?: DocumentBlock['metadata']
): DocumentBlock {
  return {
    type: 'document',
    source: { type: 'base64', media_type: mediaType, data },
    text,
    metadata
  };
}

/** Create a URL-referenced document content block. */
export function documentBlockFromURL(
  url: string,
  text?: string,
  metadata?: DocumentBlock['metadata']
): DocumentBlock {
  return {
    type: 'document',
    source: { type: 'url', url },
    text,
    metadata
  };
}

/** Type guard: returns true if content is a ContentBlock array (multi-modal). */
export function isMultiModal(content: string | ContentBlock[]): content is ContentBlock[] {
  return Array.isArray(content);
}

/** Normalize string or ContentBlock[] to always return ContentBlock[]. */
export function toContentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (isMultiModal(content)) {
    return content;
  }
  return [textBlock(content)];
}

/** Extract concatenated text from string or ContentBlock[], ignoring non-text blocks. */
export function extractText(content: string | ContentBlock[]): string {
  if (!isMultiModal(content)) {
    return content;
  }

  return content
    .map(block => {
      if (block.type === 'text') {
        return block.text;
      } else if (block.type === 'document' && block.text) {
        return block.text;
      }
      return '';
    })
    .filter(text => text.length > 0)
    .join('\n\n');
}
