import type { ResearchRun, Fact, FactStatus, Confidence } from '../shared/schema.js';

export type { ResearchRun, Fact, FactStatus, Confidence };

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  } catch {
    throw new ApiError('Sunucuya ulaşılamadı. Sunucunun çalıştığından emin olun (npm run dev).', 0, 'network');
  }
  if (!res.ok) {
    let message = `İstek başarısız (HTTP ${res.status})`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      code = body.code;
    } catch {
      // govde json degil
    }
    throw new ApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

export interface ConfigResponse {
  llm: { provider: string; model: string; baseURL: string; configured: boolean; note: string };
  search: { provider: string; configured: boolean; detail: string };
  limits: { maxSourcesPerRun: number; maxPastedSources: number; maxUrlBatches: number };
}

export interface RunSummary {
  id: string;
  topic: string;
  created_at: string;
  updated_at: string;
  source_count: number;
  ok_source_count: number;
  fact_count: number;
  approved_fact_count: number;
  has_script: boolean;
  factcheck_ok: boolean | null;
}

export const api = {
  config: () => request<ConfigResponse>('/api/config'),
  listRuns: () => request<{ runs: RunSummary[] }>('/api/runs'),
  getRun: (id: string) => request<{ run: ResearchRun }>(`/api/runs/${id}`),
  createRun: (body: unknown) => request<{ run: ResearchRun }>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  deleteRun: (id: string) => request<{ ok: true }>(`/api/runs/${id}`, { method: 'DELETE' }),

  addSource: (id: string, body: { url?: string; title?: string; text?: string }) =>
    request<{ run: ResearchRun }>(`/api/runs/${id}/sources`, { method: 'POST', body: JSON.stringify(body) }),
  fetchSources: (id: string) => request<{ run: ResearchRun; fetched: number }>(`/api/runs/${id}/sources/fetch`, { method: 'POST' }),
  searchSources: (id: string, body: { query?: string; count?: number }) =>
    request<{ run: ResearchRun; added: number; provider: { provider: string; detail: string } }>(`/api/runs/${id}/sources/search`, { method: 'POST', body: JSON.stringify(body) }),
  removeSource: (id: string, sourceId: string) => request<{ run: ResearchRun }>(`/api/runs/${id}/sources/${sourceId}`, { method: 'DELETE' }),

  research: (id: string) => request<{ run: ResearchRun; stats: { batches: number; sources: number; facts: number; contradictions: number } }>(`/api/runs/${id}/research`, { method: 'POST' }),
  patchFacts: (id: string, patches: Array<{ fact_id: string; statement?: string; status?: FactStatus; confidence?: Confidence; note?: string | null }>) =>
    request<{ run: ResearchRun }>(`/api/runs/${id}/facts`, { method: 'PATCH', body: JSON.stringify({ patches }) }),

  generateScript: (id: string) => request<{ run: ResearchRun }>(`/api/runs/${id}/script`, { method: 'POST' }),
  patchScript: (id: string, body: { title?: string; sentences?: Array<{ id: string; text?: string; fact_ids?: string[] }> }) =>
    request<{ run: ResearchRun }>(`/api/runs/${id}/script`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSentence: (id: string, sentenceId: string) => request<{ run: ResearchRun }>(`/api/runs/${id}/script/sentences/${sentenceId}`, { method: 'DELETE' }),

  factcheck: (id: string) => request<{ run: ResearchRun }>(`/api/runs/${id}/factcheck`, { method: 'POST' }),
  exportMarkdownUrl: (id: string) => `/api/runs/${id}/export.md`,
  exportJsonUrl: (id: string) => `/api/runs/${id}/export.json`,
  exportMarkdownText: async (id: string) => {
    const res = await fetch(`/api/runs/${id}/export.md`);
    if (!res.ok) throw new ApiError('Markdown dışa aktarımı alınamadı', res.status);
    return res.text();
  },
};
