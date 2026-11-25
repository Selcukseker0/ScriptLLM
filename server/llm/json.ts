import { z } from 'zod';
import { LLMError } from '../llm/provider.js';

/**
 * Model çıktısından JSON ayıklar. Fence'li bloğu, baştaki/sondaki metni veya
 * gömülü nesneyi tolere eder; hiçbiri olmazsa veya şema uyuşmazsa LLMError('bad_json') atar.
 */
export function extractJson<T>(raw: string, schema: z.ZodType<T>, context: string): T {
  const candidates: string[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(raw.trim());
  const firstObj = raw.indexOf('{');
  const lastObj = raw.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(raw.slice(firstObj, lastObj + 1));
  const firstArr = raw.indexOf('[');
  const lastArr = raw.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) candidates.push(raw.slice(firstArr, lastArr + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // sıradaki adayı dene
    }
  }
  throw new LLMError(
    'bad_json',
    `${context}: Model geçerli JSON üretmedi veya beklenen şemaya uymadı. İçerik uydurulmadı; lütfen tekrar deneyin.`,
    {},
  );
}

/** Metin normalizasyonu — alıntı doğrulaması için */
export function normalizeForMatch(text: string): string {
  return text
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

    .replace(/[“”"'‘’«»()\[\]{}.,;:!?…–—\-/\\|*_=+`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** quote metninin sourceText içinde geçip geçmediğini bulanık eşlemeyle denetler */
export function quoteAppearsIn(quote: string, sourceText: string): boolean {
  const q = normalizeForMatch(quote);
  const s = normalizeForMatch(sourceText);
  if (!q || !s) return false;
  if (s.includes(q)) return true;
  // Alıntının büyük bölümünün (ardışık 60 karakterlik parça) metinde geçmesi yeterli
  const probeLen = Math.min(60, Math.floor(q.length / 2));
  if (probeLen >= 20) {
    const mid = q.slice(Math.floor((q.length - probeLen) / 2), Math.floor((q.length - probeLen) / 2) + probeLen);
    if (s.includes(mid)) return true;
  }
  // Kelime düzeyi kapsama: alıntıdaki anlamlı sözcüklerin (≥4 harf) en az %80'i kaynakta geçmeli.
  // Türkçe çekim ekleri nedeniyle birebir alt-dize eşleşmesi başarısız olabilir; uydurma alıntılar yine elenir.
  const tokens = q.split(' ').filter((t) => t.length >= 4);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => s.includes(t)).length;
  return hits / tokens.length >= 0.8;
}
