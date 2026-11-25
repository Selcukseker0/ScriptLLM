import path from 'node:path';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { IS_PROD, PORT, ensureDataDir } from './config.js';
import { CreateRunRequestSchema, FactPatchSchema, SentencePatchSchema, type ResearchRun, type Source } from '../shared/schema.js';
import { getLLMProvider } from './llm/openaiCompatible.js';
import { LLMError } from './llm/provider.js';
import { getSearchProvider, SearchError } from './search/providers.js';
import { fetchSource, MAX_SOURCE_CHARS, normalizePlainText, FetchError } from './research/fetcher.js';
import { runResearcher, ResearchAgentError } from './research/researcher.js';
import { runScriptwriter, ScriptwriterError } from './research/scriptwriter.js';
import { runFactChecker, FactCheckError } from './research/factchecker.js';
import { deleteRun, getRun, listRuns, newRunId, saveRun, StorageError } from './storage.js';
import { toJson, toMarkdown } from './export.js';

ensureDataDir();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

type AsyncHandler = (req: Request, res: Response) => Promise<void>;
const ah =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const llmStatus = (err: LLMError) =>
  err.code === 'rate_limit' ? 429 : err.code === 'auth' ? 401 : err.code === 'not_configured' ? 400 : err.code === 'network' ? 504 : 502;

function sendError(res: Response, status: number, message: string, code?: string) {
  res.status(status).json({ error: message, code });
}

function slugify(text: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
  return text
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'scriptllm-export';
}

function normalizePastedText(text: string): { text: string; truncated: boolean } {
  const cleaned = normalizePlainText(text);
  return cleaned.length > MAX_SOURCE_CHARS ? { text: cleaned.slice(0, MAX_SOURCE_CHARS), truncated: true } : { text: cleaned, truncated: false };
}

function parseIdParam(value: string | string[]): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
    const err = new StorageError('not_found', 'Geçersiz çalışma kimliği.');
    throw err;
  }
  return id;
}

function updateRun(id: string, mutate: (run: ResearchRun) => void | ResearchRun): ResearchRun {
  const run = getRun(id);
  const result = mutate(run);
  const next = result ?? run;
  return saveRun(next);
}

// ---------- Yapılandırma (anahtarlar ASLA dönmez) ----------
app.get('/api/config', (_req, res) => {
  const llm = getLLMProvider().describe();
  const search = getSearchProvider().describe();
  res.json({ llm, search, limits: { maxSourcesPerRun: 12, maxPastedSources: 8, maxUrlBatches: 4 } });
});

// ---------- Çalışmalar ----------
app.get('/api/runs', (_req, res) => res.json({ runs: listRuns() }));

app.post(
  '/api/runs',
  ah(async (req, res) => {
    const body = CreateRunRequestSchema.parse(req.body);
    const now = new Date().toISOString();
    const sources: Source[] = [];
    for (const url of body.urls) {
      sources.push({
        id: newRunId().slice(0, 13),
        kind: 'url',
        url,
        title: url,
        status: 'pending',
        error: null,
        contentText: '',
        contentTruncated: false,
        fetchedAt: null,
        addedNote: null,
      });
    }
    for (const pasted of body.pasted_sources) {
      const { text, truncated } = normalizePastedText(pasted.text);
      sources.push({
        id: newRunId().slice(0, 13),
        kind: 'text',
        url: null,
        title: pasted.title,
        status: 'ok',
        error: null,
        contentText: text,
        contentTruncated: truncated,
        fetchedAt: now,
        addedNote: 'Kullanıcı tarafından yapıştırıldı',
      });
    }
    const run: ResearchRun = {
      schema_version: 1,
      id: newRunId(),
      created_at: now,
      updated_at: now,
      topic: body.topic,
      audience: body.audience,
      tone: body.tone,
      target_seconds: body.target_seconds,
      language: 'tr',
      sources,
      facts: [],
      contradictions: [],
      research_notes: null,
      script: null,
      factcheck: null,
    };
    res.status(201).json({ run: saveRun(run) });
  }),
);

app.get(
  '/api/runs/:id',
  ah(async (req, res) => {
    res.json({ run: getRun(parseIdParam(req.params.id)) });
  }),
);

app.delete(
  '/api/runs/:id',
  ah(async (req, res) => {
    deleteRun(parseIdParam(req.params.id));
    res.json({ ok: true });
  }),
);

// ---------- Kaynaklar ----------
app.post(
  '/api/runs/:id/sources',
  ah(async (req, res) => {
    const schema = z
      .object({
        url: z.string().trim().url().optional(),
        title: z.string().trim().min(1).max(300).optional(),
        text: z.string().min(50).max(120_000).optional(),
      })
      .refine((v) => v.url || (v.title && v.text), { message: 'url ya da title+text gerekli' });
    const body = schema.parse(req.body);
    const id = parseIdParam(req.params.id);
    const run = updateRun(id, (r) => {
      if (r.sources.length >= 20) throw new StorageError('io', 'Çalışma başına en fazla 20 kaynak eklenebilir.');
      if (body.url) {
        if (r.sources.some((s) => s.url === body.url)) throw new StorageError('io', 'Bu URL zaten listede.');
        r.sources.push({
          id: newRunId().slice(0, 13),
          kind: 'url',
          url: body.url,
          title: body.url,
          status: 'pending',
          error: null,
          contentText: '',
          contentTruncated: false,
          fetchedAt: null,
          addedNote: null,
        });
      } else {
        const { text, truncated } = normalizePastedText(body.text!);
        r.sources.push({
          id: newRunId().slice(0, 13),
          kind: 'text',
          url: null,
          title: body.title!,
          status: 'ok',
          error: null,
          contentText: text,
          contentTruncated: truncated,
          fetchedAt: new Date().toISOString(),
          addedNote: 'Kullanıcı tarafından yapıştırıldı',
        });
      }
    });
    res.status(201).json({ run });
  }),
);

app.post(
  '/api/runs/:id/sources/fetch',
  ah(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const run = getRun(id);
    const targets = run.sources.filter((s) => s.kind === 'url' && s.status !== 'ok');
    for (const source of targets) {
      try {
        const fetched = await fetchSource(source.url!);
        source.title = fetched.title;
        source.url = fetched.finalUrl || source.url;
        source.contentText = fetched.text;
        source.contentTruncated = fetched.truncated;
        source.status = 'ok';
        source.error = null;
        source.fetchedAt = new Date().toISOString();
      } catch (err) {
        source.status = 'failed';
        source.error = err instanceof FetchError ? err.message : `Beklenmeyen hata: ${err instanceof Error ? err.message : String(err)}`;
        source.fetchedAt = new Date().toISOString();
      }
    }
    res.json({ run: saveRun(run), fetched: targets.length });
  }),
);

app.post(
  '/api/runs/:id/sources/search',
  ah(async (req, res) => {
    const body = z.object({ query: z.string().trim().min(2).max(300).optional(), count: z.coerce.number().int().min(1).max(10).default(6) }).parse(req.body ?? {});
    const id = parseIdParam(req.params.id);
    const provider = getSearchProvider();
    if (!provider.isConfigured()) {
      sendError(res, 400, `Arama yapılamıyor: ${provider.describe().detail}. URL ekleyebilir veya kaynak metnini yapıştırabilirsiniz.`, 'search_not_configured');
      return;
    }
    const run = getRun(id);
    const query = body.query || run.topic;
    let results;
    try {
      results = await provider.search(query, body.count);
    } catch (err) {
      if (err instanceof SearchError) {
        sendError(res, err.code === 'rate_limit' ? 429 : err.code === 'auth' ? 401 : 502, err.message, err.code);
        return;
      }
      throw err;
    }
    let added = 0;
    const existing = new Set(run.sources.map((s) => s.url).filter(Boolean));
    for (const r of results) {
      if (existing.has(r.url)) continue;
      run.sources.push({
        id: newRunId().slice(0, 13),
        kind: 'url',
        url: r.url,
        title: r.title.slice(0, 300),
        status: 'pending',
        error: null,
        contentText: '',
        contentTruncated: false,
        fetchedAt: null,
        addedNote: `Arama sonucu (${provider.name}): ${r.snippet.slice(0, 200)}`,
      });
      existing.add(r.url);
      added++;
    }
    const saved = saveRun(run);
    res.json({ run: saved, added, provider: provider.describe() });
  }),
);

app.delete(
  '/api/runs/:id/sources/:sourceId',
  ah(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const run = updateRun(id, (r) => {
      const sourceId = String(req.params.sourceId);
      const idx = r.sources.findIndex((s) => s.id === sourceId);
      if (idx === -1) throw new StorageError('not_found', 'Kaynak bulunamadı.');
      const removed = r.sources.splice(idx, 1)[0];
      // Bu kaynağa dayanan olguları da kaldır — dayanağı silinen olgu listede kalamaz
      const removedFacts = r.facts.filter((f) => f.source_id === removed.id).length;
      r.facts = r.facts.filter((f) => f.source_id !== removed.id);
      if (removedFacts > 0) {
        r.research_notes = [r.research_notes, `Kaynak silindiği için ${removedFacts} olgu listeden çıkarıldı.`].filter(Boolean).join('\n');
      }
      r.factcheck = null;
    });
    res.json({ run });
  }),
);

// ---------- Araştırma (Researcher) ----------
app.post(
  '/api/runs/:id/research',
  ah(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const run = getRun(id);
    const llm = getLLMProvider();
    if (!llm.isConfigured()) {
      sendError(res, 400, 'LLM sağlayıcısı yapılandırılmamış. .env dosyasına LLM_API_KEY ekleyin (veya yerel kullanım için LLM_PROVIDER=ollama).', 'llm_not_configured');
      return;
    }
    try {
      const result = await runResearcher(run);
      const updated = updateRun(id, (r) => {
        r.facts = result.facts;
        r.contradictions = result.contradictions;
        r.research_notes = result.research_notes;
        r.script = null; // olgular tazelendi — eski senaryo geçersiz
        r.factcheck = null;
      });
      res.json({ run: updated, stats: { batches: result.batches_used, sources: result.sources_used, facts: result.facts.length, contradictions: result.contradictions.length } });
    } catch (err) {
      if (err instanceof ResearchAgentError) return sendError(res, 422, err.message, err.code);
      if (err instanceof LLMError) return sendError(res, llmStatus(err), err.message, err.code);
      throw err;
    }
  }),
);

// ---------- Olgu onay/düzenleme ----------
app.patch(
  '/api/runs/:id/facts',
  ah(async (req, res) => {
    const body = z.object({ patches: z.array(FactPatchSchema).min(1).max(200) }).parse(req.body);
    const id = parseIdParam(req.params.id);
    const run = updateRun(id, (r) => {
      for (const patch of body.patches) {
        const fact = r.facts.find((f) => f.fact_id === patch.fact_id);
        if (!fact) continue;
        if (patch.statement !== undefined) {
          fact.statement = patch.statement;
          fact.note = [fact.note, 'Metin kullanıcı tarafından düzenlendi'].filter(Boolean).join(' · ');
        }
        if (patch.status !== undefined) fact.status = patch.status;
        if (patch.confidence !== undefined) fact.confidence = patch.confidence;
        if (patch.note !== undefined) fact.note = patch.note;
      }
      r.factcheck = null; // olgu değişti — denetim sonucu bayat
    });
    res.json({ run });
  }),
);

// ---------- Senaryo (Scriptwriter) ----------
app.post(
  '/api/runs/:id/script',
  ah(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const run = getRun(id);
    const llm = getLLMProvider();
    if (!llm.isConfigured()) {
      sendError(res, 400, 'LLM sağlayıcısı yapılandırılmamış. .env dosyasına LLM_API_KEY ekleyin (veya yerel kullanım için LLM_PROVIDER=ollama).', 'llm_not_configured');
      return;
    }
    try {
      const result = await runScriptwriter(run);
      const updated = updateRun(id, (r) => {
        r.script = {
          title: result.title,
          sentences: result.sentences,
          estimated_seconds: result.estimated_seconds,
          style_notes: result.style_notes,
          generated_at: new Date().toISOString(),
        };
        r.factcheck = null;
      });
      res.json({ run: updated });
    } catch (err) {
      if (err instanceof ScriptwriterError) return sendError(res, 422, err.message, err.code);
      if (err instanceof LLMError) return sendError(res, llmStatus(err), err.message, err.code);
      throw err;
    }
  }),
);

app.patch(
  '/api/runs/:id/script',
  ah(async (req, res) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(300).optional(), sentences: z.array(SentencePatchSchema).max(400).optional() })
      .parse(req.body);
    const id = parseIdParam(req.params.id);
    const run = updateRun(id, (r) => {
      if (!r.script) throw new StorageError('not_found', 'Senaryo bulunamadı.');
      if (body.title !== undefined) r.script.title = body.title;
      if (body.sentences) {
        // Senaryo her zaman yalnızca kullanıcı onaylı olgulara bağlanabilir.
        const validFactIds = new Set(r.facts.filter((f) => f.status === 'approved').map((f) => f.fact_id));
        for (const patch of body.sentences) {
          const sentence = r.script.sentences.find((s) => s.id === patch.id);
          if (!sentence) continue;
          if (patch.text !== undefined) sentence.text = patch.text;
          if (patch.fact_ids !== undefined) {
            const unknown = patch.fact_ids.filter((fid) => !validFactIds.has(fid));
            if (unknown.length > 0) throw new StorageError('io', `Bilinmeyen fact_id: ${unknown.join(', ')}. Olgu listesinde olmayan id kullanılamaz.`);
            sentence.fact_ids = [...new Set(patch.fact_ids)];
          }
          sentence.check = 'unchecked';
          sentence.check_note = null;
        }
      }
      r.factcheck = null;
    });
    res.json({ run });
  }),
);

app.delete(
  '/api/runs/:id/script/sentences/:sentenceId',
  ah(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const run = updateRun(id, (r) => {
      if (!r.script) throw new StorageError('not_found', 'Senaryo bulunamadı.');
      const before = r.script.sentences.length;
      r.script.sentences = r.script.sentences.filter((s) => s.id !== String(req.params.sentenceId));
      if (r.script.sentences.length === before) throw new StorageError('not_found', 'Cümle bulunamadı.');
      r.factcheck = null;
    });
    res.json({ run });
  }),
);

// ---------- Denetim (Fact-checker) ----------
app.post(
  '/api/runs/:id/factcheck',
  ah(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const run = getRun(id);
    const llm = getLLMProvider();
    if (!llm.isConfigured()) {
      sendError(res, 400, 'LLM sağlayıcısı yapılandırılmamış. Denetim için de LLM gerekir.', 'llm_not_configured');
      return;
    }
    try {
      const outcome = await runFactChecker(run);
      const updated = updateRun(id, (r) => {
        if (!r.script) throw new StorageError('not_found', 'Senaryo bulunamadı.');
        r.script.sentences = outcome.sentences;
        r.factcheck = outcome.report;
      });
      if (outcome.llmError) {
        sendError(res, 502, updated.factcheck?.summary ?? outcome.llmError, 'factcheck_llm_failed');
        return;
      }
      res.json({ run: updated });
    } catch (err) {
      if (err instanceof FactCheckError) return sendError(res, 422, err.message, err.code);
      if (err instanceof LLMError) return sendError(res, llmStatus(err), err.message, err.code);
      throw err;
    }
  }),
);

// ---------- Dışa aktarma ----------
function exportResponse(res: Response, run: ResearchRun, format: 'md' | 'json') {
  const base = slugify(run.script?.title || run.topic);
  if (format === 'md') {
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${base}.md"`);
    res.send(toMarkdown(run));
  } else {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${base}.json"`);
    res.send(toJson(run));
  }
}

app.get(
  '/api/runs/:id/export.md',
  ah(async (req, res) => exportResponse(res, getRun(parseIdParam(req.params.id)), 'md')),
);
app.get(
  '/api/runs/:id/export.json',
  ah(async (req, res) => exportResponse(res, getRun(parseIdParam(req.params.id)), 'json')),
);

// ---------- Üretimde statik frontend ----------
if (IS_PROD) {
  const dist = path.join(process.cwd(), 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
}

// ---------- Hata yakalayıcı ----------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    const msg = err.issues.map((i) => `${i.path.join('.') || 'alan'}: ${i.message}`).join(' · ');
    return sendError(res, 400, `Geçersiz girdi — ${msg}`, 'validation');
  }
  if (err instanceof StorageError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'corrupt' ? 409 : 400;
    return sendError(res, status, err.message, err.code);
  }
  if (err instanceof LLMError) return sendError(res, llmStatus(err), err.message, err.code);
  if (err instanceof SearchError) return sendError(res, err.code === 'rate_limit' ? 429 : 502, err.message, err.code);
  if (err instanceof FetchError) return sendError(res, 422, err.message, err.code);
  console.error('Beklenmeyen hata:', err);
  return sendError(res, 500, `Sunucu hatası: ${err instanceof Error ? err.message : String(err)}`, 'internal');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ScriptLLM sunucusu hazır → http://0.0.0.0:${PORT} (${IS_PROD ? 'üretim' : 'geliştirme'})`);
});
