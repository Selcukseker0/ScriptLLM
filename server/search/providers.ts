import { getSearchEnvConfig, type SearchProviderName } from '../config.js';
import { normalizeForMatch } from '../llm/json.js';
import { assessSourceRelevance } from '../research/relevance.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Sonucun hangi sağlayıcıdan geldiği */
  provider: SearchProviderName;
}

export interface SearchProvider {
  readonly name: SearchProviderName;
  isConfigured(): boolean;
  describe(): { provider: SearchProviderName; configured: boolean; detail: string };
  search(query: string, count: number): Promise<SearchResult[]>;
}

const SEARCH_STOPWORDS = new Set(['icin', 'için', 'hakkinda', 'hakkında', 'nedir', 'nasil', 'nasıl', 'ne', 've', 'ile', 'bir', 'bu', 'mi', 'mı', 'mu', 'mü', 'the', 'about']);

/** Wikipedia metin araması için konuyu ana kavramlara ayırır; ülke/çekim eklerini sorguya taşımamaya çalışır. */
export function buildSearchQueries(topic: string): string[] {
  const normalized = normalizeForMatch(topic);
  const words = normalized.split(/\s+/).filter((word) => word.length > 2 && !SEARCH_STOPWORDS.has(word));
  const hasEarthquake = words.some((word) => ['deprem', 'sismik', 'earthquake'].some((stem) => word.startsWith(stem)));
  if (hasEarthquake) {
    return ['deprem güvenliği', 'deprem', 'deprem hazırlığı', 'AFAD deprem', 'Kandilli deprem'];
  }
  const stripped = topic
    .replace(/[’'](?:de|da|te|ta|den|dan|ten|tan)\b/gi, '')
    .replace(/[?!.,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = [words.slice(-3).join(' '), words.slice(0, 3).join(' '), stripped];
  return [...new Set(candidates.map((q) => q.trim()).filter((q) => q.length >= 2))].slice(0, 4);
}

/** Wikipedia sonuçlarını başlık+snippet konu filtresinden geçirip, alakasız sonuç varken yeni varyantları dener. */
export async function searchTopic(provider: SearchProvider, topic: string, count: number): Promise<{ results: SearchResult[]; queries: string[] }> {
  const queryOptions = provider.name === 'wikipedia' ? buildSearchQueries(topic) : [topic];
  const results: SearchResult[] = [];
  const tried: string[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  for (const query of queryOptions) {
    tried.push(query);
    try {
      const found = await provider.search(query, count);
      for (const item of found) {
        if (seen.has(item.url)) continue;
        if (provider.name === 'wikipedia' && !assessSourceRelevance(topic, { title: item.title, contentText: item.snippet }).relevant) continue;
        seen.add(item.url);
        results.push(item);
      }
    } catch (err) {
      lastError = err;
    }
    if (results.length >= Math.min(4, count)) break;
  }
  if (results.length === 0 && lastError) throw lastError;
  return { results: results.slice(0, count), queries: tried };
}

export class SearchError extends Error {
  code: 'not_configured' | 'rate_limit' | 'auth' | 'network' | 'bad_response';
  constructor(code: SearchError['code'], message: string) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new SearchError('auth', `Arama sağlayıcısı yetkilendirme hatası (HTTP ${res.status}). API anahtarınızı kontrol edin.`);
      if (res.status === 429) throw new SearchError('rate_limit', 'Arama sağlayıcısı kota/hız sınırı (HTTP 429). Bir süre bekleyip tekrar deneyin.');
      throw new SearchError('bad_response', `Arama sağlayıcısı HTTP ${res.status} döndürdü: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SearchError('bad_response', 'Arama sağlayıcısı geçersiz yanıt döndürdü.');
    }
  } catch (err) {
    if (err instanceof SearchError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw new SearchError('network', 'Arama isteği zaman aşımına uğradı.');
    throw new SearchError('network', `Arama servisine ulaşılamadı: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily — LLM odaklı arama API'si (ücretli plan/kota; ücretsiz değildir) */
class TavilyProvider implements SearchProvider {
  readonly name = 'tavily' as const;
  private key: string | null;
  constructor(private detail: string) {
    this.key = process.env.TAVILY_API_KEY?.trim() || null;
  }
  isConfigured() {
    return Boolean(this.key);
  }
  describe() {
    return { provider: this.name, configured: this.isConfigured(), detail: this.detail };
  }
  async search(query: string, count: number): Promise<SearchResult[]> {
    if (!this.key) throw new SearchError('not_configured', 'TAVILY_API_KEY tanımlı değil.');
    const data = (await fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: this.key, query, max_results: Math.min(count, 10), search_depth: 'basic', include_answer: false }),
    })) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results || [])
      .filter((r) => r.url)
      .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: (r.content || '').slice(0, 300), provider: this.name }));
  }
}

/** Brave Search API — bağımsız dizin (anahtar gerekir; ücretsiz katmanında kota vardır) */
class BraveProvider implements SearchProvider {
  readonly name = 'brave' as const;
  private key: string | null;
  constructor(private detail: string) {
    this.key = process.env.BRAVE_API_KEY?.trim() || null;
  }
  isConfigured() {
    return Boolean(this.key);
  }
  describe() {
    return { provider: this.name, configured: this.isConfigured(), detail: this.detail };
  }
  async search(query: string, count: number): Promise<SearchResult[]> {
    if (!this.key) throw new SearchError('not_configured', 'BRAVE_API_KEY tanımlı değil.');
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}&search_lang=tr`;
    const data = (await fetchJson(url, { headers: { 'X-Subscription-Token': this.key, accept: 'application/json' } })) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (data.web?.results || [])
      .filter((r) => r.url)
      .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: (r.description || '').slice(0, 300), provider: this.name }));
  }
}

/**
 * Wikipedia API — anahtarsız resmî açık API. Tek başına yeterli değildir;
 * daha geniş kapsam için Tavily/Brave anahtarı önerilir. Google sonuç sayfaları kazınmaz.
 */
class WikipediaProvider implements SearchProvider {
  readonly name = 'wikipedia' as const;
  constructor(private detail: string) {}
  isConfigured() {
    return true;
  }
  describe() {
    return { provider: this.name, configured: true, detail: this.detail };
  }
  private async wiki(host: string, query: string, count: number): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      action: 'query', list: 'search', srsearch: query, srnamespace: '0',
      srlimit: String(Math.min(count, 10)), srwhat: 'text', srprop: 'snippet', format: 'json', utf8: '1',
    });
    const url = `https://${host}/w/api.php?${params.toString()}`;
    const data = (await fetchJson(url, { headers: { 'user-agent': 'ScriptLLM/1.0 (source research; https://github.com/Selcukseker0/ScriptLLM)', accept: 'application/json' } })) as {
      query?: { search?: Array<{ title?: string; snippet?: string }> };
    };
    return (data.query?.search ?? [])
      .filter((item) => item.title)
      .map((item) => {
        const title = item.title!;
        const snippet = (item.snippet ?? '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
        return {
          title,
          url: `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
          snippet: snippet.slice(0, 500),
          provider: this.name,
        };
      });
  }
  async search(query: string, count: number): Promise<SearchResult[]> {
    // Türkçe konu için yalnızca Türkçe Wikipedia kullan; İngilizce sonuçları
    // Türkçe arama sonuçlarına sessizce karıştırmak alakasız eşleşmelere yol açabiliyor.
    return this.wiki('tr.wikipedia.org', query, count);
  }
}

class NoneProvider implements SearchProvider {
  readonly name = 'none' as const;
  constructor(private detail: string) {}
  isConfigured() {
    return false;
  }
  describe() {
    return { provider: this.name, configured: false, detail: this.detail };
  }
  async search(): Promise<SearchResult[]> {
    throw new SearchError('not_configured', this.detail);
  }
}

export function getSearchProvider(): SearchProvider {
  const cfg = getSearchEnvConfig();
  switch (cfg.provider) {
    case 'tavily':
      return new TavilyProvider(cfg.detail);
    case 'brave':
      return new BraveProvider(cfg.detail);
    case 'wikipedia':
      return new WikipediaProvider(cfg.detail);
    default:
      return new NoneProvider(cfg.detail);
  }
}
