/**
 * Ingestion service — validate and store uploaded source material.
 *
 * Handles text, image, and PDF uploads with strict validation of size, MIME
 * type, extension, and content. All uploaded material is untrusted data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { getEnv } from '../lib/env';
import { badRequest } from '../lib/errors';
import { createSourceDocument } from '../db/repo';
import { extractDocument } from './document-extraction';

/** Allowed MIME types by kind. */
const ALLOWED_MIME = new Map<string, string[]>([
  ['image', ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']],
  ['pdf', ['application/pdf']],
  ['text', ['text/plain', 'text/markdown', 'text/csv']],
  ['document', [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/rtf',
  ]],
]);

/** Allowed extensions by kind. */
const ALLOWED_EXT = new Map<string, string[]>([
  ['image', ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']],
  ['pdf', ['.pdf']],
  ['text', ['.txt', '.md', '.markdown', '.csv']],
  ['document', ['.docx', '.doc', '.rtf']],
]);

export interface UploadInput {
  courseId: string;
  kind: 'text' | 'image' | 'pdf' | 'document' | 'prompt';
  filename?: string;
  mimeType?: string;
  content: Buffer | string;
  contentText?: string;
}

export interface UploadResult {
  documentId: string;
  kind: string;
  filename: string | null;
  checksum: string;
  byteSize: number;
  storagePath: string | null;
}

/**
 * Classify a raw upload into a supported kind, or throw.
 */
export function classifyUpload(
  filename: string | undefined,
  mimeType: string | undefined,
): Pick<UploadInput, 'kind' | 'mimeType' | 'filename'> {
  const ext = filename ? extname(filename).toLowerCase() : undefined;

  // Infer kind from MIME or extension.
  let kind: UploadInput['kind'] | undefined;
  if (mimeType) {
    kind = detectKindFromMime(mimeType);
  }
  if (!kind && ext) {
    kind = detectKindFromExt(ext);
  }
  if (!kind) {
    throw badRequest(
      'Unsupported file type. Provide an image, PDF, text, or office document.',
    );
  }

  return { kind, mimeType, filename };
}

function detectKindFromMime(mime: string): UploadInput['kind'] | undefined {
  for (const [kind, types] of ALLOWED_MIME) {
    if (types.includes(mime)) return kind as UploadInput['kind'];
  }
  return undefined;
}

function detectKindFromExt(ext: string): UploadInput['kind'] | undefined {
  for (const [kind, exts] of ALLOWED_EXT) {
    if (exts.includes(ext)) return kind as UploadInput['kind'];
  }
  return undefined;
}

/**
 * Validate an upload against configured limits.
 */
export function validateUpload(
  input: UploadInput,
  env = getEnv(),
): void {
  const size = typeof input.content === 'string'
    ? Buffer.byteLength(input.content, 'utf8')
    : input.content.byteLength;

  if (size <= 0) throw badRequest('Upload is empty.');
  if (size > env.MAX_UPLOAD_BYTES) {
    throw badRequest(
      `Upload is too large (${size} bytes). Maximum is ${env.MAX_UPLOAD_BYTES} bytes.`,
    );
  }

  if (input.mimeType && !isAllowedMime(input.kind, input.mimeType)) {
    throw badRequest(`MIME type '${input.mimeType}' not allowed for kind '${input.kind}'.`);
  }
  if (input.filename) {
    const ext = extname(input.filename).toLowerCase();
    if (ext && !isAllowedExt(input.kind, ext)) {
      throw badRequest(`File extension '${ext}' not allowed for kind '${input.kind}'.`);
    }
  }
}

function isAllowedMime(kind: string, mime: string): boolean {
  return ALLOWED_MIME.get(kind)?.includes(mime) ?? false;
}

function isAllowedExt(kind: string, ext: string): boolean {
  return ALLOWED_EXT.get(kind)?.includes(ext) ?? false;
}

function sha256(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Persist an upload: write binary to disk (if applicable) and create the
 * source document record.
 */
export async function ingestUpload(input: UploadInput): Promise<UploadResult> {
  const env = getEnv();
  validateUpload(input, env);

  const id = `src_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const checksum = sha256(input.content);
  const byteSize = typeof input.content === 'string'
    ? Buffer.byteLength(input.content, 'utf8')
    : input.content.byteLength;

  let storagePath: string | null = null;
  let extractedText: string | undefined;

  if (typeof input.content !== 'string') {
    // Write binary content to disk.
    mkdirSync(resolve(process.cwd(), env.UPLOAD_DIR), { recursive: true });
    const safeName = input.filename?.replace(/[^a-zA-Z0-9._-]/g, '_') ?? id;
    storagePath = resolve(process.cwd(), env.UPLOAD_DIR, `${id}_${safeName}`);
    writeFileSync(storagePath, input.content);

    // Plain-text formats (.txt, .md, .csv) arrive as a Buffer from the upload
    // route just like binaries do. Decode them here, or nothing is ever stored
    // and analysis later fails with "no extractable content".
    if (input.kind === 'text') {
      extractedText = input.content.toString('utf8');
    }

    // Extract text from document files (DOCX, RTF, DOC)
    if (input.kind === 'document' && input.mimeType) {
      try {
        const extracted = await extractDocument(input.content, input.mimeType);
        extractedText = extracted.text;
      } catch (err) {
        // Don't fail the upload, but log the extraction error
        console.warn(`Failed to extract text from document ${id}:`, err);
      }
    }
  } else {
    extractedText = input.content;
  }

  const doc = createSourceDocument({
    id,
    courseId: input.courseId,
    kind: input.kind,
    filename: input.filename ?? undefined,
    mimeType: input.mimeType ?? undefined,
    byteSize,
    storagePath: storagePath ?? undefined,
    checksum,
    extractedText: extractedText ?? input.contentText,
    status: 'uploaded',
  });

  return {
    documentId: doc.id,
    kind: doc.kind,
    filename: doc.filename,
    checksum: doc.checksum ?? '',
    byteSize: doc.byteSize ?? 0,
    storagePath: doc.storagePath,
  };
}

/**
 * Ingest a raw natural-language course prompt (not a file).
 */
export async function ingestPrompt(courseId: string, text: string): Promise<UploadResult> {
  const id = `src_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const checksum = sha256(text);

  const doc = createSourceDocument({
    id,
    courseId,
    kind: 'prompt',
    filename: undefined,
    mimeType: 'text/plain',
    byteSize: Buffer.byteLength(text, 'utf8'),
    storagePath: undefined,
    checksum,
    extractedText: text,
    status: 'uploaded',
  });

  return {
    documentId: doc.id,
    kind: doc.kind,
    filename: doc.filename,
    checksum: doc.checksum ?? '',
    byteSize: doc.byteSize ?? 0,
    storagePath: doc.storagePath,
  };
}