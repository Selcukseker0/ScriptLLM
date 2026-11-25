import { z } from 'zod';
import type { ResearchRun, ScriptSentence, FactCheckReport } from '../../shared/schema.js';
import { extractJson, normalizeForMatch } from '../llm/json.js';
import { getLLMProvider } from '../llm/openaiCompatible.js';
import type { LLMProvider } from '../llm/provider.js';

export class FactCheckError extends Error {
  code: 'no_script' | 'llm_failed';
  constructor(code: FactCheckError['code'], message: string) {
    super(message);
    this.name = 'FactCheckError';
    this.code = code;
  }
}

const CheckOutputSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        verdict: z.enum(['supported', 'unsupported', 'contradicted', 'uncertain']),
        note: z.string().trim().max(500).nullable().default(null),
      }),
    )
    .max(400),
});

const SYSTEM_PROMPT = `Sen titiz bir Türkçe doğrulama editörüsün. Sana SENARYO cümleleri ve her cümlenin dayandığı OLGU'lar (id, ifade, kaynak alıntısı) verilecek.
Her cümle için SADECE verilen olgulara dayanarak değerlendirme yap:
- supported: olgular cümleyi açıkça destekliyor.
- unsupported: olgular cümleyi desteklemiyor veya cümle dayanakta olmayan bilgi içeriyor (uydurma sayı/tarih/isim dahil).
- contradicted: cümle, dayandığı olgularla veya olguların kaynağıyla ÇELİŞİYOR.
- uncertain: kısmen destekliyor ama belirsiz/eksik/çıkarım gerekiyor.
Geçiş ya da bağlayıcı ifadeler (ör. "başlayalım", "gelelim konuya") için verdict: "supported" değil, "uncertain" kullan ve note: "bağlayıcı ifade" yaz.
Yanıt SADECE JSON: {"results":[{"id":string,"verdict":"supported|unsupported|contradicted|uncertain","note":string|null}]}`;

/** Metindeki sayıları (rakam grupları) çıkarır — dayanak olmadan uydurma sayı avı */
export function extractNumbers(text: string): string[] {
  const matches = text.match(/\d[\d.,]{0,12}\d|\d/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/[.,]/g, '')))].filter((m) => m.length >= 2);
}

function normalDigits(text: string): string {
  return normalizeForMatch(text).replace(/[.,]/g, '');
}

export interface FactCheckOutcome {
  sentences: ScriptSentence[];
  report: FactCheckReport;
  /** LLM anlamsal denetim başarısız olduysa mesaj; deterministik kontroller yine de yapıldı */
  llmError: string | null;
}

/**
 * Senaryodaki her cümleyi fact_id dayanaklarıyla karşılaştırır.
 * 1) Deterministik geçiş: eksik/reddedilmiş dayanaklar, uydurma sayılar.
 * 2) Tek LLM çağrısı: cümle başına anlamsal hüküm.
 * LLM başarısız olursa deterministik sonuçlar saklanır, rapor ok=false ile işaretlenir ve hata fırlatılır.
 */
export async function runFactChecker(run: ResearchRun, provider: LLMProvider = getLLMProvider()): Promise<FactCheckOutcome> {
  if (!run.script || run.script.sentences.length === 0) {
    throw new FactCheckError('no_script', 'Denetlenecek senaryo yok. Önce Senaryo adımından bir taslak üretin.');
  }

  const factById = new Map(run.facts.map((f) => [f.fact_id, f]));
  const deterministic = new Map<string, { verdict: ScriptSentence['check']; note: string | null }>();

  for (const sentence of run.script.sentences) {
    const cited = sentence.fact_ids.map((id) => factById.get(id));
    const missing = sentence.fact_ids.filter((id) => !factById.has(id));
    if (missing.length > 0) {
      deterministic.set(sentence.id, { verdict: 'unsupported', note: `Dayanak bulunamadı: ${missing.join(', ')} (senaryodaki olgu listesinden silinmiş olabilir).` });
      continue;
    }
    if (sentence.fact_ids.length === 0) {
      deterministic.set(sentence.id, { verdict: 'unsupported', note: 'Cümlede dayanak (fact_id) belirtilmemiş.' });
      continue;
    }
    const notApproved = cited.filter((f) => f && f.status !== 'approved');
    if (notApproved.length > 0) {
      deterministic.set(sentence.id, { verdict: 'unsupported', note: `Onaylanmamış olguya dayanıyor: ${notApproved.map((f) => `${f!.fact_id} (${f!.status === 'rejected' ? 'reddedildi' : 'beklemede'})`).join(', ')}.` });
      continue;
    }
    // Sayı kontrolü: cümledeki sayılar dayanak metinlerinde geçiyor mu?
    const numbers = extractNumbers(sentence.text);
    if (numbers.length > 0) {
      const support = cited.map((f) => normalDigits(`${f!.statement} ${f!.quote}`)).join(' ');
      const missingNumbers = numbers.filter((n) => !support.includes(n));
      if (missingNumbers.length > 0) {
        deterministic.set(sentence.id, {
          verdict: 'uncertain',
          note: `Cümledeki sayı(lar) dayanak metinlerinde bulunamadı: ${missingNumbers.join(', ')}. Kaynakla karşılaştırın.`,
        });
        continue;
      }
    }
    deterministic.set(sentence.id, { verdict: 'unchecked', note: null });
  }

  // LLM ile anlamsal denetim — TEK toplu çağrı (cümle sayısı kaç olursa olsun)
  const referencedIds = new Set(run.script.sentences.flatMap((s) => s.fact_ids));
  const factDigest = [...referencedIds]
    .map((id) => factById.get(id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f) => `${f.fact_id} (${f.source_title}): ${f.statement}\n    ALI: "${f.quote.slice(0, 400)}"`)
    .join('\n');

  const sentenceDigest = run.script.sentences
    .map((s) => `${s.id} [${s.fact_ids.join(',') || 'dayanak yok'}]: ${s.text}`)
    .join('\n');

  const userPrompt = `OLGULAR:\n${factDigest || '(hiç dayanak verilememiş)'}\n\nSENARYO CÜMLELERİ:\n${sentenceDigest}\n\nJSON üret.`;

  let llmResults: Map<string, { verdict: 'supported' | 'unsupported' | 'contradicted' | 'uncertain'; note: string | null }> | null = null;
  let llmError: string | null = null;
  try {
    const raw = await provider.complete({ system: SYSTEM_PROMPT, user: userPrompt, json: true, temperature: 0 });
    const parsed = extractJson(raw, CheckOutputSchema, 'Denetim');
    llmResults = new Map(parsed.results.map((r) => [r.id, { verdict: r.verdict, note: r.note ?? null }]));
  } catch (err) {
    llmError = err instanceof Error ? err.message : String(err);
  }

  const sentences: ScriptSentence[] = run.script.sentences.map((s) => {
    const det = deterministic.get(s.id)!;
    if (det.verdict !== 'unchecked') {
      return { ...s, check: det.verdict, check_note: det.note };
    }
    if (!llmResults) {
      return { ...s, check: 'unchecked' as const, check_note: 'Denetim modeli çalıştırılamadı; bu cümle otomatik doğrulanamadı.' };
    }
    const llm = llmResults.get(s.id);
    if (!llm) {
      return { ...s, check: 'uncertain' as const, check_note: 'Denetim modeli bu cümleyi değerlendirmedi.' };
    }
    return { ...s, check: llm.verdict, check_note: llm.note };
  });

  const counts = {
    supported: sentences.filter((s) => s.check === 'supported').length,
    unsupported: sentences.filter((s) => s.check === 'unsupported').length,
    contradicted: sentences.filter((s) => s.check === 'contradicted').length,
    uncertain: sentences.filter((s) => s.check === 'uncertain').length,
    unchecked: sentences.filter((s) => s.check === 'unchecked').length,
  };

  const ok = !llmError && counts.unsupported === 0 && counts.contradicted === 0 && counts.uncertain === 0 && counts.unchecked === 0;
  const report: FactCheckReport = {
    ran_at: new Date().toISOString(),
    ok,
    ...counts,
    summary: llmError
      ? `Denetim modeli hatası: ${llmError} Deterministik kontroller yapıldı ancak anlamsal doğrulama tamamlanamadı. Sonuç "hazır" sayılamaz.`
      : ok
        ? `Denetim temiz: her cümlenin dayanağı doğrulandı (${counts.supported}/${sentences.length} desteklendi${counts.uncertain ? `, ${counts.uncertain} belirsiz` : ''}).`
        : `Denetim uyarılar buldu: ${counts.unsupported} desteksiz, ${counts.contradicted} çelişkili, ${counts.uncertain} belirsiz cümle. Bunları düzeltip tekrar denetleyin; senaryo bu hâliyle "hazır" değildir.`,
  };

  return { sentences, report, llmError };
}
