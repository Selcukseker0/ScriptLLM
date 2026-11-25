import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { DATA_DIR } from '../server/config.js';
import { getLLMProvider } from '../server/llm/openaiCompatible.js';
import { getSearchProvider, searchTopic } from '../server/search/providers.js';
import { fetchSource, FetchError } from '../server/research/fetcher.js';
import { runResearcher } from '../server/research/researcher.js';
import { runScriptwriter } from '../server/research/scriptwriter.js';
import { runFactChecker } from '../server/research/factchecker.js';
import { assessSourceRelevance } from '../server/research/relevance.js';
import { getRun, newRunId, saveRun } from '../server/storage.js';
import { toMarkdown } from '../server/export.js';
import type { ResearchRun, Source } from '../shared/schema.js';

function slugify(text: string): string {
  const transliteration: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
  return text.split('').map((c) => transliteration[c] ?? c).join('').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 70) || 'senaryo';
}

function printScenario(run: ResearchRun): void {
  const script = run.script;
  if (!script) return;
  console.log(`\n# ${script.title}\n`);
  console.log(`KONU: ${run.topic}`);
  console.log(`TAHMİNİ SÜRE: ${script.estimated_seconds ? `${Math.floor(script.estimated_seconds / 60)} dk ${script.estimated_seconds % 60} sn` : '—'}`);
  console.log(`DENETİM: ${run.factcheck?.ok ? 'BAŞARILI' : 'UYARI — TASLAK HAZIR DEĞİL'}`);
  console.log('\n--- SENARYO ---\n');
  for (const sentence of script.sentences) {
    const refs = sentence.fact_ids.length ? sentence.fact_ids.join(', ') : 'DAYANAK YOK';
    console.log(`ANLATICI: ${sentence.text}  [${refs}]`);
    if (sentence.check !== 'supported') {
      console.log(`  ⚠ ${sentence.check.toLocaleUpperCase('tr')}${sentence.check_note ? ` — ${sentence.check_note}` : ''}`);
    }
    console.log('');
  }
  console.log('--- KULLANILAN KAYNAKLAR ---');
  const used = new Set(script.sentences.flatMap((sentence) => sentence.fact_ids));
  for (const fact of run.facts.filter((item) => used.has(item.fact_id))) {
    console.log(`[${fact.fact_id}] ${fact.source_title}${fact.source_url ? ` — ${fact.source_url}` : ''}`);
    console.log(`  Dayanak: “${fact.quote}”`);
  }
  if (run.contradictions.length) {
    console.log('\n--- KAYNAKLAR ARASI ÇELİŞKİLER ---');
    for (const contradiction of run.contradictions) {
      console.log(`⚠ ${contradiction.topic}`);
      for (const position of contradiction.positions) console.log(`  - ${position.statement} — ${position.source_title}${position.source_url ? ` (${position.source_url})` : ''}`);
    }
  }
  if (run.factcheck && !run.factcheck.ok) console.log(`\nDENETİM NOTU: ${run.factcheck.summary}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resumeId = args[0] === '--resume' ? args[1] : null;
  if (args[0] === '--resume' && !resumeId) throw new Error('Kullanım: npm run generate -- --resume <çalışma-id>');
  const topicArgs = resumeId ? args.slice(2) : args;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let topic = topicArgs.join(' ').trim();
  if (!resumeId && !topic) topic = (await rl.question('Senaryo konusu: ')).trim();
  rl.close();
  if (!resumeId && topic.length < 3) throw new Error('Konu en az 3 karakter olmalı.');

  const llm = getLLMProvider();
  if (!llm.isConfigured()) throw new Error('LLM ayarlı değil. .env içine LLM_API_KEY ekleyin veya LLM_PROVIDER=ollama yapılandırın.');

  const now = new Date().toISOString();
  let run: ResearchRun;
  if (resumeId) {
    run = getRun(resumeId);
    topic = run.topic;
    run.facts = [];
    run.contradictions = [];
    run.research_notes = null;
    run.script = null;
    run.factcheck = null;
  } else {
    run = {
      schema_version: 1,
      id: newRunId(),
      created_at: now,
      updated_at: now,
      topic,
      audience: 'Genel izleyici',
      tone: 'Bilgilendirici',
      target_seconds: 600,
      language: 'tr',
      sources: [],
      facts: [],
      contradictions: [],
      research_notes: null,
      script: null,
      factcheck: null,
    };
  }
  saveRun(run);
  const progress = (message: string) => stderr.write(`${message}\n`);

  try {
    progress(resumeId ? `1/5 Mevcut kaynaklar yeniden işleniyor: ${topic}` : `1/5 Kaynak aranıyor: ${topic}`);
    const search = getSearchProvider();
    const hasUsableSource = run.sources.some((source) => source.status === 'ok' && source.contentText.trim());
    if (!hasUsableSource) {
      if (!search.isConfigured()) throw new Error(`Arama sağlayıcısı kapalı (${search.describe().detail}). .env ile sağlayıcı seçin.`);
      progress(`Arama sağlayıcısı: ${search.describe().detail}`);
      const { results, queries } = await searchTopic(search, topic, 8);
      if (results.length === 0) throw new Error(`${search.name} hiçbir sorgu varyantında kaynak döndürmedi: ${queries.map((query) => `“${query}”`).join(', ')}. Bu genellikle Wikipedia'nın konu başlığı bulamaması veya ağ erişimiyle ilgilidir; daha geniş arama için Tavily/Brave anahtarı ekleyin.`);

      const seen = new Set(run.sources.map((source) => source.url).filter((url): url is string => Boolean(url)));
      for (const result of results) {
        if (seen.has(result.url) || run.sources.length >= 12) continue;
        seen.add(result.url);
        const source: Source = {
          id: newRunId().slice(0, 13), kind: 'url', url: result.url, title: result.title.slice(0, 300),
          status: 'pending', error: null, contentText: '', contentTruncated: false, fetchedAt: null,
          addedNote: `Konu arama sonucu (${search.name}): ${result.snippet.slice(0, 200)}`,
        };
        run.sources.push(source);
      }
      saveRun(run);
    }

    progress(`2/5 ${run.sources.length} kayıtlı kaynak kontrol ediliyor; yeni kaynaklar indiriliyor.`);
    for (const source of run.sources.filter((item) => item.kind === 'url' && item.status !== 'ok' && !item.error?.startsWith('Konu alaka filtresinden geçmedi'))) {
      try {
        const fetched = await fetchSource(source.url!);
        source.title = fetched.title;
        source.url = fetched.finalUrl || source.url;
        source.contentText = fetched.text;
        source.contentTruncated = fetched.truncated;
        source.status = 'ok';
        source.error = null;
        source.fetchedAt = new Date().toISOString();
      } catch (error) {
        source.status = 'failed';
        source.error = error instanceof FetchError ? error.message : (error instanceof Error ? error.message : String(error));
        source.fetchedAt = new Date().toISOString();
        progress(`  Kaynak atlandı: ${source.url} — ${source.error}`);
      }
    }
    for (const source of run.sources.filter((item) => item.status === 'ok')) {
      const relevance = assessSourceRelevance(topic, source);
      if (!relevance.relevant) {
        source.status = 'failed';
        source.error = `Konu alaka filtresinden geçmedi: ${relevance.reason}`;
        progress(`  Alakasız kaynak elendi: ${source.title} — ${relevance.reason}`);
      }
    }
    saveRun(run);
    const relevantSources = run.sources.filter((source) => source.status === 'ok' && source.contentText.trim());
    if (relevantSources.length === 0) {
      throw new Error('Kaynaklar indirildi ancak hiçbiri konu alaka filtresini geçemedi. Senaryo üretilmedi; daha uygun kaynaklar bulunmalı.');
    }
    progress(`${relevantSources.length} kaynak konu alaka filtresini geçti.`);

    progress('3/5 Kaynaklardan alıntılı olgular çıkarılıyor.');
    const research = await runResearcher(run, llm, (current, total) => progress(`  Araştırma LLM çağrısı ${current}/${total} — Ollama modelinin hızına göre birkaç dakika sürebilir.`));
    run.facts = research.facts;
    run.contradictions = research.contradictions;
    run.research_notes = research.research_notes;
    for (const fact of run.facts) {
      if (fact.quote_verified && fact.kind === 'fact') {
        fact.status = 'approved';
        fact.note = [fact.note, 'CLI otomatik akışında kaynak alıntısı doğrulandığı için senaryoya alındı.'].filter(Boolean).join(' · ');
      }
    }
    saveRun(run);
    const approvedFacts = run.facts.filter((fact) => fact.status === 'approved');
    if (approvedFacts.length === 0) {
      const verifiedQuotes = run.facts.filter((fact) => fact.quote_verified).length;
      const directVerified = run.facts.filter((fact) => fact.quote_verified && fact.kind === 'fact').length;
      const reason = run.facts.length === 0
        ? 'Model kaynaklı olgu çıkarmadı veya verdiği kaynak URL’leri eşleştirilemedi.'
        : `aday olgu ${run.facts.length}, doğrulanmış alıntı ${verifiedQuotes}, doğrulanmış doğrudan olgu ${directVerified}`;
      throw new Error(`Senaryoya geçirilecek doğrulanmış doğrudan olgu yok (${reason}). Senaryo uydurulmadı. Araştırma notu: ${run.research_notes ?? 'yok'}`);
    }

    progress('4/5 Yalnızca alıntısı doğrulanmış olgulardan Türkçe senaryo yazılıyor.');
    const written = await runScriptwriter(run, llm);
    run.script = {
      title: written.title,
      sentences: written.sentences,
      estimated_seconds: written.estimated_seconds,
      style_notes: written.style_notes,
      generated_at: new Date().toISOString(),
    };
    saveRun(run);

    progress('5/5 Senaryo cümleleri kaynaklarla denetleniyor.');
    const checked = await runFactChecker(run, llm);
    if (!run.script) throw new Error('Senaryo denetim aşamasında bulunamadı.');
    run.script.sentences = checked.sentences;
    run.factcheck = checked.report;
    saveRun(run);

    const exportDir = path.join(DATA_DIR, 'exports');
    fs.mkdirSync(exportDir, { recursive: true });
    const outputPath = path.join(exportDir, `${slugify(topic)}-${run.id.slice(0, 8)}.md`);
    fs.writeFileSync(outputPath, toMarkdown(run), 'utf8');

    printScenario(run);
    console.log(`\nTam araştırma ve senaryo Markdown olarak kaydedildi: ${outputPath}`);
    console.log(`Çalışma kaydı: ${path.join(DATA_DIR, 'runs', `${run.id}.json`)}`);
    if (!run.factcheck?.ok) process.exitCode = 2;
  } catch (error) {
    saveRun(run);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nDURDU — ${message}`);
    console.error(`Son güvenli çalışma kaydı: ${path.join(DATA_DIR, 'runs', `${run.id}.json`)}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
