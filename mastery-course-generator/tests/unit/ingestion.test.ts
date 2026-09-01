import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.AI_DEV_MODE = 'true';
process.env.DATABASE_FILE = ':memory:';
process.env.UPLOAD_DIR = './.tmp-test-uploads';

import { resetDb, getDb } from '@/db';
import { createCourse, createUser, getSourceDocument } from '@/db/repo';
import {
  classifyUpload,
  validateUpload,
  ingestPrompt,
  ingestUpload,
} from '@/services/ingestion';
import { getEnv } from '@/lib/env';
import type { Env } from '@/lib/env';

const courseId = 'crs_ingestion_course';

function seed(): void {
  createUser({ id: 'usr_ingestion', email: 'ingest@test.com' });
  createCourse({
    id: courseId,
    userId: 'usr_ingestion',
    title: 'Ingestion Course',
  });
}

describe('classifyUpload', () => {
  it('classifies by MIME type', () => {
    expect(classifyUpload(undefined, 'application/pdf').kind).toBe('pdf');
    expect(classifyUpload(undefined, 'image/png').kind).toBe('image');
    expect(classifyUpload(undefined, 'text/plain').kind).toBe('text');
  });

  it('classifies by extension when MIME is missing', () => {
    expect(classifyUpload('notes.md', undefined).kind).toBe('text');
    expect(classifyUpload('scan.pdf', undefined).kind).toBe('pdf');
  });

  it('rejects unsupported types', () => {
    expect(() => classifyUpload('evil.exe', 'application/x-msdownload')).toThrow();
    expect(() => classifyUpload(undefined, undefined)).toThrow();
  });
});

describe('validateUpload', () => {
  it('rejects empty uploads', () => {
    expect(() =>
      validateUpload({ courseId, kind: 'text', content: '' }),
    ).toThrow(/empty/i);
    expect(() =>
      validateUpload({ courseId, kind: 'pdf', content: Buffer.alloc(0) }),
    ).toThrow(/empty/i);
  });

  it('rejects oversized uploads', () => {
    const env = {
      ...getEnv(),
      MAX_UPLOAD_BYTES: 10,
    } as Env;
    expect(() =>
      validateUpload({ courseId, kind: 'text', content: 'x'.repeat(100) }, env),
    ).toThrow(/too large/i);
  });

  it('rejects a MIME type that does not match the kind', () => {
    expect(() =>
      validateUpload({
        courseId,
        kind: 'pdf',
        mimeType: 'image/png',
        content: Buffer.from('x'),
      }),
    ).toThrow(/not allowed for kind/);
  });

  it('rejects a filename extension that does not match the kind', () => {
    expect(() =>
      validateUpload({
        courseId,
        kind: 'text',
        filename: 'notes.exe',
        content: 'hello',
      }),
    ).toThrow(/not allowed for kind/);
  });

  it('accepts a valid text upload', () => {
    expect(() =>
      validateUpload({
        courseId,
        kind: 'text',
        filename: 'notes.md',
        mimeType: 'text/markdown',
        content: '## Heading',
      }),
    ).not.toThrow();
  });
});

describe('ingestPrompt', () => {
  beforeAll(() => {
    resetDb();
    getDb();
    seed();
  });

  afterAll(() => {
    resetDb();
  });

  it('persists a prompt source document', async () => {
    const result = await ingestPrompt(courseId, 'Teach linear algebra.');
    expect(result.documentId).toMatch(/^src_/);
    expect(result.kind).toBe('prompt');
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ingestUpload', () => {
  beforeAll(() => {
    resetDb();
    getDb();
    seed();
  });

  afterAll(() => {
    resetDb();
  });

  it('persists a binary upload and writes to disk', async () => {
    const content = Buffer.from('hello world');
    const result = await ingestUpload({
      courseId,
      kind: 'text',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      content,
    });
    expect(result.documentId).toMatch(/^src_/);
    expect(result.byteSize).toBe(content.byteLength);
    expect(result.storagePath).toBeTruthy();
  });

  it('extracts the text of an uploaded .txt/.md/.csv file', async () => {
    // The upload route always hands over a Buffer, so a plain-text file used to
    // be stored with no extracted text at all — the upload looked fine and
    // analysis then failed with "no extractable content".
    const content = Buffer.from('# Chain rule\n\nDifferentiate f(x) = (3x+1)^5.');
    const result = await ingestUpload({
      courseId,
      kind: 'text',
      filename: 'chain-rule.md',
      mimeType: 'text/markdown',
      content,
    });

    const doc = getSourceDocument(result.documentId);
    expect(doc?.extractedText).toContain('Chain rule');
  });

  it('persists a text upload without a storage path', async () => {
    const result = await ingestUpload({
      courseId,
      kind: 'text',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      content: '# Title',
    });
    expect(result.documentId).toMatch(/^src_/);
    expect(result.storagePath).toBeNull();
  });

  it('rejects an unsupported file type via classify+validate', async () => {
    await expect(
      ingestUpload({
        courseId,
        kind: 'text',
        filename: 'evil.exe',
        content: Buffer.from('malware'),
      }),
    ).rejects.toThrow();
  });

  it('rejects a malformed empty upload', async () => {
    await expect(
      ingestUpload({
        courseId,
        kind: 'text',
        content: '',
      }),
    ).rejects.toThrow(/empty/i);
  });
});