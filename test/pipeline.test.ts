import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toMarkdown, toJson } from '../server/export.js';
import { ResearchRunSchema } from '../shared/schema.js';
import { makeRun, makeFact } from './helpers.js';
import { validatePublicUrl, extractTextFromHtml, fetchSource, FetchError } from '../server/research/fetcher.js';

describe('dışa aktarma', () => {
  const run = () =>
    makeRun({
      facts: [makeFact(), makeFact({ fact_id: 'F002', statement: 'Başkent Ankara’dır.', quote: 'Başkent Ankara', status: 'approved' })],
      script: {
        title: 'Test Senaryosu',
        sentences: [
          { id: 'S001', text: 'Türkiye Cumhuriyeti 1923 yılında ilan edildi.', fact_ids: ['F001'], check: 'supported', check_note: null },
          { id: 'S002', text: 'Bomba bir iddia.', fact_ids: [], check: 'unsupported', check_note: 'dayanak yok' },
        ],
        estimated_seconds: 120,
        style_notes: null,
        generated_at: '2026-11-25T10:00:00.000Z',
      },
      factcheck: {
        ran_at: '2026-11-25T10:05:00.000Z',
        ok: false,
        supported: 1,
        unsupported: 1,
        contradicted: 0,
        uncertain: 0,
        unchecked: 0,
        summary: 'Test özeti',
      },
    });

  it('Markdown tablosu, kaynaklar ve dayanak eşlemesi içerir', () => {
    const md = toMarkdown(run());
    expect(md).toContain('# Test Senaryosu');
    expect(md).toContain('https://example.com/a');
    expect(md).toContain('F001');
    expect(md).toContain('Cümle ⟷ Dayanak Eşlemesi');
    expect(md).toContain('DAYANAK YOK');
    expect(md).toContain('Denetim');
  });

  it('JSON çıktısı şemaya tam uyar (kararlı şema)', () => {
    const parsed = ResearchRunSchema.safeParse(JSON.parse(toJson(run())));
    expect(parsed.success).toBe(true);
  });
});

describe('fetcher güvenliği', () => {
  it('file:// URL’yi reddeder', () => {
    expect(() => validatePublicUrl('file:///etc/passwd')).toThrow(FetchError);
  });
  it('localhost’u reddeder', () => {
    expect(() => validatePublicUrl('http://localhost:3000/admin')).toThrow(FetchError);
    expect(() => validatePublicUrl('http://127.0.0.1:5174')).toThrow(FetchError);
    expect(() => validatePublicUrl('http://[::1]/')).toThrow(FetchError);
  });
  it('özel IP aralıklarını reddeder', () => {
    expect(() => validatePublicUrl('http://192.168.1.10/router')).toThrow(FetchError);
    expect(() => validatePublicUrl('http://10.0.0.5/iç')).toThrow(FetchError);
    expect(() => validatePublicUrl('http://172.16.3.4/')).toThrow(FetchError);
    expect(() => validatePublicUrl('http://169.254.169.254/latest/meta-data')).toThrow(FetchError);
  });
  it('genel https URL’ye izin verir', () => {
    expect(validatePublicUrl('https://tr.wikipedia.org/wiki/Türkiye').hostname).toBe('tr.wikipedia.org');
  });
  it('HTML’den script/style temizleyip başlık ve metin çıkarır', () => {
    const html = '<html><head><title>Başlık Burada</title><style>.x{color:red}</style></head><body><nav>menü</nav><article><p>İçerik cümlesi burada yer alır ve yeterince uzundur.</p><script>alert(1)</script></article></body></html>';
    const { title, text } = extractTextFromHtml(html);
    expect(title).toBe('Başlık Burada');
    expect(text).toContain('İçerik cümlesi');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('public URL yönlendirmesini private IP’ye takip etmez', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchSource('https://public.example.org/article')).rejects.toMatchObject({ code: 'blocked' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('arama sağlayıcıları', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('SEARCH_PROVIDER', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('anahtar yoksa wikipedia varsayılanına düşer', async () => {
    const { getSearchEnvConfig } = await import('../server/config.js');
    expect(getSearchEnvConfig().provider).toBe('wikipedia');
  });

  it('SEARCH_PROVIDER=none aramayı kapatır', async () => {
    vi.stubEnv('SEARCH_PROVIDER', 'none');
    const { getSearchEnvConfig } = await import('../server/config.js');
    expect(getSearchEnvConfig().provider).toBe('none');
  });

  it('anahtar girişi sağlayıcıyı etkinleştirir', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
    const { getSearchEnvConfig } = await import('../server/config.js');
    expect(getSearchEnvConfig().provider).toBe('tavily');
  });

  it('tavily sonuçlarını normalize eder (fetch stub’lı)', async () => {
    vi.stubEnv('SEARCH_PROVIDER', 'tavily');
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 'Kaynak A', url: 'https://a.example.com', content: 'içerik' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getSearchProvider } = await import('../server/search/providers.js');
    const results = await getSearchProvider().search('türkiye', 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Kaynak A', url: 'https://a.example.com', provider: 'tavily' });
    vi.unstubAllGlobals();
  });

  it('tavily 429 → SearchError rate_limit', async () => {
    vi.stubEnv('SEARCH_PROVIDER', 'tavily');
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })));
    const { getSearchProvider, SearchError } = await import('../server/search/providers.js');
    await expect(getSearchProvider().search('x', 5)).rejects.toMatchObject({ code: 'rate_limit' });
    vi.unstubAllGlobals();
  });
});

describe('yerel depolama', () => {
  let tmp: string;
  beforeEach(() => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptllm-test-'));
    process.env.DATA_DIR = tmp;
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('kaydeder, listeler, okur, siler (roundtrip)', async () => {
    const storage = await import('../server/storage.js');
    const run = makeRun({ id: 'roundtrip-1' });
    storage.saveRun(run);
    expect(storage.listRuns().map((r) => r.id)).toContain('roundtrip-1');
    const loaded = storage.getRun('roundtrip-1');
    expect(loaded.topic).toBe(run.topic);
    storage.deleteRun('roundtrip-1');
    expect(() => storage.getRun('roundtrip-1')).toThrow(/bulunamadı/i);
  });

  it('bozuk dosyayı atlar, getRun corrupt hatası verir, dosya silinmez', async () => {
    const storage = await import('../server/storage.js');
    storage.saveRun(makeRun({ id: 'goodfile-1' }));
    const runsDir = path.join(tmp, 'runs');
    fs.writeFileSync(path.join(runsDir, 'brokenfile-2.json'), '{bozuk json!!!', 'utf8');
    const list = storage.listRuns();
    expect(list.map((r) => r.id)).toContain('goodfile-1');
    expect(list.map((r) => r.id)).not.toContain('brokenfile-2');
    expect(() => storage.getRun('brokenfile-2')).toThrow();
    expect(fs.existsSync(path.join(runsDir, 'brokenfile-2.json'))).toBe(true); // veri kaybı yok
  });
});
