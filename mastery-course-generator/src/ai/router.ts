/**
 * Model Router
 *
 * Central routing layer that maps pipeline stages to specific NIM models.
 * Also provides structured-generation helpers with schema validation/repair.
 */
import { z } from 'zod';
import { AIProvider, CompletionRequest, ModelRouting } from './provider';
import { logger } from '../lib/logger';
import { getEnv } from '../lib/env';

/**
 * Pipeline stages that require model routing.
 */
export type PipelineStage =
  | 'source_extraction'
  | 'curriculum_planning'
  | 'prerequisite_analysis'
  | 'lesson_generation'
  | 'practice_generation'
  | 'assessment_generation'
  | 'qa'
  | 'revision';

/**
 * Maps a pipeline stage to a model routing key.
 */
const STAGE_TO_ROUTING: Record<PipelineStage, keyof ModelRouting> = {
  source_extraction: 'vision',
  curriculum_planning: 'planning',
  prerequisite_analysis: 'planning',
  lesson_generation: 'generation',
  practice_generation: 'generation',
  assessment_generation: 'assessment',
  qa: 'qa',
  revision: 'generation',
};

/**
 * Resolves the model for a given pipeline stage.
 */
export function resolveModel(routing: ModelRouting, stage: PipelineStage): string {
  const key = STAGE_TO_ROUTING[stage];
  return routing[key];
}

/**
 * Structured generation result with schema validation metadata.
 */
export interface StructuredResult<T> {
  value: T;
  model: string;
  provider: string;
  schemaFailures: number;
  retries: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
}

/**
 * Generate structured JSON output with schema validation and bounded repair.
 *
 * Flow:
 * 1. Attempt generation (with json_schema if provider supports it).
 * 2. Validate against the Zod schema.
 * 3. On failure, attempt repair by feeding the schema error back.
 * 4. Retry up to maxRetries.
 * 5. Throw if still invalid.
 */
export async function generateStructured<T extends z.ZodTypeAny>(
  provider: AIProvider,
  model: string,
  request: Omit<CompletionRequest, 'model'> & { schema: T },
  options: { maxRetries?: number; temperature?: number; maxTokens?: number } = {},
): Promise<StructuredResult<z.infer<T>>> {
  const maxRetries = options.maxRetries ?? 2;
  let schemaFailures = 0;
  let retries = 0;
  let lastError: string | null = null;
  let lastOutput: string | null = null;
  let lastFailure: 'parse' | 'schema' | 'request' | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const messages = [...request.messages];
      if (lastOutput !== null && (lastFailure === 'parse' || lastFailure === 'schema')) {
        // Show the model what it actually said. Repair is impossible otherwise:
        // the error names a path like `sections.9.visual`, and without the
        // output in front of it the model has no idea what is at that path.
        messages.push({ role: 'assistant', content: lastOutput });
        messages.push({ role: 'user', content: repairInstruction(lastFailure, lastError) });
      }

      // Anything that goes wrong from here until the reply lands is a request
      // failure with no output to repair, so clear the previous attempt's.
      lastOutput = null;
      lastFailure = 'request';

      const completion = await provider.complete({
        messages,
        model,
        temperature: options.temperature ?? 0.3,
        // AI_MAX_TOKENS used to be read into the config and then ignored here,
        // so raising it in .env did nothing at all.
        maxTokens: options.maxTokens ?? getEnv().AI_MAX_TOKENS,
        responseFormat: 'json',
        jsonSchema: zodToJsonSchema(request.schema),
      });

      // A cut-off reply is not a malformed one, and feeding it back for repair
      // just truncates again at the same place. Say what actually happened.
      if (completion.finishReason === 'length') {
        throw new Error(
          'The model\'s reply was cut off before it finished (token limit reached). ' +
          'Raise AI_MAX_TOKENS in .env, or use a model with a larger output budget.',
        );
      }

      lastOutput = completion.content;
      lastFailure = 'parse';

      // Parse JSON (strip reasoning, fences and surrounding prose).
      const parsed = parseJsonSafe(completion.content);

      // Validate against the Zod schema.
      lastFailure = 'schema';
      const result = request.schema.safeParse(dropNulls(parsed));
      if (result.success) {
        return {
          value: result.data,
          model: completion.model,
          provider: completion.provider,
          schemaFailures,
          retries,
          promptTokens: completion.promptTokens,
          completionTokens: completion.completionTokens,
          latencyMs: completion.latencyMs,
        };
      }

      schemaFailures++;
      lastError = formatZodError(result.error);
      logger.warn('Structured generation schema validation failed', {
        attempt: attempt + 1,
        error: lastError,
      });
      retries = attempt;
    } catch (err) {
      // Parse or network/provider error — retry. `lastFailure` already says
      // which, and carries the output to repair when there is one.
      retries = attempt;
      lastError = (err as Error).message;
      logger.warn('Structured generation request failed', {
        attempt: attempt + 1,
        error: lastError,
      });
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }

  throw new Error(`Structured generation failed after ${maxRetries + 1} attempts: ${lastError}`);
}

/**
 * Tell the model what went wrong and what a corrected reply looks like.
 *
 * The old message claimed every failure was invalid JSON. A schema failure is
 * usually the opposite — well-formed JSON in the wrong shape — and being told
 * it wrote broken JSON when it did not sends the model looking in the wrong
 * place. Attempt 3 of a failing run would come back as a bare array of the one
 * field the error mentioned.
 */
function repairInstruction(kind: 'parse' | 'schema', error: string | null): string {
  return [
    kind === 'parse'
      ? 'That reply was not valid JSON.'
      : 'That reply was valid JSON, but the wrong shape.',
    `What failed: ${error ?? 'unknown'}`,
    '',
    'Send the corrected result and nothing else:',
    '- one JSON object, not an array and not a fragment of the previous reply;',
    '- omit optional fields entirely rather than setting them to null;',
    '- no commentary, no code fences.',
  ].join('\n');
}

/**
 * Drop `null` properties before validation.
 *
 * The prompts mark optional fields with `?`, and models honour that by writing
 * `"visual": null` as often as by leaving the key out. No schema in this
 * codebase accepts null, so an explicit null is always the model spelling
 * "absent" the other way, and rejecting it fails a lesson over nothing.
 */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null) continue;
      out[key] = dropNulls(item);
    }
    return out;
  }
  return value;
}

/**
 * Strip a reasoning model's scratch work from a completion.
 *
 * Reasoning models — NVIDIA Nemotron, DeepSeek-R1, Qwen3 and friends — emit
 * their deliberation in a <think> block before the answer, and the default
 * model in `.env.example` is one of them. That deliberation routinely contains
 * braces, because the model is talking itself through the very schema we asked
 * for. Scanning the raw reply for JSON therefore finds the sketch instead of
 * the answer, and the sketch is not valid JSON.
 */
export function stripReasoning(content: string): string {
  let out = content;

  // Everything up to and including the last closing tag is deliberation. This
  // also covers models that emit a stray `</think>` with no opening tag.
  let lastClose = -1;
  for (const match of content.matchAll(/<\/(?:think|thinking|reasoning)>/gi)) {
    lastClose = (match.index ?? 0) + match[0].length;
  }
  if (lastClose >= 0) out = out.slice(lastClose);

  // An unterminated block means the answer never arrived — usually the reply
  // hit the token ceiling mid-thought. Keep nothing rather than parsing the
  // deliberation as if it were the result.
  const dangling = out.search(/<(?:think|thinking|reasoning)>/i);
  if (dangling >= 0) out = out.slice(0, dangling);

  return out.trim();
}

/**
 * Yield every balanced `{...}` or `[...]` span in the text, outermost first.
 *
 * The previous approach — first `{` to last `}` — breaks on any reply with
 * prose on either side of the JSON, because a brace in that prose moves the
 * boundary. Tracking depth (and ignoring braces inside strings) finds the
 * actual object regardless of what surrounds it.
 */
function* jsonCandidates(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;

    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\' && inString) {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === open) depth++;
        else if (ch === close && --depth === 0) {
          yield text.slice(i, j + 1);
          break;
        }
      }
    }
  }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse JSON robustly, handling reasoning blocks, markdown fences and prose.
 */
export function parseJsonSafe(content: string): unknown {
  const text = stripReasoning(content);

  // The whole reply is JSON — the common case.
  const direct = tryParse(text);
  if (direct.ok) return direct.value;

  // A fenced block anywhere in the reply. Not anchored to the ends, because
  // models like to introduce the block ("Here is the blueprint:") and to add a
  // closing remark after it.
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = tryParse((match[1] ?? '').trim());
    if (fenced.ok) return fenced.value;
  }

  // Otherwise take the first balanced span that actually parses.
  for (const candidate of jsonCandidates(text)) {
    const parsed = tryParse(candidate);
    if (parsed.ok) return parsed.value;
  }

  // Say what came back. Without this the caller only learns that some JSON
  // somewhere was malformed, which is what made this class of failure so
  // expensive to diagnose.
  const preview = content.trim().slice(0, 200).replace(/\s+/g, ' ');
  throw new Error(`No valid JSON found in response. Model replied: ${preview || '(empty)'}`);
}

/**
 * Format a Zod error into a human-readable string.
 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Convert a Zod schema to a JSON Schema (approximate, for json_schema format).
 * For simplicity, we fall back to json_object mode in the provider; the real
 * schema validation happens with Zod after parsing.
 */
function zodToJsonSchema<T extends z.ZodTypeAny>(_schema: T): Record<string, unknown> {
  // We don't need a full JSON Schema — the provider uses json_object mode and
  // Zod validates afterwards. This is a placeholder for provider compatibility.
  return { type: 'object' };
}