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
        source_url: z.string().trim().min(1),
        quote: z.string().trim().min(1).max(1500),
        confidence: z.enum(['high', 'medium', 'low']).default('medium'),
        kind: z.enum(['fact', 'inference']).default('fact'),
      }),
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
              source_url: z.string().trim().min(1),
            }),
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
4. source_url alanına olgunun geldiği kaynağın URL'sini (yapıştırılmış metin için "yapıştırılmış: BAŞLIK" biçiminde başlığı) aynen yaz.
5. kind: "fact" = kaynakta doğrudan yazan bilgi; "inference" = kaynaktan yapılan akıl yürütme/çıkarım (bunu açıkça belirt).
6. confidence: kaynağın otoritesi ve alıntının açıklığına göre high/medium/low.
7. Yanıtın SADECE JSON olsun; açıklama, markdown veya kod bloğu ekleme.
ŞEMA: {"facts":[{"statement":string,"source_url":string,"quote":string,"confidence":"high|medium|low","kind":"fact|inference"}],"contradictions":[{"topic":string,"positions":[{"statement":string,"source_url":string}],"note":string|null}],"notes":string|null}`;

export interface ResearcherResult {
  facts: Fact[];
  contradictions: Contradiction[];
  research_notes: string;
  batches_used: number;
  sources_used: number;
  sources_truncated: number;
}

export async function runResearcher(run: ResearchRun, provider: LLMProvider = getLLMProvider()): Promise<ResearcherResult> {
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

  for (let b = 0; b < usedBatches.length; b++) {
    const batch = usedBatches[b];
    const userPrompt = `KONU: ${run.topic}\nHEDEF KİTLE: ${run.audience}\n\n${sourceBlocks(batch)}\nYukarıdaki kaynaklar dışında HİÇBİR bilgiden yararlanma. JSON üret.`;
    const raw = await provider.complete({ system: SYSTEM_PROMPT, user: userPrompt, json: true, temperature: 0.2 });
    const parsed = extractJson(raw, ResearcherOutputSchema, `Araştırma (parça ${b + 1}/${usedBatches.length})`);

    const urlToSource = new Map<string, Source>();
    for (const s of batch.sources) {
      if (s.url) {
        urlToSource.set(s.url, s);
        urlToSource.set(s.url.replace(/\/+$/, ''), s);
      }
      urlToSource.set(`yapıştırılmış: ${s.title}`.toLocaleLowerCase('tr'), s);
    }

    for (const f of parsed.facts ?? []) {
      const key = f.source_url.trim();
      const source = urlToSource.get(key) ?? urlToSource.get(key.replace(/\/+$/, '')) ?? urlToSource.get(key.toLocaleLowerCase('tr'));
      if (!source) {
        droppedUnknownSource++;
        continue;
      }
      const quoteOk = quoteAppearsIn(f.quote, source.contentText);
      if (!quoteOk) unverifiedQuotes++;
      factSeq += 1;
      allFacts.push({
        fact_id: `F${String(factSeq).padStart(3, '0')}`,
        statement: f.statement,
        source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        quote: f.quote,
        confidence: quoteOk ? (f.confidence ?? 'medium') : 'low',
        kind: !quoteOk ? 'unverified' : f.kind === 'inference' ? 'inference' : 'fact',
        quote_verified: quoteOk,
        status: 'pending',
        note: null,
      });
    }

    for (const c of parsed.contradictions ?? []) {
      const positions = c.positions
        .map((p) => {
          const key = p.source_url.trim();
          const source = urlToSource.get(key) ?? urlToSource.get(key.replace(/\/+$/, '')) ?? urlToSource.get(key.toLocaleLowerCase('tr'));
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
  if (unverifiedQuotes > 0) batchNotes.push(`${unverifiedQuotes} olgunun alıntısı kaynak metninde birebir bulunamadı; bu olgular "doğrulanamadı" (unverified) ve düşük güven olarak işaretlendi.`);
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
