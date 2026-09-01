'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

export interface PersistedSource {
  id: string;
  documentId: string;
  kind: string;
  filename: string | null;
  byteSize: number;
  checksum: string;
  preview?: string;
}

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

interface FileItem {
  key: string;
  file: File;
  preview?: string;
  status: UploadStatus;
  error?: string;
  documentId?: string;
}

interface ServerSource {
  id: string;
  documentId?: string;
  kind: string;
  filename: string | null;
  mimeType: string | null;
  byteSize: number | null;
  status: string;
  checksum?: string | null;
  preview?: string;
}

interface FileUploadProps {
  courseId: string;
  onSourcesChange: (sources: PersistedSource[]) => void;
  acceptedTypes?: string[];
  maxFiles?: number;
  maxSizeBytes?: number;
}

/** Normalize a server source document row into the client-side persisted shape. */
function mapServerSource(s: ServerSource): PersistedSource {
  return {
    id: s.documentId ?? s.id,
    documentId: s.documentId ?? s.id,
    kind: s.kind,
    filename: s.filename,
    byteSize: s.byteSize ?? 0,
    checksum: s.checksum ?? '',
    preview: s.preview,
  };
}

/**
 * Name a source the way its owner would.
 *
 * Typed notes have no filename, so the list used to show the raw database id.
 * The first line of what was typed is what someone actually recognises.
 */
function sourceLabel(s: PersistedSource): string {
  if (s.filename) return s.filename;
  if (s.preview) return s.preview;
  return 'Typed note';
}

/** Anything under a kilobyte rounded to "0 KB", which reads as empty. */
function sourceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${Math.round(bytes / 1024)} KB`;
}

const DEFAULT_ACCEPTED = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword', 'application/rtf',
];

export function FileUpload({
  courseId,
  onSourcesChange,
  acceptedTypes,
  maxFiles = 10,
  maxSizeBytes = 10 * 1024 * 1024,
}: FileUploadProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [prompts, setPrompts] = useState<string[]>(['']);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const persisted = useRef<PersistedSource[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [serverSources, setServerSources] = useState<PersistedSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);

  const accepted = acceptedTypes ?? DEFAULT_ACCEPTED;

  const validateFile = useCallback(
    (file: File): string | null => {
      if (file.size > maxSizeBytes) {
        return `"${file.name}" exceeds ${Math.round(maxSizeBytes / 1024 / 1024)} MB.`;
      }
      const ok = accepted.some((t) => file.type === t)
        || accepted.some((t) => t.endsWith('/*') && file.type.startsWith(t.slice(0, -1)));
      if (!ok) return `"${file.name}" has an unsupported type.`;
      return null;
    },
    [accepted, maxSizeBytes],
  );

  const handleFilesSelected = useCallback(
    (list: FileList | File[]) => {
      const newErrors: string[] = [];
      const additions: FileItem[] = [];
      Array.from(list).forEach((file) => {
        const err = validateFile(file);
        if (err) {
          newErrors.push(err);
        } else if (files.length + additions.length >= maxFiles) {
          newErrors.push(`Maximum ${maxFiles} files allowed.`);
        } else {
          additions.push({
            key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            file,
            preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
            status: 'idle',
          });
        }
      });
      if (newErrors.length) setError(newErrors.join(' '));
      else setError(null);
      if (additions.length) setFiles((prev) => [...prev, ...additions]);
    },
    [files.length, maxFiles, validateFile],
  );

  const removeFile = useCallback((key: string) => {
    setFiles((prev) => {
      const next = prev.filter((f) => f.key !== key);
      return next;
    });
  }, []);

  // Upload a batch of files + prompts, then emit persisted sources.
  const uploadAll = useCallback(async () => {
    setUploading(true);
    setError(null);

    const pendingFiles = files.filter((f) => f.status !== 'done');
    const promptTexts = prompts.map((p) => p.trim()).filter(Boolean);

    if (pendingFiles.length === 0 && promptTexts.length === 0) {
      setUploading(false);
      return;
    }

    const form = new FormData();
    for (const item of pendingFiles) {
      form.append('files', item.file, item.file.name);
    }
    for (const text of promptTexts) {
      form.append('prompts', text);
    }

    try {
      const res = await fetch(`/api/courses/${courseId}/sources`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Upload failed.');
      }
      const data = await res.json();
      const newSources: PersistedSource[] = (data.sources ?? []).map((s: ServerSource) => mapServerSource(s));
      persisted.current = [...persisted.current, ...newSources];
      onSourcesChange(persisted.current);
      setServerSources(persisted.current);

      setFiles((prev) =>
        prev.map((f) =>
          pendingFiles.some((p) => p.key === f.key) ? { ...f, status: 'done' } : f,
        ),
      );
      // Clear prompts after successful upload.
      setPrompts(['']);
    } catch (err) {
      setError((err as Error).message);
      setFiles((prev) =>
        prev.map((f) =>
          pendingFiles.some((p) => p.key === f.key)
            ? { ...f, status: 'error', error: (err as Error).message }
            : f,
        ),
      );
    } finally {
      setUploading(false);
    }
  }, [courseId, files, prompts, onSourcesChange]);

  // Load existing sources from the server on mount so previously uploaded
  // documents are reflected even after a page refresh.
  useEffect(() => {
    let mounted = true;
    setLoadingSources(true);
    fetch(`/api/courses/${courseId}/sources`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load sources');
        return res.json();
      })
      .then((data: { sources?: ServerSource[] }) => {
        if (!mounted) return;
        const existing = (data.sources ?? []).map(mapServerSource);
        persisted.current = existing;
        setServerSources(existing);
        onSourcesChange(existing);
      })
      .catch((err) => {
        if (mounted) setError((err as Error).message);
      })
      .finally(() => {
        if (mounted) setLoadingSources(false);
      });
    return () => {
      mounted = false;
    };
  }, [courseId, onSourcesChange]);

  return (
    <div className="space-y-6">
      {/* Drop zone */}
      <div
        className={cn(
          'rounded-xl border-2 border-dashed p-8 text-center transition-colors',
          dragActive ? 'border-primary bg-primary/5' : 'border-border',
        )}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          if (e.dataTransfer.files.length) handleFilesSelected(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accepted.join(',')}
          className="hidden"
          onChange={(e) => e.target.files && handleFilesSelected(e.target.files)}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="cursor-pointer w-full"
        >
          <svg className="mx-auto h-10 w-10 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className="mt-2 text-sm font-medium text-foreground">Drag & drop, or click to browse</p>
          <p className="mt-1 text-xs text-muted-foreground">
            PDF, images, Word, RTF, text, Markdown, CSV — up to {maxFiles} files, {Math.round(maxSizeBytes / 1024 / 1024)} MB each
          </p>
        </button>
      </div>

      {/* Selected files */}
      {files.length > 0 && (
        <ul className="space-y-2" role="list">
          {files.map((f) => (
            <li key={f.key} className="flex items-center justify-between rounded-lg border bg-card p-3">
              <div className="flex items-center gap-3 min-w-0">
                {f.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.preview} alt="" className="h-10 w-10 rounded object-cover" />
                ) : (
                  <svg className="h-9 w-9 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{f.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {Math.round(f.file.size / 1024)} KB · {f.file.type || 'unknown'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {f.status === 'done' && <Badge variant="success">Uploaded</Badge>}
                {f.status === 'error' && <Badge variant="error" dot>Failed</Badge>}
                {f.status === 'uploading' && <Badge variant="info">Uploading…</Badge>}
                <Button variant="ghost" size="sm" onClick={() => removeFile(f.key)} aria-label={`Remove ${f.file.name}`}>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Existing persisted sources */}
      {serverSources.length > 0 && (
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">What you have added</h3>
            <Badge variant="outline">{serverSources.length} total</Badge>
          </div>
          <ul className="mt-3 space-y-2" role="list">
            {serverSources.map((s) => (
              <li key={s.documentId} className="flex items-start justify-between gap-3 text-sm">
                <div className="flex min-w-0 items-start gap-2">
                  <Badge variant="secondary">{s.kind === 'prompt' ? 'typed' : s.kind}</Badge>
                  <span className="truncate">{sourceLabel(s)}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {sourceSize(s.byteSize)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Prompts */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Or type it out</h3>
        <p className="text-xs text-muted-foreground">You can also just type what the topic covers, in your own words.</p>
        {prompts.map((p, i) => (
          <div key={i} className="flex gap-2">
            <textarea
              value={p}
              onChange={(e) => {
                const next = [...prompts];
                next[i] = e.target.value;
                setPrompts(next);
              }}
              placeholder={
                i === 0
                  ? 'e.g. The chain rule, the product rule, and differentiating polynomials.'
                  : 'Anything else this covers.'
              }
              className="flex-1 min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
              rows={2}
            />
            {prompts.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => setPrompts((prev) => prev.filter((_, idx) => idx !== i))} aria-label="Remove instruction">
                ✕
              </Button>
            )}
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setPrompts((prev) => [...prev, ''])}>
          + Add another instruction
        </Button>
      </div>

      {error && (
        <div className="rounded-lg bg-error/10 p-4 text-sm text-error" role="alert">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {loadingSources
            ? 'Loading…'
            : serverSources.length > 0
            ? `${serverSources.length} ${serverSources.length === 1 ? 'thing' : 'things'} added`
            : 'Nothing added yet'}
        </p>
        <Button className="w-full sm:w-auto" onClick={uploadAll} loading={uploading} disabled={files.length === 0 && prompts.filter((p) => p.trim()).length === 0}>
          Add this
        </Button>
      </div>
    </div>
  );
}