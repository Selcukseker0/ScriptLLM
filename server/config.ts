import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = process.cwd();
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const PORT = Number(process.env.PORT || 5174);
export const IS_PROD = process.env.NODE_ENV === 'production';

export function ensureDataDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

export interface LLMEnvConfig {
  provider: 'openai' | 'ollama';
  baseURL: string;
  apiKey: string | null;
  model: string;
  maxTokens: number;
  temperature: number;
}

export function getLLMEnvConfig(): LLMEnvConfig {
  const rawProvider = (process.env.LLM_PROVIDER || 'openai').trim().toLowerCase();
  const provider: 'openai' | 'ollama' = rawProvider === 'ollama' ? 'ollama' : 'openai';
  const baseURL =
    process.env.LLM_BASE_URL?.trim().replace(/\/+$/, '') ||
    (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1');
  const apiKey =
    process.env.LLM_API_KEY?.trim() || (provider === 'openai' ? process.env.OPENAI_API_KEY?.trim() || null : 'ollama') || null;
  const model =
    process.env.LLM_MODEL?.trim() || (provider === 'ollama' ? 'llama3.1' : 'gpt-4o-mini');
  const maxTokens = Math.min(Math.max(Number(process.env.LLM_MAX_TOKENS || 4096) || 4096, 256), 16000);
  const temperature = Math.min(Math.max(Number(process.env.LLM_TEMPERATURE ?? 0.3) || 0.3, 0), 1);
  return { provider, baseURL, apiKey, model, maxTokens, temperature };
}

export type SearchProviderName = 'tavily' | 'brave' | 'wikipedia' | 'none';

export interface SearchEnvConfig {
  provider: SearchProviderName;
  /** Yapılandırma kullanıcıya gösterilir; anahtar asla gösterilmez */
  detail: string;
}

export function getSearchEnvConfig(): SearchEnvConfig {
  const explicit = (process.env.SEARCH_PROVIDER || '').trim().toLowerCase();
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const braveKey = process.env.BRAVE_API_KEY?.trim();

  if (explicit === 'none') return { provider: 'none', detail: 'Arama sağlayıcısı kapatıldı (SEARCH_PROVIDER=none)' };
  if (explicit === 'tavily') {
    return tavilyKey
      ? { provider: 'tavily', detail: 'Tavily Search API' }
      : { provider: 'none', detail: 'SEARCH_PROVIDER=tavily ayarlı ancak TAVILY_API_KEY eksik' };
  }
  if (explicit === 'brave') {
    return braveKey
      ? { provider: 'brave', detail: 'Brave Search API' }
      : { provider: 'none', detail: 'SEARCH_PROVIDER=brave ayarlı ancak BRAVE_API_KEY eksik' };
  }
  if (explicit === 'wikipedia') return { provider: 'wikipedia', detail: 'Türkçe Wikipedia API (anahtarsız, sınırlı kapsam)' };
  // Otomatik seçim: anahtar varsa onu kullan, yoksa Wikipedia (ücretsiz ama sınırlı kapsam)
  if (tavilyKey) return { provider: 'tavily', detail: 'Tavily Search API (TAVILY_API_KEY)' };
  if (braveKey) return { provider: 'brave', detail: 'Brave Search API (BRAVE_API_KEY)' };
  return { provider: 'wikipedia', detail: 'Türkçe Wikipedia API (anahtarsız, sınırlı kapsam) — daha geniş sonuç için TAVILY_API_KEY veya BRAVE_API_KEY ekleyin' };
}
