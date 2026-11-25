import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDataDir, RUNS_DIR } from './config.js';
import { ResearchRunSchema, type ResearchRun } from '../shared/schema.js';

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

export class StorageError extends Error {
  code: 'not_found' | 'corrupt' | 'io';
  constructor(code: StorageError['code'], message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function runPath(id: string): string {
  // id'yi path traversal'a karşı sıkı doğrula
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
    throw new StorageError('not_found', 'Geçersiz çalışma kimliği.');
  }
  return path.join(RUNS_DIR, `${id}.json`);
}

export function newRunId(): string {
  return randomUUID();
}

export function saveRun(run: ResearchRun): ResearchRun {
  ensureDataDir();
  const stamped = { ...run, updated_at: new Date().toISOString() };
  const parsed = ResearchRunSchema.safeParse(stamped);
  if (!parsed.success) {
    throw new StorageError('io', `Çalışma şeması doğrulanamadı: ${parsed.error.issues[0]?.message}`);
  }
  const file = runPath(run.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed.data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return parsed.data;
}

export function getRun(id: string): ResearchRun {
  const file = runPath(id);
  if (!fs.existsSync(file)) throw new StorageError('not_found', 'Çalışma bulunamadı.');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new StorageError('io', `Çalışma dosyası okunamadı: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const data = JSON.parse(raw);
    const parsed = ResearchRunSchema.safeParse(data);
    if (!parsed.success) {
      throw new StorageError('corrupt', `Çalışma dosyası bozuk veya şema dışı: ${parsed.error.issues[0]?.message}. Dosya: ${path.basename(file)}`);
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError('corrupt', `Çalışma dosyası JSON olarak ayrıştırılamadı: ${path.basename(file)}`);
  }
}

export function deleteRun(id: string): void {
  const file = runPath(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function listRuns(): RunSummary[] {
  ensureDataDir();
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
  const summaries: RunSummary[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, file), 'utf8'));
      const parsed = ResearchRunSchema.safeParse(data);
      if (!parsed.success) continue; // bozuk dosyayı listede gösterme ama silme de
      const r = parsed.data;
      summaries.push({
        id: r.id,
        topic: r.topic,
        created_at: r.created_at,
        updated_at: r.updated_at,
        source_count: r.sources.length,
        ok_source_count: r.sources.filter((s) => s.status === 'ok').length,
        fact_count: r.facts.length,
        approved_fact_count: r.facts.filter((f) => f.status === 'approved').length,
        has_script: Boolean(r.script && r.script.sentences.length > 0),
        factcheck_ok: r.factcheck ? r.factcheck.ok : null,
      });
    } catch {
      // bozuk dosya — atla
    }
  }
  return summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
