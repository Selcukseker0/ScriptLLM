import { z } from 'zod';
import type { ResearchRun, Source, Fact, Contradiction } from '../../shared/schema.js';
import { extractJson, quoteAppearsIn } from '../llm/json.js';
import { getLLMProvider } from '../llm/openaiCompatible.js';
import type { LLMProvider } from '../llm/provider.js';
import { MAX_BATCH_CHARS, MAX_BATCHES } from './fetcher.js';

export class ResearchAgentError extends Error {
  code: 'no_sources' | 'llm_failed';
  constructor(code: ResearchAgentError['code'], message: string) {
    super(message);
    this.name = 'ResearchAgentError';
    this.code = code;
  }
}

const ResearcherOutputSchema = z.object({
  facts: z
    .array(
      z.object({
        statement: z.string().trim().min(1).max(1500),
        source_id: z.string().trim().min(1).optional(),
        source_url: z.string().trim().min(1).optional(),
        quote: z.string().trim().min(1).max(1500),
        confidence: z.enum(['high', 'medium', 'low']).default('medium'),
        kind: z.enum(['fact', 'inference']).default('fact'),
      }).refine((fact) => Boolean(fact.source_id || fact.source_url), 'source_id veya source_url gerekli'),
    )
    .max(100)
    .default([]),
  contradictions: z
    .array(
      z.object({
        topic: z.string().trim().min(1).max(300),
        positions: z
          .array(
            z.object({
              statement: z.string().trim().min(1).max(1000),
              source_id: z.string().trim().min(1).optional(),
              source_url: z.string().trim().min(1).optional(),
            }).refine((position) => Boolean(position.source_id || position.source_url), 'source_id veya source_url gerekli'),
          )
          .min(2)
          .max(6),
        note: z.string().trim().max(500).nullable().default(null),
      }),
    )
    .max(20)
    .default([]),
  notes: z.string().trim().max(3000).nullable().default(null),
});

interface Batch {
  sources: Source[];
  chars: number;
}

function buildBatches(sources: Source[]): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { sources: [], chars: 0 };
  for (const source of sources) {
    const size = source.contentText.length + 200;
    if (current.sources.length > 0 && current.chars + size > MAX_BATCH_CHARS) {
      batches.push(current);
      current = { sources: [], chars: 0 };
    }
    current.sources.push(source);
    current.chars += size;
  }
  if (current.sources.length > 0) batches.push(current);
  return batches;
}

const QUOTE_STOPWORDS = new Set(['olan', 'olarak', 'daha', 'gibi', 'icin', 'için', 'hakkinda', 'hakkında', 'ile', 've', 'bir', 'bu', 'şu', 'the', 'from', 'that', 'with']);

/** Modelin alıntısı kaynakta bulunmazsa, ifadeyle yeterli sözcük/sayı örtüşmesi olan gerçek kaynak cümlesini bulur. */
export function findSupportingQuote(statement: string, sourceText: string): string | null {
  const statementTokens = [...new Set(normalizeForQuote(statement).split(/\s+/).filter((token) => (token.length >= 4 || /^\d+$/.test(token)) && !QUOTE_STOPWORDS.has(token)))];
  if (statementTokens.length === 0) return null;

  const sentences = sourceText
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 35 && part.length <= 1500);
  const candidates = [...sentences];
  for (let i = 0; i < sentences.length - 1; i++) {
    const joined = `${sentences[i]} ${sentences[i + 1]}`;
    if (joined.length <= 1500) candidates.push(joined);
  }

  let best: { quote: string; score: number } | null = null;
  for (const quote of candidates) {
    const quoteTokens = normalizeForQuote(quote).split(/\s+/);
    const matches = statementTokens.filter((token) => quoteTokens.some((candidate) => token === candidate || (Math.min(token.length, candidate.length) >= 5 && (token.startsWith(candidate) || candidate.startsWith(token)))));
    const coverage = matches.length / statementTokens.length;
    const statementNumbers = statementTokens.filter((token) => /^\d+$/.test(token));
    const numbersMatch = statementNumbers.every((number) => quoteTokens.includes(number));
    const minMatches = Math.min(3, statementTokens.length);
    if (!numbersMatch || matches.length < minMatches || coverage < 0.65) continue;
    const score = coverage + (quote.length <= 500 ? 0.05 : 0);
    if (!best || score > best.score) best = { quote, score };
  }
  return best?.quote.slice(0, 1500) ?? null;
}

function normalizeForQuote(text: string): string {
  return text
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”"'‘’«»()\[\]{}.,;:!?…–—\-/\\|*_=+`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceBlocks(batch: Batch): string {
  return batch.sources
    .map(
      (s, i) =>
        `--- KAYNAK ${i + 1} ---\nKAYNAK_ID: ${s.id}\nURL: ${s.url ?? '(yapıştırılmış metin)'}\nBAŞLIK: ${s.title}\nMETİN:\n${s.contentText}\n`,
    )
    .join('\n');
}

const SYSTEM_PROMPT = `Sen titiz bir Türkçe araştırma editörüsün. Sana yalnızca verilen kaynak metinleri gösterilecek.
KURALLAR (kesinlikle uy):
1. YALNIZCA aşağıdaki kaynaklarda geçen bilgileri kullan. Kendi genel bilgini, ezberini veya tahminini ASLA ekleme.
2. Her olgu için kaynaktan birebir veya birebire yakın kısa bir alıntı (quote) ver. Alıntı kaynak metninde aynen geçmiyorsa o olguyu yazma.
3. Kaynaklarda çelişen bilgi varsa uzlaştırma; contradictions alanına iki tarafı da kaynaklarıyla yaz.
4. Her olgu ve çelişki konumu için source_id alanına verilen KAYNAK_ID değerini AYNEN kopyala. source_url alanı gerekmez; kimlik uydurma.
5. kind: "fact" = kaynakta doğrudan yazan bilgi; "inference" = kaynaktan yapılan akıl yürütme/çıkarım (bunu açıkça belirt).
6. confidence: kaynağın otoritesi ve alıntının açıklığına göre high/medium/low.
7. Yanıtın SADECE JSON olsun; açıklama, markdown veya kod bloğu ekleme.
ŞEMA: {"facts":[{"statement":string,"source_id":string,"quote":string,"confidence":"high|medium|low","kind":"fact|inference"}],"contradictions":[{"topic":string,"positions":[{"statement":string,"source_id":string}],"note":string|null}],"notes":string|null}`;

export interface ResearcherResult {
  facts: Fact[];
  contradictions: Contradiction[];
  research_notes: string;
  batches_used: number;
  sources_used: number;
  sources_truncated: number;
}

export async function runResearcher(
  run: ResearchRun,
  provider: LLMProvider = getLLMProvider(),
  onBatch?: (current: number, total: number) => void,
): Promise<ResearcherResult> {
  const okSources = run.sources.filter((s) => s.status === 'ok' && s.contentText.trim().length > 0);
  if (okSources.length === 0) {
    throw new ResearchAgentError(
      'no_sources',
      'Araştırılacak kullanılabilir kaynak yok. Önce en az bir URL veya metin kaynağı ekleyip "Kaynakları Getir" düğmesiyle içeriğini indirin. Erişilemeyen kaynaklarla araştırma yapılmaz.',
    );
  }

  const batches = buildBatches(okSources);
  const usedBatches = batches.slice(0, MAX_BATCHES);
  const batchNotes: string[] = [];
  if (batches.length > MAX_BATCHES) {
    batchNotes.push(`Kaynak hacmi sınırı aştı: ${batches.length} parça gerekirken ilk ${MAX_BATCHES} parça işlendi; bazı kaynaklar kısmen kullanıldı.`);
  }

  const allFacts: Fact[] = [];
  const allContradictions: Contradiction[] = [];
  const modelNotes: string[] = [];
  let factSeq = 0;
  let droppedUnknownSource = 0;
  let unverifiedQuotes = 0;
  let recoveredQuotes = 0;

  for (let b = 0; b < usedBatches.length; b++) {
    onBatch?.(b + 1, usedBatches.length);
    const batch = usedBatches[b];
    const userPrompt = `KONU: ${run.topic}\nHEDEF KİTLE: ${run.audience}\n\n${sourceBlocks(batch)}\nYukarıdaki kaynaklar dışında HİÇBİR bilgiden yararlanma. JSON üret.`;
    const raw = await provider.complete({ system: SYSTEM_PROMPT, user: userPrompt, json: true, temperature: 0.2 });
    const parsed = extractJson(raw, ResearcherOutputSchema, `Araştırma (parça ${b + 1}/${usedBatches.length})`);

    const urlToSource = new Map<string, Source>();
    const idToSource = new Map(batch.sources.map((source) => [source.id, source]));
    for (const s of batch.sources) {
      if (s.url) {
        urlToSource.set(s.url, s);
        urlToSource.set(s.url.replace(/\/+$/, ''), s);
      }
      urlToSource.set(`yapıştırılmış: ${s.title}`.toLocaleLowerCase('tr'), s);
    }

    for (const f of parsed.facts ?? []) {
      const key = f.source_url?.trim() ?? '';
      const source = (f.source_id ? idToSource.get(f.source_id) : undefined) ?? (key ? urlToSource.get(key) ?? urlToSource.get(key.replace(/\/+$/, '')) ?? urlToSource.get(key.toLocaleLowerCase('tr')) : undefined);
      if (!source) {
        droppedUnknownSource++;
        continue;
      }
      let quote = f.quote;
      let quoteOk = quoteAppearsIn(quote, source.contentText);
      let quoteRecovered = false;
      if (!quoteOk) {
        const sourceExcerpt = findSupportingQuote(f.statement, source.contentText);
        if (sourceExcerpt && quoteAppearsIn(sourceExcerpt, source.contentText)) {
          quote = sourceExcerpt;
          quoteOk = true;
          quoteRecovered = true;
          recoveredQuotes++;
        }
      }
      if (!quoteOk) unverifiedQuotes++;
      factSeq += 1;
      allFacts.push({
        fact_id: `F${String(factSeq).padStart(3, '0')}`,
        statement: f.statement,
        source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        quote,
        confidence: !quoteOk ? 'low' : quoteRecovered ? 'medium' : (f.confidence ?? 'medium'),
        kind: !quoteOk ? 'unverified' : f.kind === 'inference' ? 'inference' : 'fact',
        quote_verified: quoteOk,
        status: 'pending',
        note: quoteRecovered ? 'Modelin alıntısı kaynakta bulunamadı; ifadeyle yüksek sözcük/sayı örtüşmesi olan gerçek kaynak cümlesi alıntı olarak kullanıldı.' : null,
      });
    }

    for (const c of parsed.contradictions ?? []) {
      const positions = c.positions
        .map((p) => {
          const key = p.source_url?.trim() ?? '';
          const source = (p.source_id ? idToSource.get(p.source_id) : undefined) ?? (key ? urlToSource.get(key) ?? urlToSource.get(key.replace(/\/+$/, '')) ?? urlToSource.get(key.toLocaleLowerCase('tr')) : undefined);
          if (!source) return null;
          return { statement: p.statement, fact_id: null as string | null, source_url: source.url, source_title: source.title };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      if (positions.length >= 2) {
        allContradictions.push({ id: `C${String(allContradictions.length + 1).padStart(2, '0')}`, topic: c.topic, positions, note: c.note ?? null });
      }
    }
    if (parsed.notes) modelNotes.push(parsed.notes);
  }

  if (droppedUnknownSource > 0) batchNotes.push(`${droppedUnknownSource} olgu, bilinmeyen/eşleşmeyen kaynak referansı verdiği için elendi.`);
  if (recoveredQuotes > 0) batchNotes.push(`${recoveredQuotes} olgu için model alıntısı bulunamadı; ifade ile yüksek sözcük/sayı örtüşmesi bulunan gerçek kaynak cümlesi alıntı olarak eşleştirildi ve güven orta ile sınırlandı.`);
  if (unverifiedQuotes > 0) batchNotes.push(`${unverifiedQuotes} olgunun alıntısı ve destekleyici kaynak cümlesi doğrulanamadı; bu olgular "doğrulanamadı" (unverified) ve düşük güven olarak işaretlendi.`);
  for (const t of okSources) {
    if (t.contentTruncated) batchNotes.push(`"${t.title}" kaynak metni uzunluğu nedeniyle kısaltılmış olarak kullanıldı.`);
  }

  const research_notes = [
    modelNotes.length ? `Model notları: ${modelNotes.join(' | ')}` : null,
    ...batchNotes,
    `Toplam ${allFacts.length} olgu, ${allContradictions.length} çelişki kaydedildi (${usedBatches.length} parça, ${okSources.length} kaynak).`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    facts: allFacts,
    contradictions: allContradictions,
    research_notes,
    batches_used: usedBatches.length,
    sources_used: okSources.length,
    sources_truncated: okSources.filter((s) => s.contentTruncated).length,
  };
}
