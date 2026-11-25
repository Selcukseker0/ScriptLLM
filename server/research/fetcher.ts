import * as cheerio from 'cheerio';

export const MAX_SOURCE_CHARS = 20_000;
export const MAX_BATCH_CHARS = 12_000;
export const MAX_BATCHES = 4;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const TIMEOUT_MS = 18_000;

export interface FetchedSource {
  title: string;
  text: string;
  truncated: boolean;
  finalUrl: string;
}

export class FetchError extends Error {
  code: 'bad_url' | 'blocked' | 'network' | 'too_large' | 'bad_content_type' | 'empty';
  constructor(code: FetchError['code'], message: string) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}

/** SSRF koruması: yalnızca http(s) ve genel (public) adresler */
export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('bad_url', 'Geçersiz URL biçimi.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('bad_url', 'Yalnızca http:// ve https:// adresleri desteklenir.');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    /^\[?::ffff:/.test(host) ||
    /^\[?(?:fe80:|f[cd][0-9a-f]{2}:|ff[0-9a-f]{2}:|::$)/.test(host)
  ) {
    throw new FetchError('blocked', 'Yerel (loopback) adresler güvenlik nedeniyle engellendi.');
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    ) {
      throw new FetchError('blocked', 'Özel/yerel IP adresleri (10.x, 192.168.x, 172.16-31.x, 169.254.x, 127.x) güvenlik nedeniyle engellendi.');
    }
  }
  return url;
}

/** HTML'i düz metne indirger: script/style/nav/footer/header atılır */
export function extractTextFromHtml(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg, form, nav, footer, header, aside, [role="navigation"], [aria-hidden="true"]').remove();
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    'Başlıksız kaynak';
  const main = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  const text = main.text().replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').replace(/\s+/g, ' ').trim();
  return { title: title.slice(0, 300), text };
}

/** Metni okunması için normalize eder */
export function normalizePlainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Bir URL'yi indirip metin çıkarır. Hata durumunda FetchError atar — asla sessizce boş dönmez. */
export async function fetchSource(rawUrl: string): Promise<FetchedSource> {
  const url = validatePublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Redirect'leri otomatik izleme: her Location yeniden doğrulanır; public URL'nin
    // özel IP'ye yönlenerek SSRF korumasını aşması engellenir.
    let currentUrl = url;
    let res: Response;
    for (let redirectCount = 0; ; redirectCount++) {
      res = await fetch(currentUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; ScriptLLM/1.0; +https://github.com/Selcukseker0/ScriptLLM)',
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.3',
          'accept-language': 'tr,en;q=0.8',
        },
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      if (!location) throw new FetchError('network', `HTTP ${res.status} yönlendirmesinde Location başlığı yok.`);
      if (redirectCount >= 4) throw new FetchError('network', 'Kaynak çok fazla yönlendirme yaptı (en fazla 5).');
      const nextUrl = new URL(location, currentUrl);
      currentUrl = validatePublicUrl(nextUrl.toString());
      await res.body?.cancel();
    }
    if (!res.ok) {
      throw new FetchError('network', `Kaynak HTTP ${res.status} döndürdü. Sayfa erişilebilir değil veya engellenmiş olabilir.`);
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml') || contentType === '';
    const isText = isHtml || contentType.includes('text/plain') || contentType.includes('application/json') || contentType.includes('text/markdown');
    if (!isText) {
      throw new FetchError('bad_content_type', `Desteklenmeyen içerik türü: ${contentType || 'bilinmiyor'}. Yalnızca HTML/metin sayfaları işlenir (PDF, video vb. değil).`);
    }
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BYTES) throw new FetchError('too_large', 'Kaynak 2 MB sınırını aşıyor; içerik kısaltılamadığı için işlenmedi.');
        chunks.push(value);
      }
    } else {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) throw new FetchError('too_large', 'Kaynak 2 MB sınırını aşıyor.');
      chunks.push(new Uint8Array(buf));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let title = 'Başlıksız kaynak';
    let text = '';
    if (isHtml) {
      const extracted = extractTextFromHtml(raw);
      title = extracted.title;
      text = extracted.text;
    } else {
      text = normalizePlainText(raw);
      title = url.hostname;
    }
    if (text.length < 80) {
      throw new FetchError('empty', 'Sayfadan anlamlı metin çıkarılamadı (çok kısa veya sadece görselden oluşuyor olabilir).');
    }
    const truncated = text.length > MAX_SOURCE_CHARS;
    return { title, text: truncated ? text.slice(0, MAX_SOURCE_CHARS) : text, truncated, finalUrl: res.url || currentUrl.toString() };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchError('network', 'Kaynak indirme zaman aşımına uğradı (18s).');
    }
    throw new FetchError('network', `Kaynağa erişilemedi: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
