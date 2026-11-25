/**
 * LLM sağlayıcı arayüzü. Araştırma (researcher), senaryo (scriptwriter) ve
 * denetim (fact-checker) aşamaları bu arayüz üzerinden çalışır;
 * hangi sağlayıcı/model kullanıldığından bağımsızdırlar.
 */

export type LLMErrorCode =
  | 'not_configured' // sağlayıcı yapılandırılmamış / anahtar yok
  | 'auth' // 401/403 — geçersiz anahtar
  | 'rate_limit' // 429 — kota aşımı
  | 'bad_request' // 400 — istek hatası
  | 'server_error' // 5xx — sağlayıcı hatası
  | 'network' // bağlantı / zaman aşımı
  | 'empty_response' // boş yanıt
  | 'bad_json'; // model JSON üretmedi / şemadan geçmedi

export class LLMError extends Error {
  code: LLMErrorCode;
  status?: number;
  provider?: string;
  constructor(code: LLMErrorCode, message: string, opts: { status?: number; provider?: string } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = opts.status;
    this.provider = opts.provider;
  }
}

export interface LLMCompleteRequest {
  system: string;
  user: string;
  /** true ise sağlayıcıdan JSON yanıt istenir (response_format) */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** ms; varsayılan 120_000 */
  timeoutMs?: number;
}

export interface LLMProvider {
  /** 'openai' | 'ollama' */
  readonly name: string;
  /** modeli çağırabilecek durumda görünüyor mu (anahtar/gereksinim var mı) */
  isConfigured(): boolean;
  /** kullanıcıya gösterilecek kısa yapılandırma özeti (anahtar hariç) */
  describe(): { provider: string; model: string; baseURL: string; configured: boolean; note: string };
  complete(req: LLMCompleteRequest): Promise<string>;
}

/** Sağlayıcı HTTP hatasını anlamlı LLMError'a çevirir (anahtar asla mesajlara konmaz) */
export function mapHttpError(status: number, bodyText: string, provider: string): LLMError {
  const trimmed = bodyText.replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) {
    return new LLMError('auth', `${provider}: API anahtarı geçersiz veya yetkisiz (HTTP ${status}). Anahtarınızı .env dosyasında kontrol edin.`, { status, provider });
  }
  if (status === 429) {
    return new LLMError('rate_limit', `${provider}: Kota/hız sınırına takıldınız (HTTP 429). Bir süre bekleyin, planınızı kontrol edin veya daha düşük kullanımlı bir model deneyin.`, { status, provider });
  }
  if (status === 400 || status === 404 || status === 422) {
    return new LLMError('bad_request', `${provider}: İstek reddedildi (HTTP ${status}). Model adı ve istek biçimi yanlış olabilir. Ayrıntı: ${trimmed}`, { status, provider });
  }
  if (status >= 500) {
    return new LLMError('server_error', `${provider}: Sağlayıcı sunucu hatası (HTTP ${status}). Daha sonra tekrar deneyin. Ayrıntı: ${trimmed}`, { status, provider });
  }
  return new LLMError('bad_request', `${provider}: Beklenmeyen yanıt (HTTP ${status}). Ayrıntı: ${trimmed}`, { status, provider });
}
