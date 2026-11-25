import { getLLMEnvConfig } from '../config.js';
import { LLMError, mapHttpError, type LLMCompleteRequest, type LLMProvider } from './provider.js';

/**
 * OpenAI-uyumlu /chat/completions istemcisi.
 * - LLM_PROVIDER=openai  → OpenAI veya OpenAI-uyumlu herhangi bir servis (LLM_BASE_URL ile)
 * - LLM_PROVIDER=ollama  → Yerel Ollama (varsayılan http://localhost:11434/v1, anahtar gerekmez)
 *
 * Ücretlendirme/kota: OpenAI ücretli bir API'dir; ücretsiz değildir. Ollama yereldir ve
 * kendi donanımınızda çalışır (model indirme boyutu ve donanım gereksinimi size aittir).
 * Hiçbir sağlayıcı sınırsız veya ücretsiz kullanım vaat etmez.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: 'openai' | 'ollama';
  private baseURL: string;
  private apiKey: string | null;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor() {
    const cfg = getLLMEnvConfig();
    this.name = cfg.provider;
    this.baseURL = cfg.baseURL;
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens;
    this.temperature = cfg.temperature;
  }

  isConfigured(): boolean {
    if (this.name === 'ollama') return true; // Ollama anahtarsız çalışır; erişilebilirlik çağrı anında belli olur
    return Boolean(this.apiKey);
  }

  describe() {
    const configured = this.isConfigured();
    const note =
      this.name === 'ollama'
        ? 'Ollama yerel çalışır; modelin bilgisayarınızda indirilmiş olması gerekir. Kota yoktur ancak yanıt hızı donanımınıza bağlıdır.'
        : configured
          ? 'OpenAI-uyumlu API. Ücretlendirme ve kota, sağlayıcınızın fiyatlandırılma modeline bağlıdır (ücretsiz değildir).'
          : 'LLM_API_KEY (veya OPENAI_API_KEY) tanımlı değil. .env dosyasına anahtar ekleyip sunucuyu yeniden başlatın.';
    return { provider: this.name, model: this.model, baseURL: this.baseURL, configured, note };
  }

  async complete(req: LLMCompleteRequest): Promise<string> {
    if (!this.isConfigured()) {
      throw new LLMError(
        'not_configured',
        this.name === 'openai'
          ? 'LLM API anahtarı yapılandırılmamış. .env dosyasına LLM_API_KEY ekleyin (veya Ollama yerel sağlamak için LLM_PROVIDER=ollama ayarlayın).'
          : 'Ollama yapılandırılmış ancak çağrı yapılamıyor.',
        { provider: this.name },
      );
    }
    const timeoutMs = req.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        max_tokens: req.maxTokens ?? this.maxTokens,
        temperature: req.temperature ?? this.temperature,
      };
      if (req.json) body.response_format = { type: 'json_object' };

      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) throw mapHttpError(res.status, text, this.name);

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LLMError('bad_json', `${this.name}: Sağlayıcı yanıtı JSON değil. Ayrıntı: ${text.slice(0, 200)}`, { provider: this.name });
      }
      const content = (parsed as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        throw new LLMError('empty_response', `${this.name}: Model boş yanıt döndürdü.`, { provider: this.name });
      }
      return content;
    } catch (err) {
      if (err instanceof LLMError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError('network', `${this.name}: Zaman aşımı (${Math.round(timeoutMs / 1000)}s). Model yanıt vermedi.`, { provider: this.name });
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new LLMError(
        'network',
        this.name === 'ollama'
          ? `Ollama'ya bağlanılamadı (${this.baseURL}). Ollama'nın çalıştığından ve modelin indirildiğinden emin olun. Ayrıntı: ${msg}`
          : `Sağlayıcıya bağlanılamadı (${this.baseURL}). Ayrıntı: ${msg}`,
        { provider: this.name },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

let cached: OpenAICompatibleProvider | null = null;
/** Testlerde sağlayıcıyı enjekte etmek için override noktası */
export let llmProviderOverride: LLMProvider | null = null;
export function setLLMProviderOverride(p: LLMProvider | null) {
  llmProviderOverride = p;
  cached = null;
}

export function getLLMProvider(): LLMProvider {
  if (llmProviderOverride) return llmProviderOverride;
  if (!cached) cached = new OpenAICompatibleProvider();
  return cached;
}
