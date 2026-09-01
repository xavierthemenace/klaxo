import { randomUUID, createHash } from 'node:crypto';

/** Prefixed identifiers that stay readable in logs and URLs. */
export type IdPrefix =
  | 'usr' | 'crs' | 'ver' | 'doc' | 'frg' | 'kp' | 'unt' | 'top'
  | 'obj' | 'les' | 'act' | 'qst' | 'set' | 'asm' | 'mas' | 'dep'
  | 'prv' | 'qa' | 'job' | 'evt' | 'edt' | 'att' | 'vis' | 'bp';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Stable content hash, used for caching and duplicate detection. */
export function contentHash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update(' ');
  return h.digest('hex').slice(0, 32);
}

/** Deterministic slug for human-facing anchors. */
export function slugify(input: string, max = 60): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'item').slice(0, max);
}
