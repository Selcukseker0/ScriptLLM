import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { LLMError, mapHttpError } from '../server/llm/provider.js';
import { extractJson, quoteAppearsIn, normalizeForMatch } from '../server/llm/json.js';
import { OpenAICompatibleProvider } from '../server/llm/openaiCompatible.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('mapHttpError', () => {
  it('429 → rate_limit (mesajda anahtar geçmez)', () => {
    const err = mapHttpError(429, '{"error":{"message":"quota exceeded for sk-secret-123"}}', 'openai');
    expect(err.code).toBe('rate_limit');
    expect(err.message).toContain('429');
  });
  it('401/403 → auth', () => {
    expect(mapHttpError(401, '', 'openai').code).toBe('auth');
    expect(mapHttpError(403, '', 'ollama').code).toBe('auth');
  });
  it('400 → bad_request, 500 → server_error', () => {
    expect(mapHttpError(400, 'x', 'openai').code).toBe('bad_request');
    expect(mapHttpError(503, 'x', 'openai').code).toBe('server_error');
  });
});

describe('extractJson', () => {
  const schema = z.object({ a: z.string() });
  it('düz JSON ayrıştırır', () => {
    expect(extractJson('{"a":"merhaba"}', schema, 'test')).toEqual({ a: 'merhaba' });
  });
  it('kod çitleri arasındaki JSON’u ayıklar', () => {
    expect(extractJson('İşte yanıt:\n```json\n{"a":"merhaba"}\n```\n', schema, 'test')).toEqual({ a: 'merhaba' });
  });
  it('şemaya uymayan JSON’da bad_json fırlatır', () => {
    try {
      extractJson('{"b":1}', schema, 'test');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe('bad_json');
    }
  });
  it('bozuk model çıktısında bad_json fırlatır ve içerik uydurmaz', () => {
    try {
      extractJson('maalesef yapamadım', schema, 'test');
      expect.unreachable();
    } catch (err) {
      expect((err as LLMError).code).toBe('bad_json');
    }
  });
});

describe('quoteAppearsIn / normalizeForMatch', () => {
  it('alıntının kaynak metinde geçtiğini doğrular', () => {
    expect(quoteAppearsIn('Cumhuriyet 1923 yılında ilan edildi', 'Türkiye Cumhuriyeti, 1923 YILINDA ilan edildi. Başkent Ankara.')).toBe(true);
  });
  it('uydurma alıntıyı reddeder', () => {
    expect(quoteAppearsIn('Mars’a 1969’da iniş yapıldı', 'Türkiye Cumhuriyeti 1923 yılında ilan edildi.')).toBe(false);
  });
  it('normalizasyon Türkçe karakter ve noktalamayı töler eder', () => {
    expect(normalizeForMatch('İstanbul’da, 1923!')).toContain('istanbul');
  });
});

describe('OpenAICompatibleProvider', () => {
  it('429 yanıtında rate_limit hatası verir', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.example.com/v1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 })));
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'rate_limit' });
  });

  it('401 yanıtında auth hatası verir', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.example.com/v1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'auth' });
  });

  it('başarılı yanıtta içerik metnini döndürür', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.example.com/v1');
    const payload = { choices: [{ message: { content: '{"ok":true}' } }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete({ system: 's', user: 'u', json: true })).resolves.toBe('{"ok":true}');
  });

  it('anahtar yoksa not_configured hatası fırlatır (istek atılmaz)', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.example.com/v1');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('boş model yanıtında empty_response hatası verir', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.example.com/v1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 })));
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'empty_response' });
  });
});
