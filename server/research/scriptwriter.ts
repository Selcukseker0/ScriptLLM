import { z } from 'zod';
import type { ResearchRun, ScriptSentence } from '../../shared/schema.js';
import { extractJson } from '../llm/json.js';
import { getLLMProvider } from '../llm/openaiCompatible.js';
import type { LLMProvider } from '../llm/provider.js';

export class ScriptwriterError extends Error {
  code: 'no_approved_facts' | 'llm_failed';
  constructor(code: ScriptwriterError['code'], message: string) {
    super(message);
    this.name = 'ScriptwriterError';
    this.code = code;
  }
}

const ScriptOutputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  style_notes: z.string().trim().max(2000).nullable().default(null),
  sentences: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(4000),
        fact_ids: z.array(z.string().trim()).max(20).default([]),
      }),
    )
    .min(1)
    .max(400),
});

/** Türkçe doğal konuşma hızı ~150 kelime/dakika ≈ 2.5 kelime/saniye */
export const WORDS_PER_SECOND = 2.5;

export function estimateWords(targetSeconds: number): number {
  return Math.round(targetSeconds * WORDS_PER_SECOND);
}

const SYSTEM_PROMPT = `Sen Türkçe bir YouTube videosu senaryo yazarısın. Yalnızca sana verilen OLGULAR listesini kullanarak seslendirme metni yazacaksın.
KURALLAR (kesinlikle uy):
1. Her cümle SADECE verilen olgulara dayanır; olgularda olmayan bilgi, sayı, tarih, isim ekleme.
2. Her cümlenin fact_ids alanına dayandığı olguların kimliklerini yaz (ör. ["F003","F007"]). Dayanağı olmayan geçiş cümlesi YAZMA — gerekiyorsa o cümleye de en yakın olguyu bağla.
3. Doğal, akıcı, anlaşılır Türkçe yaz; tekrar, dolgu söz ("ee", "hani"), uydurma sayı ve kesinlik bildiren asılsız ifadeler kullanma.
4. Hedef kitle ve tona uy. Hedef süreye kabaca uy.
5. Kaynaklar arasında çelişki varsa kesin hüküm verme; "kaynaklar bu konuda ayrılıyor" gibi açık bir ifade kullan.
6. Yanıt SADECE JSON olsun. ŞEMA: {"title":string,"style_notes":string|null,"sentences":[{"text":string,"fact_ids":[string]}]}`;

export interface ScriptwriterResult {
  title: string;
  sentences: ScriptSentence[];
  estimated_seconds: number;
  style_notes: string | null;
  dropped_fact_refs: number;
}

export async function runScriptwriter(run: ResearchRun, provider: LLMProvider = getLLMProvider()): Promise<ScriptwriterResult> {
  const approved = run.facts.filter((f) => f.status === 'approved');
  if (approved.length === 0) {
    throw new ScriptwriterError(
      'no_approved_facts',
      'Senaryo üretmek için en az 1 onaylı olgu gerekiyor. Olgu Listesi adımında olguları inceleyip onaylayın.',
    );
  }

  const approvedIds = new Set(approved.map((f) => f.fact_id));
  const targetWords = estimateWords(run.target_seconds);
  const minutes = Math.round(run.target_seconds / 60);

  const factList = approved
    .map((f) => `${f.fact_id} [güven: ${f.confidence}] ${f.statement}\n    (kaynak: ${f.source_title}${f.source_url ? ` — ${f.source_url}` : ''}; alıntı: "${f.quote.slice(0, 300)}")`)
    .join('\n');

  const contradictionNote = run.contradictions.length
    ? `\nÇELİŞKİLİ KONULAR (kesin hüküm verme, ikisini de belirt):\n${run.contradictions.map((c) => `- ${c.topic}: ${c.positions.map((p) => p.statement).join(' // ')}`).join('\n')}`
    : '';

  const userPrompt = `KONU: ${run.topic}
HEDEF KİTLE: ${run.audience}
TON: ${run.tone}
HEDEF SÜRE: ~${minutes} dakika (~${targetWords} kelime)

OLGULAR (yalnızca bunları kullan):
${factList}
${contradictionNote}

JSON üret.`;

  const raw = await provider.complete({ system: SYSTEM_PROMPT, user: userPrompt, json: true, temperature: 0.4, timeoutMs: 180_000 });
  const parsed = extractJson(raw, ScriptOutputSchema, 'Senaryo yazımı');

  let droppedFactRefs = 0;
  const sentences: ScriptSentence[] = parsed.sentences.map((s, i) => {
    const validIds = [...new Set(s.fact_ids)].filter((id) => {
      if (approvedIds.has(id)) return true;
      droppedFactRefs++;
      return false;
    });
    return {
      id: `S${String(i + 1).padStart(3, '0')}`,
      text: s.text,
      fact_ids: validIds,
      check: 'unchecked' as const,
      check_note: null,
    };
  });

  const wordCount = sentences.reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0);
  const estimated_seconds = Math.round(wordCount / WORDS_PER_SECOND);
  const notes = [
    parsed.style_notes,
    droppedFactRefs > 0 ? `Model, olgu listesinde olmayan ${droppedFactRefs} fact_id referansı verdiği için bunlar senaryodan çıkarıldı.` : null,
    `~${wordCount} kelime ≈ ${Math.floor(estimated_seconds / 60)} dk ${estimated_seconds % 60} sn tahmini süre.`,
  ]
    .filter(Boolean)
    .join(' ');

  return { title: parsed.title, sentences, estimated_seconds, style_notes: notes || null, dropped_fact_refs: droppedFactRefs };
}
