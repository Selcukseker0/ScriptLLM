import { describe, it, expect } from 'vitest';
import { runResearcher, ResearchAgentError, findSupportingQuote } from '../server/research/researcher.js';
import { runScriptwriter, ScriptwriterError } from '../server/research/scriptwriter.js';
import { runFactChecker, extractNumbers } from '../server/research/factchecker.js';
import { LLMError } from '../server/llm/provider.js';
import { makeRun, makeFact, makeSource, fakeProvider } from './helpers.js';

const RESEARCHER_JSON = JSON.stringify({
  facts: [
    { statement: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi.', source_url: 'https://example.com/a', quote: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi', confidence: 'high', kind: 'fact' },
    { statement: 'Uydurma bir bilgi: ilk kopyalama 1800 yılı.', source_url: 'https://example.com/a', quote: 'kaynakta böyle bir cümle asla yok xyz qwe', confidence: 'high', kind: 'fact' },
    { statement: 'Bilinmeyen kaynaktan gelen bilgi.', source_url: 'https://evil.example.net/yok', quote: 'hicbir sey', confidence: 'medium', kind: 'fact' },
  ],
  contradictions: [],
  notes: 'test notu',
});

describe('Researcher', () => {
  it('ifade ile yeterli örtüşen gerçek kaynak cümlesini bulur; sayıları da zorunlu tutar', () => {
    const source = '1999 İzmit depremi 17 Ağustos tarihinde meydana geldi ve bölgede ciddi hasara yol açtı. Bu olay sonrasında yapı denetimi konusunda yeni çalışmalar yapıldı.';
    expect(findSupportingQuote('1999 İzmit depremi 17 Ağustos tarihinde meydana geldi.', source)).toContain('1999 İzmit depremi 17 Ağustos');
    expect(findSupportingQuote('1998 İzmit depremi 17 Ağustos tarihinde meydana geldi.', source)).toBeNull();
  });

  it('kaynaksız çalışmada açık hata verir', async () => {
    const run = makeRun({ sources: [makeSource({ status: 'failed', contentText: '' })] });
    await expect(runResearcher(run, fakeProvider(RESEARCHER_JSON))).rejects.toMatchObject({ code: 'no_sources' });
  });

  it('alıntısı doğrulanan olguyu fact, doğrulanamayanı unverified yapar; bilinmeyen kaynağı eler', async () => {
    const run = makeRun();
    const result = await runResearcher(run, fakeProvider(RESEARCHER_JSON));
    expect(result.facts).toHaveLength(2);
    const verified = result.facts.find((f) => f.quote.includes('1923'));
    const unverified = result.facts.find((f) => f.statement.includes('Uydurma'));
    expect(verified?.quote_verified).toBe(true);
    expect(verified?.kind).toBe('fact');
    expect(unverified?.quote_verified).toBe(false);
    expect(unverified?.kind).toBe('unverified');
    expect(unverified?.confidence).toBe('low');
    expect(result.facts.map((f) => f.fact_id)).toEqual(['F001', 'F002']);
    expect(result.research_notes).toContain('elendi');
    expect(result.sources_used).toBe(1);
  });

  it('model alıntısı yanlışa yakınsa kaynaktaki örtüşen gerçek cümleyi alır ve güveni orta yapar', async () => {
    const result = await runResearcher(makeRun(), fakeProvider(JSON.stringify({
      facts: [{
        statement: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi.',
        source_url: 'https://example.com/a',
        quote: 'kaynakta bulunmayan yanlış alıntı ve ifade',
        confidence: 'high',
        kind: 'fact',
      }],
      contradictions: [],
      notes: null,
    })));
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].quote_verified).toBe(true);
    expect(result.facts[0].quote).toContain('Türkiye Cumhuriyeti 1923 yılında ilan edildi');
    expect(result.facts[0].confidence).toBe('medium');
    expect(result.facts[0].note).toContain('gerçek kaynak cümlesi');
  });

  it('model bozuk JSON dönerse bad_json hatası fırlatır (uydurma içerik eklenmez)', async () => {
    const run = makeRun();
    await expect(runResearcher(run, fakeProvider('üzgünüm, yapamadım'))).rejects.toMatchObject({ code: 'bad_json' });
  });
});

describe('Scriptwriter', () => {
  it('onaylı olgu yoksa açık hatayla durur', async () => {
    const run = makeRun({ facts: [makeFact({ status: 'pending' })] });
    await expect(runScriptwriter(run, fakeProvider('{}'))).rejects.toMatchObject({ code: 'no_approved_facts' });
  });

  it('olmayan fact_id referanslarını eler ve süreyi hesaplar', async () => {
    const out = JSON.stringify({
      title: 'Test Senaryosu',
      style_notes: null,
      sentences: [
        { text: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi.', fact_ids: ['F001', 'F999'] },
        { text: 'Başkent Ankara’dır.', fact_ids: ['F001'] },
      ],
    });
    const run = makeRun();
    const result = await runScriptwriter(run, fakeProvider(out));
    expect(result.sentences[0].fact_ids).toEqual(['F001']);
    expect(result.dropped_fact_refs).toBe(1);
    expect(result.estimated_seconds).toBeGreaterThan(0);
    expect(result.title).toBe('Test Senaryosu');
  });

  it('İngilizce kalıntılı taslağı reddeder, Türkçe olmayan ifadeyi hazır sunmaz', async () => {
    const out = JSON.stringify({
      title: 'Deprem güvenliği',
      style_notes: null,
      sentences: [{ text: '1980 coup’un ardından yeni bir dönem başladı.', fact_ids: ['F001'] }],
    });
    await expect(runScriptwriter(makeRun(), fakeProvider(out))).rejects.toMatchObject({ code: 'english_residue' });
  });

  it('model bozuk JSON dönerse bad_json hatası fırlatır', async () => {
    const run = makeRun();
    await expect(runScriptwriter(run, fakeProvider('{not json'))).rejects.toMatchObject({ code: 'bad_json' });
  });
});

describe('FactChecker', () => {
  const scriptWith = (sentences: Array<{ id: string; text: string; fact_ids: string[] }>) => ({
    title: 'Test',
    sentences: sentences.map((s) => ({ ...s, check: 'unchecked' as const, check_note: null })),
    estimated_seconds: 60,
    style_notes: null,
    generated_at: '2026-11-25T10:00:00.000Z',
  });

  it('senaryo yoksa hata verir', async () => {
    await expect(runFactChecker(makeRun({ script: null }), fakeProvider('{}'))).rejects.toMatchObject({ code: 'no_script' });
  });

  it('dayanağı olmayan cümleyi unsupported işaretler', async () => {
    const run = makeRun({ script: scriptWith([{ id: 'S001', text: 'Bu bir giriş cümlesidir.', fact_ids: [] }]) });
    const llm = fakeProvider(JSON.stringify({ results: [{ id: 'S001', verdict: 'supported', note: null }] }));
    const outcome = await runFactChecker(run, llm);
    expect(outcome.sentences[0].check).toBe('unsupported');
    expect(outcome.report.ok).toBe(false);
  });

  it('reddedilmiş olguya dayanan cümleyi unsupported işaretler', async () => {
    const run = makeRun({
      facts: [makeFact({ status: 'rejected' })],
      script: scriptWith([{ id: 'S001', text: 'Cumhuriyet 1923’te ilan edildi.', fact_ids: ['F001'] }]),
    });
    const outcome = await runFactChecker(run, fakeProvider(JSON.stringify({ results: [] })));
    expect(outcome.sentences[0].check).toBe('unsupported');
    expect(outcome.sentences[0].check_note).toContain('reddedildi');
  });

  it('konuyla alakasız kaynağa dayanan iddiayı unsupported işaretler', async () => {
    const run = makeRun({
      topic: 'Türkiye’de deprem güvenliği',
      sources: [makeSource({ title: 'DİSK tarihi', contentText: 'Türkiye Devrimci İşçi Sendikaları Konfederasyonu 1967 yılında kuruldu. Sendikanın tarihi ve örgütlenmesi.' })],
      script: scriptWith([{ id: 'S001', text: 'DİSK 1967 yılında kuruldu.', fact_ids: ['F001'] }]),
    });
    const outcome = await runFactChecker(run, fakeProvider(JSON.stringify({ results: [{ id: 'S001', verdict: 'supported', note: null }] })));
    expect(outcome.sentences[0].check).toBe('unsupported');
    expect(outcome.sentences[0].check_note).toContain('Konu uyumu doğrulanamadı');
    expect(outcome.report.ok).toBe(false);
  });

  it('beklemedeki olguya dayanan cümleyi de unsupported işaretler', async () => {
    const run = makeRun({
      facts: [makeFact({ status: 'pending' })],
      script: scriptWith([{ id: 'S001', text: 'Cumhuriyet 1923’te ilan edildi.', fact_ids: ['F001'] }]),
    });
    const outcome = await runFactChecker(run, fakeProvider(JSON.stringify({ results: [] })));
    expect(outcome.sentences[0].check).toBe('unsupported');
    expect(outcome.sentences[0].check_note).toContain('beklemede');
    expect(outcome.report.ok).toBe(false);
  });

  it('dayanakta olmayan sayı içeren cümleyi uncertain işaretler', async () => {
    const run = makeRun({ script: scriptWith([{ id: 'S001', text: 'Cumhuriyet 1987 yılında ilan edildi.', fact_ids: ['F001'] }]) });
    const outcome = await runFactChecker(run, fakeProvider(JSON.stringify({ results: [{ id: 'S001', verdict: 'supported', note: null }] })));
    expect(outcome.sentences[0].check).toBe('uncertain');
    expect(outcome.sentences[0].check_note).toContain('1987');
  });

  it('temiz cümle için LLM hükmünü uygular', async () => {
    const run = makeRun({ script: scriptWith([{ id: 'S001', text: 'Cumhuriyet 1923 yılında ilan edildi.', fact_ids: ['F001'] }]) });
    const outcome = await runFactChecker(run, fakeProvider(JSON.stringify({ results: [{ id: 'S001', verdict: 'supported', note: 'Tam destek' }] })));
    expect(outcome.sentences[0].check).toBe('supported');
    expect(outcome.report.ok).toBe(true);
    expect(outcome.llmError).toBeNull();
  });

  it('LLM başarısızsa kısmi sonucu ok=false ile döndürür ve llmError verir', async () => {
    const run = makeRun({
      script: scriptWith([
        { id: 'S001', text: 'Cumhuriyet 1923 yılında ilan edildi.', fact_ids: ['F001'] },
        { id: 'S002', text: 'Dayanaksız iddia.', fact_ids: [] },
      ]),
    });
    const outcome = await runFactChecker(run, fakeProvider('', { fail: new LLMError('rate_limit', 'kota') }));
    expect(outcome.llmError).toBeTruthy();
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.summary).toContain('Denetim modeli hatası');
    expect(outcome.sentences[1].check).toBe('unsupported'); // deterministik kural yine de uygulandı
    expect(outcome.sentences[0].check).toBe('unchecked');
  });

  it('çelişkili hüküm ok=false yapar', async () => {
    const run = makeRun({ script: scriptWith([{ id: 'S001', text: 'Cumhuriyet 1923 yılında ilan edildi.', fact_ids: ['F001'] }]) });
    const outcome = await runFactChecker(run, fakeProvider(JSON.stringify({ results: [{ id: 'S001', verdict: 'contradicted', note: 'Çelişiyor' }] })));
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.contradicted).toBe(1);
  });

  it('extractNumbers rakam gruplarını yakalar', () => {
    expect(extractNumbers('85 milyon, 1923 ve %100')).toEqual(expect.arrayContaining(['85', '1923', '100']));
  });
});
