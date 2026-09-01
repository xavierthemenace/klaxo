/**
 * Mock AI Provider (Development Mode Only)
 *
 * Deterministic, clearly-labelled fixtures for frontend/backend development
 * without external AI access. Each response is tagged provider="mock" so it can
 * never be mistaken for real NIM output.
 */
import {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderMetadata,
  StreamChunk,
} from './provider';

/**
 * Mock provider that returns canned responses based on the request content.
 * Used when AI_DEV_MODE=true.
 */
export class MockProvider implements AIProvider {
  readonly id = 'mock';
  readonly name = 'Development Fixtures (Mock)';
  private readonly models: Record<
    'planning' | 'generation' | 'assessment' | 'qa' | 'vision' | 'embedding',
    string
  >;

  constructor() {
    this.models = {
      planning: 'mock/planner',
      generation: 'mock/generator',
      assessment: 'mock/assessor',
      qa: 'mock/qa',
      vision: 'mock/vision',
      embedding: 'mock/embedder',
    };
  }

  async getMetadata(): Promise<ProviderMetadata> {
    return {
      name: this.name,
      version: '1.0.0',
      models: [
        { id: this.models.planning, type: 'chat', supportsJsonSchema: true, supportsStreaming: true },
        { id: this.models.generation, type: 'chat', supportsJsonSchema: true, supportsStreaming: true },
        { id: this.models.assessment, type: 'chat', supportsJsonSchema: true, supportsStreaming: true },
        { id: this.models.qa, type: 'chat', supportsJsonSchema: true, supportsStreaming: true },
        { id: this.models.vision, type: 'vision', supportsJsonSchema: true, supportsStreaming: true },
        { id: this.models.embedding, type: 'embedding' },
      ],
    };
  }

  getDefaultModel(
    task: 'planning' | 'generation' | 'assessment' | 'qa' | 'vision' | 'embedding',
  ): string {
    return this.models[task];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const content = this.mockContent(request);
    return {
      content,
      model: request.model,
      provider: this.id,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 1,
      finishReason: 'stop',
    };
  }

  async *streamComplete(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const content = this.mockContent(request);
    // Stream word-by-word with tiny delays to simulate streaming.
    const words = content.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 1));
      yield {
        delta: i === 0 ? words[i] ?? '' : ` ${words[i] ?? ''}`,
        done: false,
        model: request.model,
        provider: this.id,
      };
    }
    yield { delta: '', done: true, model: request.model, provider: this.id };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    // Deterministic pseudo-embeddings based on string length.
    const embeddings = inputs.map((text) => {
      const len = text.length;
      return [len % 10, (len * 2) % 10, (len * 3) % 10, (len * 4) % 10, (len * 5) % 10];
    });
    return {
      embeddings,
      model: request.model,
      provider: this.id,
      promptTokens: 0,
      latencyMs: 1,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Return deterministic mock JSON/text based on what pipeline stage is asking.
   */
  private mockContent(request: CompletionRequest): string {
    // Check for images in messages for vision mock
    const hasImages = request.messages.some(m => m.images && m.images.length > 0);
    
    // Match on the system prompt only. Matching the whole conversation meant a
    // course whose objective mentioned the word "blueprint" was handed the
    // blueprint fixture when it asked for a lesson.
    const prompt = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
      .toLowerCase();

    // Vision mock for image analysis (source extraction with images)
    if (hasImages && prompt.includes('source analyst')) {
      return JSON.stringify({
        title: 'Sample Course: Visual Content Analysis',
        subject: 'general',
        level: 'introductory',
        summary: 'Course extracted from visual source material (mock vision).',
        units: [
          { title: 'Unit 1: Visual Foundations', ordinal: 0, description: 'Content from images.', classification: 'REQUIRED', objectiveIds: [] },
          { title: 'Unit 2: Visual Application', ordinal: 1, description: 'Applying visual knowledge.', classification: 'REQUIRED', objectiveIds: [] },
        ],
        objectives: [
          { statement: 'Interpret visual information accurately.', category: 'knowledge', difficulty: 2, importance: 3, classification: 'REQUIRED', sourceFragmentIds: [] },
          { statement: 'Apply visual concepts to novel situations.', category: 'skill', difficulty: 3, importance: 4, classification: 'REQUIRED', sourceFragmentIds: [] },
        ],
        terminology: [
          { term: 'diagram', definition: 'A visual representation', domain: 'general' },
          { term: 'chart', definition: 'A graphical display of data', domain: 'general' },
        ],
        requirements: [],
        prerequisites: [],
        ambiguities: [],
        confidence: 0.9,
      });
    }

    // Source extraction mock (distinctive system prompt: "source analyst").
    if (prompt.includes('source analyst')) {
      return JSON.stringify({
        title: 'Sample Course: Introduction to Concepts',
        subject: 'general',
        level: 'introductory',
        summary: 'A sample course generated in development mode.',
        units: [
          { title: 'Unit 1: Foundations', ordinal: 0, description: 'Laying the groundwork.', classification: 'REQUIRED', objectiveIds: [] },
          { title: 'Unit 2: Application', ordinal: 1, description: 'Applying knowledge.', classification: 'REQUIRED', objectiveIds: [] },
        ],
        objectives: [
          // Cited the way a real model cites them: the label it was shown,
          // not a bare array index.
          { statement: 'Define foundational terms accurately.', category: 'knowledge', difficulty: 2, importance: 3, classification: 'REQUIRED', sourceFragmentIds: ['source-0'] },
          { statement: 'Apply foundational concepts to novel situations.', category: 'skill', difficulty: 3, importance: 4, classification: 'REQUIRED', sourceFragmentIds: ['source-0'] },
        ],
        terminology: [
          { term: 'concept', definition: 'An abstract idea', domain: 'general' },
          { term: 'foundation', definition: 'A basis or groundwork', domain: 'general' },
        ],
        requirements: [],
        prerequisites: [],
        ambiguities: [],
        confidence: 0.9,
      });
    }

    // Curriculum blueprint mock.
    if (prompt.includes('curriculum architect')) {
      return JSON.stringify({
        title: 'Sample Course: Introduction to Concepts',
        description: 'A comprehensive introduction.',
        intendedLearner: 'Beginner learners',
        assumedKnowledge: 'None',
        units: [
          {
            title: 'Unit 1: Foundations',
            description: 'Laying the groundwork.',
            classification: 'REQUIRED',
            topics: [{ title: 'Core Concepts', description: 'Basic definitions', classification: 'REQUIRED' }],
            objectives: [{ id: 'U1.O1', statement: 'Define foundational terms accurately.', category: 'knowledge', difficulty: 2, importance: 3, classification: 'REQUIRED' }],
            estimatedMinutes: 120,
          },
          {
            title: 'Unit 2: Application',
            description: 'Applying knowledge.',
            classification: 'REQUIRED',
            topics: [{ title: 'Practical Use', description: 'Real-world applications', classification: 'REQUIRED' }],
            objectives: [{ id: 'U2.O1', statement: 'Apply foundational concepts to novel situations.', category: 'skill', difficulty: 3, importance: 4, classification: 'REQUIRED' }],
            estimatedMinutes: 120,
          },
        ],
        prerequisites: [
          { objectiveId: 'U2.O1', prerequisiteId: 'U1.O1', strength: 'required', rationale: 'Foundations come first.' },
        ],
        estimatedMinutes: 240,
        classifications: { required: [], prerequisite: [], recommended: [], enrichment: [] },
      });
    }

    // Lesson generation mock (distinctive system prompt: "instructional designer").
    if (prompt.includes('instructional designer')) {
      return JSON.stringify({
        objectives: [],
        sections: [
          // Not in the enum on purpose: instructional-design models really do
          // write "introduction", and one label must not fail a whole lesson.
          { type: 'introduction', title: 'Introduction', content: 'What this lesson covers.' },
          { type: 'motivation', title: 'Why this matters', content: 'Understanding this concept unlocks deeper learning.' },
          { type: 'explanation', title: 'Core Explanation', content: 'The main idea explained clearly.' },
          { type: 'example', title: 'Worked Example', content: 'Here is a step-by-step example.' },
          { type: 'summary', title: 'Summary', content: 'Key takeaways.' },
        ],
        misconceptions: [
          { misconception: 'A common mistake', correction: 'The correct understanding' },
        ],
        visuals: [],
        masteryCheck: { prompt: 'Can you explain the concept in your own words?', criteria: 'Accurate explanation' },
        summary: 'Key takeaways from this lesson.',
        estimatedMinutes: 45,
      });
    }

    // Practice generation mock (distinctive system prompt: "practice-problem designer").
    if (prompt.includes('practice-problem designer')) {
      return JSON.stringify({
        title: 'Practice: Applying the concept',
        level: 'independent',
        questions: [
          {
            kind: 'mcq',
            prompt: 'Which of the following best defines the concept?',
            choices: [
              { text: 'The accurate definition', isCorrect: true },
              { text: 'A related but incorrect definition', isCorrect: false },
              { text: 'An unrelated idea', isCorrect: false },
            ],
            explanation: 'The correct option states the accurate definition.',
            misconceptions: ['Confusing related terms'],
            expectedSkill: 'recall',
            level: 'independent',
            difficulty: 2,
          },
          {
            kind: 'numeric',
            prompt: 'How many foundational terms were defined?',
            // A bare number, the way a model answers a numeric question.
            answerKey: 4,
            explanation: 'Four terms were listed.',
            expectedSkill: 'recall',
            level: 'independent',
            difficulty: 2,
          },
        ],
      });
    }

    // Assessment generation mock (distinctive system prompt: "assessment designer").
    if (prompt.includes('assessment designer')) {
      return JSON.stringify({
        kind: 'unit',
        title: 'Unit Assessment',
        instructions: 'Answer the following questions.',
        objectiveIds: [],
        questions: [
          {
            kind: 'mcq',
            prompt: 'What is the primary definition of the concept?',
            choices: [
              { text: 'Correct answer', isCorrect: true },
              { text: 'Wrong answer A', isCorrect: false },
              { text: 'Wrong answer B', isCorrect: false },
              { text: 'Wrong answer C', isCorrect: false },
            ],
            explanation: 'The correct answer aligns with the definition.',
            misconceptions: ['Confusing related terms'],
            expectedSkill: 'recall',
            difficulty: 2,
          },
          {
            kind: 'short_answer',
            prompt: 'Apply the concept to a situation of your own choosing.',
            answerKey: 'Any correct application of the concept.',
            explanation: 'Marks are for a correct application, not wording.',
            expectedSkill: 'transfer',
            difficulty: 3,
          },
        ],
        passThreshold: 0.8,
      });
    }

    // QA mock (distinctive system prompt: "quality-assurance reviewer").
    if (prompt.includes('quality-assurance reviewer')) {
      return JSON.stringify({
        checks: [
          { checkKey: 'source_coverage', severity: 'info', status: 'pass', message: 'All source material covered.' },
          { checkKey: 'objective_assessment_alignment', severity: 'info', status: 'pass', message: 'All objectives have assessments.' },
          // A failing, auto-fixable check, so the revision loop is exercised
          // rather than skipped entirely under mock.
          { checkKey: 'empty_lesson_content', severity: 'warning', status: 'fail', message: 'A lesson looks thin.', autoFixable: true },
        ],
        summary: 'QA run complete (mock).',
      });
    }

    // Default mock response.
    return JSON.stringify({
      message: 'Development fixture response (mock). No real AI was invoked.',
      provider: 'mock',
    });
  }
}