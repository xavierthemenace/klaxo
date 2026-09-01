import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { dropNulls, generateStructured, parseJsonSafe, stripReasoning } from '@/ai/router';
import type { AIProvider, CompletionRequest } from '@/ai/provider';
import { LessonContentSchema, PracticeSetSchema } from '@/ai/types';

describe('stripReasoning', () => {
  it('leaves a plain reply alone', () => {
    expect(stripReasoning('{"a":1}')).toBe('{"a":1}');
  });

  it('removes a <think> block and keeps the answer', () => {
    const reply = '<think>Let me plan this out.</think>\n{"a":1}';
    expect(stripReasoning(reply)).toBe('{"a":1}');
  });

  it('keeps only what follows the last closing tag', () => {
    const reply = '<think>one</think> noise <think>two</think>{"a":1}';
    expect(stripReasoning(reply)).toBe('{"a":1}');
  });

  it('handles a stray closing tag with no opening tag', () => {
    expect(stripReasoning('deliberating…</think>{"a":1}')).toBe('{"a":1}');
  });

  it('drops an unterminated block, because the answer never arrived', () => {
    expect(stripReasoning('<think>still thinking about {units:')).toBe('');
  });

  it('recognises <reasoning> and mixed case', () => {
    expect(stripReasoning('<Reasoning>hm</REASONING>{"a":1}')).toBe('{"a":1}');
  });
});

describe('parseJsonSafe', () => {
  it('parses a bare object', () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a bare array', () => {
    expect(parseJsonSafe('[1,2]')).toEqual([1, 2]);
  });

  it('parses a fenced block', () => {
    expect(parseJsonSafe('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses a fenced block with prose on both sides', () => {
    const reply = 'Here is the blueprint:\n```json\n{"a":1}\n```\nLet me know if you want changes.';
    expect(parseJsonSafe(reply)).toEqual({ a: 1 });
  });

  it('ignores the brace sketch inside a reasoning block', () => {
    // The exact shape that broke curriculum planning: the model talks itself
    // through the schema, and the sketch is not valid JSON.
    const reply = [
      '<think>',
      'The user wants a blueprint. The shape is',
      '{',
      'title, description, units[...]',
      '}',
      'so I will fill that in.',
      '</think>',
      '{"title":"Course","units":[]}',
    ].join('\n');
    expect(parseJsonSafe(reply)).toEqual({ title: 'Course', units: [] });
  });

  it('is not confused by prose containing a brace after the JSON', () => {
    const reply = '{"a":1}\n\nNote: the {units} array is empty on purpose.';
    expect(parseJsonSafe(reply)).toEqual({ a: 1 });
  });

  it('does not mistake a brace inside a string for a boundary', () => {
    expect(parseJsonSafe('{"note":"use {curly} braces"}')).toEqual({
      note: 'use {curly} braces',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJsonSafe('prefix {"note":"say \\"hi\\""} suffix')).toEqual({
      note: 'say "hi"',
    });
  });

  it('reports what the model actually replied when nothing parses', () => {
    expect(() => parseJsonSafe('I cannot help with that request.')).toThrow(
      /Model replied: I cannot help with that request\./,
    );
  });

  it('reports an empty reply as empty', () => {
    expect(() => parseJsonSafe('   ')).toThrow(/\(empty\)/);
  });
});

describe('dropNulls', () => {
  it('removes null properties', () => {
    expect(dropNulls({ a: 1, b: null })).toEqual({ a: 1 });
  });

  it('recurses through nested objects and arrays', () => {
    expect(dropNulls({ s: [{ visual: null, title: 'x' }] })).toEqual({
      s: [{ title: 'x' }],
    });
  });

  it('leaves array elements in place, including null ones', () => {
    expect(dropNulls({ a: [1, null, 2] })).toEqual({ a: [1, null, 2] });
  });

  it('leaves values that are not null alone', () => {
    expect(dropNulls({ a: 0, b: '', c: false })).toEqual({ a: 0, b: '', c: false });
  });

  it('lets a lesson with null visuals validate', () => {
    // The shape that failed course generation: the model writes `null` for the
    // optional fields instead of leaving them out.
    const reply = {
      objectives: ['Do the thing'],
      sections: [
        { type: 'explanation', title: 'A', content: 'body', visual: null },
        {
          type: 'visual',
          title: 'B',
          content: 'body',
          visual: {
            type: 'diagram',
            purpose: 'show',
            subject: 'x',
            labels: [],
            caption: 'c',
            objectiveId: null,
          },
        },
      ],
      misconceptions: [],
      visuals: [],
      summary: 'done',
    };

    expect(LessonContentSchema.safeParse(reply).success).toBe(false);
    const repaired = LessonContentSchema.safeParse(dropNulls(reply));
    expect(repaired.success).toBe(true);
    expect(repaired.success && repaired.data.sections[0]?.visual).toBeUndefined();
  });

  it('lets a practice set with a null objectiveId validate', () => {
    const reply = {
      title: 'Set',
      level: 'guided',
      objectiveId: null,
      // A practice set now has to actually contain a question, so this fixture
      // carries one — the point of the test is the null objectiveId.
      questions: [{ kind: 'short_answer', prompt: 'State the chain rule.' }],
    };
    expect(PracticeSetSchema.safeParse(reply).success).toBe(false);
    expect(PracticeSetSchema.safeParse(dropNulls(reply)).success).toBe(true);
  });
});

describe('generateStructured repair loop', () => {
  const schema = z.object({ title: z.string() });

  /** Records what each attempt was asked, and replies from a fixed script. */
  function scriptedProvider(replies: string[]) {
    const seen: CompletionRequest[] = [];
    const provider = {
      complete: async (request: CompletionRequest) => {
        seen.push(request);
        return {
          content: replies[seen.length - 1] ?? '',
          model: request.model,
          provider: 'scripted',
          latencyMs: 1,
        };
      },
    } as unknown as AIProvider;
    return { provider, seen };
  }

  it('shows the model its own previous output when repairing', async () => {
    const bad = '{"titel":"typo"}';
    const { provider, seen } = scriptedProvider([bad, '{"title":"Course"}']);

    const result = await generateStructured(provider, 'm', { messages: [], schema });

    expect(result.value).toEqual({ title: 'Course' });
    expect(result.schemaFailures).toBe(1);

    const repair = seen[1]?.messages ?? [];
    expect(repair.at(-2)).toEqual({ role: 'assistant', content: bad });
    expect(repair.at(-1)?.content).toContain('valid JSON, but the wrong shape');
    expect(repair.at(-1)?.content).toContain('title');
  });

  it('names a parse failure as a parse failure', async () => {
    const { provider, seen } = scriptedProvider(['not json at all', '{"title":"Course"}']);

    await generateStructured(provider, 'm', { messages: [], schema });

    expect(seen[1]?.messages.at(-1)?.content).toContain('was not valid JSON');
  });

  it('does not offer stale output to repair after a request failure', async () => {
    const seen: CompletionRequest[] = [];
    const provider = {
      complete: async (request: CompletionRequest) => {
        seen.push(request);
        if (seen.length === 1) return { content: '{"titel":"typo"}', model: 'm', provider: 's' };
        if (seen.length === 2) throw new Error('connection reset');
        return { content: '{"title":"Course"}', model: 'm', provider: 's' };
      },
    } as unknown as AIProvider;

    const result = await generateStructured(provider, 'm', { messages: [], schema });

    expect(result.value).toEqual({ title: 'Course' });
    // Attempt 2 repairs the schema failure; attempt 3 follows a dropped
    // connection, so there is nothing to repair and the prompt is the original.
    expect(seen[1]?.messages).toHaveLength(2);
    expect(seen[2]?.messages).toHaveLength(0);
  });

  it('gives up with the last error after the retries are spent', async () => {
    const { provider } = scriptedProvider(['[]', '[]', '[]']);

    await expect(generateStructured(provider, 'm', { messages: [], schema })).rejects.toThrow(
      /failed after 3 attempts/,
    );
  });
});
