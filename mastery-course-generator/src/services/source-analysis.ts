/**
 * SourceAnalysisService — turn raw source material into a KnowledgePackage.
 *
 * Supports MULTI-SOURCE analysis: several uploaded documents (PDF, image, text,
 * document, prompt) are analyzed together into a single, coherent knowledge
 * package. Unlike the previous single-document implementation, this service:
 *
 *   - persists REAL provenance: fragments are extracted per-document (page /
 *     paragraph / section information is preserved) and every interpretation
 *     element is linked back to the fragments it was derived from.
 *   - surfaces conflicts between sources instead of silently choosing one.
 *   - distinguishes SOURCE FACT vs INFERENCE vs RECOMMENDATION vs ENRICHMENT.
 */
import { randomUUID } from 'node:crypto';
import { getAiContext } from '../ai';
import { generateStructured } from '../ai/router';
import { SourceAnalysis, SourceAnalysisSchema } from '../ai/types';
import { delimitSource, SOURCE_EXTRACTION_SYSTEM } from '../pipeline/prompts';
import {
  getSourceDocument,
  listSourceDocuments,
  createSourceFragment,
  createKnowledgePackage,
  updateKnowledgePackage,
  updateSourceDocument,
  createProvenance,
} from '../db/repo';
import { aiUnavailable, pipelineFailed } from '../lib/errors';
import { extractPdfText } from './pdf';
import { extractDocument } from './document-extraction';
import { readFileSync } from 'node:fs';
import { Message } from '../ai/provider';

export interface AnalyzeSourcesInput {
  courseId: string;
  documentIds: string[];
}

export interface SourceFragmentEvidence {
  id: string;
  documentId: string;
  kind: string;
  text: string;
  page?: number;
  confidence?: number;
  uncertain: boolean;
  // For image fragments: base64 encoded image data and MIME type
  imageData?: string;
  imageMimeType?: string;
}

export interface SourceAnalysisResult {
  knowledgePackageId: string;
  analysis: SourceAnalysis;
  fragments: SourceFragmentEvidence[];
  conflicts: { description: string; sources: string[] }[];
  model: string;
  provider: string;
}

/** Extract raw content from a document record into per-document fragments. */
export async function extractDocumentFragments(
  documentId: string,
  courseId: string,
): Promise<SourceFragmentEvidence[]> {
  const doc = getSourceDocument(documentId);
  if (!doc) throw pipelineFailed(`Source document ${documentId} not found`);

  const fragments: SourceFragmentEvidence[] = [];

  if (doc.kind === 'pdf' && doc.storagePath) {
    const extracted = await extractPdfText(readFileSync(doc.storagePath));
    // Split each page into paragraph fragments, preserving page number.
    for (const page of extracted.pages) {
      const paragraphs = page.text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      paragraphs.forEach((text, i) => {
        fragments.push(segmentFragment(
          documentId, courseId, 'paragraph', text, page.pageNumber, i,
        ));
      });
    }
    // Persist page count + extracted text for provenance review.
    updateSourceDocument(documentId, { pageCount: extracted.pageCount });
  } else if (doc.kind === 'image') {
    // Read the actual image bytes and encode as base64 for vision model
    if (!doc.storagePath) {
      throw pipelineFailed(`Image document ${documentId} has no storage path`);
    }
    const imageBuffer = readFileSync(doc.storagePath);
    const mimeType = doc.mimeType ?? 'image/jpeg';
    const base64Image = imageBuffer.toString('base64');
    
    // Store the image data in the fragment for vision model
    fragments.push({
      id: `frag_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      documentId,
      kind: 'image',
      text: `[Image: ${mimeType}]`,
      confidence: 1,
      uncertain: false,
      imageData: base64Image,
      imageMimeType: mimeType,
    });
  } else if (doc.kind === 'document') {
    // DOCX/RTF documents - use extracted text from ingestion
    const raw = doc.extractedText ?? '';
    if (!raw) {
      // If no text was extracted during ingestion, try to extract now
      if (doc.storagePath && doc.mimeType) {
        try {
          const buffer = readFileSync(doc.storagePath);
          const extracted = await extractDocument(buffer, doc.mimeType);
          // Update the document with extracted text
          updateSourceDocument(documentId, { extractedText: extracted.text });
          
          // Create fragments from paragraphs with heading info
          let ordinal = 0;
          for (const para of extracted.paragraphs) {
            fragments.push(segmentFragment(
              documentId, courseId,
              para.style ?? 'paragraph',
              para.text,
              undefined,
              ordinal++
            ));
          }
        } catch (err) {
          throw pipelineFailed(`Failed to extract document ${documentId}: ${(err as Error).message}`);
        }
      } else {
        throw pipelineFailed(`Document ${documentId} has no extracted text and no storage path`);
      }
    } else {
      const paragraphs = raw
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      paragraphs.forEach((text, i) => {
        fragments.push(segmentFragment(documentId, courseId, 'paragraph', text, undefined, i));
      });
    }
  } else {
    // Text / prompt fall back to the extracted text.
    const raw = doc.extractedText ?? '';
    const paragraphs = raw
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    paragraphs.forEach((text, i) => {
      fragments.push(segmentFragment(documentId, courseId, 'paragraph', text, undefined, i));
    });
  }

  return fragments;
}

/** Build a single fragment (no persistence side effects). */
function segmentFragment(
  documentId: string,
  courseId: string,
  kind: string,
  text: string,
  page: number | undefined,
  _ordinal: number,
): SourceFragmentEvidence {
  return {
    id: `frag_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    documentId,
    kind,
    text: text.slice(0, 8000),
    page,
    confidence: 1,
    uncertain: false,
  };
}

/** Persist a fragment evidence object. */
function persistFragment(courseId: string, frag: SourceFragmentEvidence, ordinal: number): void {
  createSourceFragment({
    id: frag.id,
    courseId,
    documentId: frag.documentId,
    ordinal,
    kind: frag.kind,
    text: frag.text,
    page: frag.page,
    confidence: frag.confidence,
    uncertain: frag.uncertain ? 1 : 0,
  });
}

/**
 * Detect conflicts between sources. A conflict exists when two documents
 * declare a different number of units or contradictory top-level facts. We
 * surface these to the user rather than silently choosing one.
 */
export function detectSourceConflicts(fragments: SourceFragmentEvidence[]): {
  description: string;
  sources: string[];
}[] {
  // Compare explicit unit counts mentioned in different documents.
  const unitCounts = new Map<string, { count: number; doc: string }>();
  const conflicts: { description: string; sources: string[] }[] = [];

  for (const frag of fragments) {
    const match = frag.text.match(/\b(\d+)\s*(?:units|modules|chapters|lessons)\b/i);
    if (match && match[1]) {
      const count = Number(match[1]);
      const key = String(count);
      if (!unitCounts.has(key)) unitCounts.set(key, { count, doc: frag.documentId });
    }
  }

  if (unitCounts.size > 1) {
    const docs = Array.from(unitCounts.values()).map((u) => u.doc);
    conflicts.push({
      description: 'Sources disagree on the number of units/modules.',
      sources: docs,
    });
  }

  return conflicts;
}

/**
 * Analyze MULTIPLE source documents into a single structured KnowledgePackage.
 */
/**
 * Turn whatever the model cited into an index into `allFragments`.
 *
 * Fragments are shown to the model labelled `[source-0]`, `[source-1]`, … so it
 * quite reasonably cites `"source-3"`. `Number("source-3")` is NaN, which used
 * to drop every citation and leave the whole course with no source links at all.
 */
export function fragmentIndexFromRef(ref: unknown): number {
  if (typeof ref === 'number') return ref;
  if (typeof ref !== 'string') return -1;
  const digits = ref.match(/\d+/);
  return digits ? Number(digits[0]) : -1;
}

export async function analyzeSources(input: AnalyzeSourcesInput): Promise<SourceAnalysisResult> {
  const { provider, routing } = getAiContext();
  if (input.documentIds.length === 0) {
    throw pipelineFailed('No source documents to analyze.');
  }

  // 1. Extract real fragments per document.
  const allFragments: SourceFragmentEvidence[] = [];
  for (const docId of input.documentIds) {
    const doc = getSourceDocument(docId);
    if (!doc || doc.courseId !== input.courseId) {
      throw pipelineFailed(`Source document ${docId} not found for this course.`);
    }
    const frags = await extractDocumentFragments(docId, input.courseId);
    allFragments.push(...frags);
  }

  if (allFragments.length === 0) {
    throw aiUnavailable('Source documents have no extractable content.');
  }

  // 2. Persist fragments so provenance can reference them.
  let ordinal = 0;
  for (const frag of allFragments) {
    persistFragment(input.courseId, frag, ordinal++);
  }

  // 3. Assemble a combined source payload for the model. Include a per-fragment
  //    reference id so the model can cite sources in its interpretation.
  // For vision model: include image data for image fragments
  const hasImages = allFragments.some((f) => f.kind === 'image' && f.imageData);

  // Only reach for the vision model when there is actually something to look
  // at. Sending typed notes or an extracted PDF to a vision model costs more,
  // is slower, and — on providers that gate vision models behind a separate
  // licence — fails outright on material that never needed one.
  const model = hasImages ? routing.vision : routing.planning;
  
  // Build messages with image support
  const messages: Message[] = [
    { role: 'system', content: SOURCE_EXTRACTION_SYSTEM },
  ];

  if (hasImages) {
    // Create a multimodal message with images
    const combinedText = allFragments
      .map((f, i) => `[source-${i}] (${f.kind}${f.page ? `, page ${f.page}` : ''}):\n${f.text}`)
      .join('\n\n');
    
    // Collect image data for the message
    const images = allFragments
      .filter(f => f.kind === 'image' && f.imageData && f.imageMimeType)
      .map(f => ({ data: f.imageData!, mimeType: f.imageMimeType! }));
    
    messages.push({
      role: 'user',
      content: delimitSource(combinedText),
      images,
    });
  } else {
    // Text-only message
    const combinedText = allFragments
      .map((f, i) => `[source-${i}] (${f.kind}${f.page ? `, page ${f.page}` : ''}):\n${f.text}`)
      .join('\n\n');
    
    messages.push({
      role: 'user',
      content: delimitSource(combinedText),
    });
  }

  const result = await generateStructured(
    provider,
    model,
    { messages, schema: SourceAnalysisSchema },
    { maxRetries: 2, temperature: 0.2 },
  );
  const analysis = result.value;

  // 4. Persist the knowledge package.
  const kp = createKnowledgePackage({
    id: `kp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    courseId: input.courseId,
    detectedTitle: analysis.title,
    detectedSubject: analysis.subject,
    detectedLevel: analysis.level,
    summary: analysis.summary,
    payload: JSON.stringify(analysis),
    confidence: analysis.confidence,
    status: 'draft',
    origin: 'AI_GENERATED',
  });

  // 5. Link knowledge package to source fragments (provenance for the KP itself).
  //    Objective provenance will be created during blueprint persistence with REAL database IDs.
  createProvenance({
    id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    courseId: input.courseId,
    entityType: 'knowledge_package',
    entityId: kp.id,
    relation: 'DERIVED_FROM',
    confidence: analysis.confidence,
    note: 'Knowledge package derived from source fragments',
  });

  // Store fragment references in knowledge package for later blueprint provenance.
  // We update the payload to include fragment refs per objective.
  const updatedAnalysis = { ...analysis };
  for (const obj of updatedAnalysis.objectives) {
    const sourceFragments = (obj.sourceFragmentIds ?? [])
      .map((ref) => allFragments[fragmentIndexFromRef(ref)])
      .filter((f): f is SourceFragmentEvidence => f !== undefined);
    // Replace index-based refs with actual fragment IDs
    obj.sourceFragmentIds = sourceFragments.map((f) => f.id);
    if (sourceFragments.length === 0) {
      // No explicit citation — mark as inferred from the whole source set.
      obj.sourceFragmentIds = ['INFERRED_FROM_SOURCE_SET'];
    }
  }
  // Update the knowledge package with fragment-resolved analysis
  updateKnowledgePackage(kp.id, {
    payload: JSON.stringify(updatedAnalysis),
  });

  // 6. Mark documents as extracted.
  for (const docId of input.documentIds) {
    updateSourceDocument(docId, {
      status: 'extracted',
      extractionModel: model,
      extractionProvider: provider.id,
      confidence: analysis.confidence,
    });
  }

  const conflicts = detectSourceConflicts(allFragments);

  return {
    knowledgePackageId: kp.id,
    analysis,
    fragments: allFragments,
    conflicts,
    model,
    provider: provider.id,
  };
}

/** Backward-compatible single-document wrapper. */
export async function analyzeSource(input: { courseId: string; documentId: string }) {
  return analyzeSources({ courseId: input.courseId, documentIds: [input.documentId] });
}

/** Get all source documents for a course (for the source review screen). */
export function getCourseSources(courseId: string) {
  return listSourceDocuments(courseId);
}