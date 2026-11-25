import type { ResearchRun, Source, Fact } from '../shared/schema.js';
import type { LLMProvider } from '../server/llm/provider.js';

export const NOW = '2026-11-25T10:00:00.000Z';

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    kind: 'url',
    url: 'https://example.com/a',
    title: 'Örnek Kaynak',
    status: 'ok',
    error: null,
    contentText: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi. Başkent Ankara’dır. Türkiye’nin nüfusu yaklaşık 85 milyon kişidir. İstanbul, Boğaz’ın iki yakasına kurulmuştur.',
    contentTruncated: false,
    fetchedAt: NOW,
    addedNote: null,
    ...overrides,
  };
}

export function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    fact_id: 'F001',
    statement: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi.',
    source_id: 'src-1',
    source_url: 'https://example.com/a',
    source_title: 'Örnek Kaynak',
    quote: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi',
    confidence: 'high',
    kind: 'fact',
    quote_verified: true,
    status: 'approved',
    note: null,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<ResearchRun> = {}): ResearchRun {
  return {
    schema_version: 1,
    id: 'testrun-0001',
    created_at: NOW,
    updated_at: NOW,
    topic: 'Türkiye Cumhuriyeti ilanı',
    audience: 'Genel izleyici',
    tone: 'Bilgilendirici',
    target_seconds: 300,
    language: 'tr',
    sources: [makeSource()],
    facts: [makeFact()],
    contradictions: [],
    research_notes: null,
    script: null,
    factcheck: null,
    ...overrides,
  };
}

export function fakeProvider(output: string | string[], opts: { fail?: Error } = {}): LLMProvider & { calls: number } {
  const p = {
    name: 'openai' as const,
    calls: 0,
    isConfigured: () => true,
    describe: () => ({ provider: 'openai', model: 'test-model', baseURL: 'http://test', configured: true, note: 'test' }),
    complete: async () => {
      if (opts.fail) throw opts.fail;
      const out = Array.isArray(output) ? output[Math.min(p.calls, output.length - 1)] : output;
      p.calls += 1;
      return out;
    },
  };
  return p;
}

export function countingProvider(fn: (callIndex: number) => string | Promise<string>): LLMProvider & { calls: number } {
  const p = {
    name: 'openai' as const,
    calls: 0,
    isConfigured: () => true,
    describe: () => ({ provider: 'openai', model: 'test-model', baseURL: 'http://test', configured: true, note: 'test' }),
    complete: async () => {
      const out = fn(p.calls);
      p.calls += 1;
      return out instanceof Promise ? out : out;
    },
  };
  return p;
}
