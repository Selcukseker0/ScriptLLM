import { useEffect, useState } from 'react';
import { api, ApiError, type ResearchRun } from '../api.js';
import { ErrorBanner, InfoBanner } from './common.js';

export default function ExportStep({ run }: { run: ResearchRun }) {
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api.exportMarkdownText(run.id)
      .then((text) => { if (live) setMarkdown(text); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Önizleme yüklenemedi.'); });
    return () => { live = false; };
  }, [run.id, run.updated_at]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Panoya kopyalanamadı. Tarayıcı izinlerini kontrol edin.');
    }
  }

  const report = run.factcheck;

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">5 · Dışa Aktar</h3>
          <p className="panel-sub">Araştırma, kaynaklı olgular, çelişkiler, senaryo ve cümle-dayanak eşlemesi bir arada. Markdown veya makinece okunabilir JSON indirin.</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {report?.ok ? (
        <InfoBanner tone="ok">Son denetim temiz görünüyor. Kaynakların doğruluğunu kendiniz de inceleyin.</InfoBanner>
      ) : (
        <InfoBanner tone="warn"><strong>Bu çalışma fact-check denetimini geçmedi veya henüz denetlenmedi.</strong> İndirme engellenmez; ancak export denetim uyarılarını açıkça içerir ve taslak “hazır” olarak işaretlenmez.</InfoBanner>
      )}

      <div className="export-stats">
        <span>📚 {run.sources.length} kaynak ({run.sources.filter((s) => s.status === 'ok').length} erişilebilir)</span>
        <span>🔎 {run.facts.length} olgu ({run.facts.filter((f) => f.status === 'approved').length} onaylı)</span>
        <span>⚖️ {run.contradictions.length} çelişki</span>
        <span>✍️ {run.script?.sentences.length ?? 0} senaryo cümlesi</span>
      </div>

      <div className="toolbar">
        <a className="btn btn-primary" href={api.exportMarkdownUrl(run.id)} download>
          ↓ Markdown (.md)
        </a>
        <a className="btn btn-secondary" href={api.exportJsonUrl(run.id)} download>
          ↓ JSON (.json)
        </a>
        <button className="btn btn-ghost" onClick={() => void copy()} disabled={!markdown}>{copied ? '✓ Kopyalandı' : 'Metni Kopyala'}</button>
      </div>

      {markdown ? <pre className="export-preview">{markdown}</pre> : !error && <div className="empty">Önizleme yükleniyor…</div>}

      <div className="details-box">
        <strong>JSON şeması v{run.schema_version}</strong>
        <div style={{ marginTop: 4 }}>Dışa aktarılan JSON, uygulamanın kalıcı depolama şemasıyla aynıdır: source, fact, contradiction, script sentence ve fact-check raporu alanlarını içerir. API anahtarları veya sunucu ayarları export’a girmez.</div>
      </div>
    </div>
  );
}
