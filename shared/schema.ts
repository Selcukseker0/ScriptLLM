import { z } from 'zod';

/**
 * ScriptLLM — kararlı, makinece okunabilir veri şeması.
 * Araştırma → olgu listesi → senaryo → denetim akışının tamamı
 * bu şemalarla saklanır ve aşamalar arasında aktarılır.
 */

export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const FACT_STATUS = ['pending', 'approved', 'rejected'] as const;
export type FactStatus = (typeof FACT_STATUS)[number];

export const FACT_KIND = ['fact', 'inference', 'unverified'] as const;
export type FactKind = (typeof FACT_KIND)[number];

export const SOURCE_KIND = ['url', 'text'] as const;
export type SourceKind = (typeof SOURCE_KIND)[number];

export const SOURCE_STATUS = ['pending', 'ok', 'failed'] as const;
export type SourceStatus = (typeof SOURCE_STATUS)[number];

/** Bir kaynağın getirilip saklanmış hâli */
export const SourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(SOURCE_KIND),
  url: z.string().url().nullable(),
  title: z.string().min(1),
  status: z.enum(SOURCE_STATUS),
  error: z.string().nullable(),
  /** Kaynaktan çıkarılan düz metin (kesilmiş olabilir) */
  contentText: z.string(),
  contentTruncated: z.boolean(),
  fetchedAt: z.string().nullable(),
  addedNote: z.string().nullable(),
});
export type Source = z.infer<typeof SourceSchema>;

/** Kaynaklı tek bir olgu */
export const FactSchema = z.object({
  fact_id: z.string().regex(/^F\d{3,}$/),
  statement: z.string().min(1),
  source_id: z.string().min(1),
  source_url: z.string().nullable(),
  source_title: z.string().min(1),
  /** Kaynaktan destekleyici alıntı */
  quote: z.string().min(1),
  confidence: z.enum(CONFIDENCE),
  /** fact = kaynaktan doğrudan çıkarım, inference = model çıkarımı, unverified = dayanak zayıf */
  kind: z.enum(FACT_KIND),
  /** Alıntı kaynak metninde doğrulandı mı? */
  quote_verified: z.boolean(),
  status: z.enum(FACT_STATUS),
  note: z.string().nullable(),
});
export type Fact = z.infer<typeof FactSchema>;

/** Kaynaklar arası çelişki — asla sessizce çözümlenmez */
export const ContradictionSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  positions: z
    .array(
      z.object({
        statement: z.string().min(1),
        fact_id: z.string().nullable(),
        source_url: z.string().nullable(),
        source_title: z.string().min(1),
      }),
    )
    .min(2),
  note: z.string().nullable(),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

export const SENTENCE_CHECK = ['unchecked', 'supported', 'unsupported', 'contradicted', 'uncertain'] as const;
export type SentenceCheck = (typeof SENTENCE_CHECK)[number];

/** Senaryonun tek cümlesi — dayandığı fact_id'lerle bağlı */
export const ScriptSentenceSchema = z.object({
  id: z.string().regex(/^S\d{3,}$/),
  text: z.string().min(1),
  fact_ids: z.array(z.string()),
  check: z.enum(SENTENCE_CHECK).default('unchecked'),
  check_note: z.string().nullable().default(null),
});
export type ScriptSentence = z.infer<typeof ScriptSentenceSchema>;

export const ScriptSchema = z.object({
  title: z.string().min(1),
  sentences: z.array(ScriptSentenceSchema),
  estimated_seconds: z.number().int().nonnegative().nullable(),
  style_notes: z.string().nullable(),
  generated_at: z.string().nullable(),
});
export type Script = z.infer<typeof ScriptSchema>;

export const FactCheckReportSchema = z.object({
  ran_at: z.string(),
  ok: z.boolean(),
  supported: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  contradicted: z.number().int().nonnegative(),
  uncertain: z.number().int().nonnegative(),
  unchecked: z.number().int().nonnegative(),
  summary: z.string(),
});
export type FactCheckReport = z.infer<typeof FactCheckReportSchema>;

export const RUN_STAGE = ['sources', 'facts', 'script', 'factcheck', 'export'] as const;
export type RunStage = (typeof RUN_STAGE)[number];

/** Bir araştırma çalışmasının tamamı — data/runs/<id>.json olarak saklanır */
export const ResearchRunSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  topic: z.string().min(1),
  audience: z.string().min(1),
  tone: z.string().min(1),
  target_seconds: z.number().int().positive().max(60 * 120),
  language: z.literal('tr'),
  sources: z.array(SourceSchema),
  facts: z.array(FactSchema),
  contradictions: z.array(ContradictionSchema),
  research_notes: z.string().nullable(),
  script: ScriptSchema.nullable(),
  factcheck: FactCheckReportSchema.nullable(),
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

/** Yeni çalışma oluşturma isteği */
export const CreateRunRequestSchema = z.object({
  topic: z.string().trim().min(3, 'Konu en az 3 karakter olmalı').max(300),
  audience: z.string().trim().min(1).max(200).default('Genel izleyici'),
  tone: z.string().trim().min(1).max(120).default('Bilgilendirici'),
  target_seconds: z.coerce.number().int().min(30).max(60 * 60).default(600),
  urls: z.array(z.string().trim().url('Geçerli bir URL girin')).max(12).default([]),
  pasted_sources: z
    .array(z.object({ title: z.string().trim().min(1).max(300), text: z.string().min(50, 'Kaynak metni en az 50 karakter olmalı').max(60000) }))
    .max(8)
    .default([]),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/** Olgu düzenleme/onaylama isteği */
export const FactPatchSchema = z.object({
  fact_id: z.string().min(1),
  statement: z.string().trim().min(1).max(2000).optional(),
  status: z.enum(FACT_STATUS).optional(),
  confidence: z.enum(CONFIDENCE).optional(),
  note: z.string().max(2000).nullable().optional(),
});
export type FactPatch = z.infer<typeof FactPatchSchema>;

/** Senaryo cümlesi düzenleme isteği */
export const SentencePatchSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(4000).optional(),
  fact_ids: z.array(z.string()).max(20).optional(),
});
export type SentencePatch = z.infer<typeof SentencePatchSchema>;

export type ApiError = { error: string; detail?: string; code?: string };
