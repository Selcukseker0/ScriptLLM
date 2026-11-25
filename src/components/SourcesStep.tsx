import { useState } from 'react';
import { api, ApiError, type ResearchRun, type ConfigResponse } from '../api.js';
import { ErrorBanner, InfoBanner, Spinner } from './common.js';

interface SourcesStepProps {
  run: ResearchRun;
  config: ConfigResponse | null;
  onRunChanged: (run: ResearchRun) => void;
  onAdvance: () => void;
}

export default function SourcesStep({ run, config, onRunChanged, onAdvance }: SourcesStepProps) {
  const [query, setQuery] = useState(run.topic);
  const [searching, setSearching] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');

  const pendingCount = run.sources.filter((s) => s.kind === 'url' && s.status !== 'ok' && !s.error?.startsWith('Konu alaka filtresinden geçmedi')).length;
  const okCount = run.sources.filter((s) => s.status === 'ok').length;
  const searchConfigured = config?.search.configured ?? false;

  async function doSearch() {
    setError(null);
    setNotice(null);
    setSearching(true);
    try {
      const { run: updated, added, provider } = await api.searchSources(run.id, { query: query.trim(), count: 6 });
      onRunChanged(updated);
      setNotice(added > 0 ? `${provider.provider} aramasından ${added} yeni kaynak eklendi (${provider.detail}). İndirmek için “Kaynakları Getir”e basın.` : 'Arama sonucu bulundu ancak tümü zaten listede.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Arama başarısız oldu.');
    } finally {
      setSearching(false);
    }
  }

  async function doFetch() {
    setError(null);
    setNotice(null);
    setFetching(true);
    try {
      const { run: updated, fetched } = await api.fetchSources(run.id);
      onRunChanged(updated);
      const failed = updated.sources.filter((s) => s.status === 'failed').length;
      setNotice(fetched === 0 ? 'İndirilecek bekleyen kaynak yok.' : failed > 0 ? `${fetched} kaynak işlendi; ${failed} tanesi erişilemedi (aşağıda işaretlendi). Erişilemeyen kaynaklar araştırmaya dâhil edilmez.` : `${fetched} kaynak başarıyla indirildi.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kaynaklar getirilemedi.');
    } finally {
      setFetching(false);
    }
  }

  async function addUrl() {
    setError(null);
    const url = urlInput.trim();
    if (!url) return;
    setAdding(true);
    try {
      const { run: updated } = await api.addSource(run.id, { url });
      onRunChanged(updated);
      setUrlInput('');
      setNotice('URL eklendi — indirmek için “Kaynakları Getir”e basın.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'URL eklenemedi.');
    } finally {
      setAdding(false);
    }
  }

  async function addPaste() {
    setError(null);
    if (pasteText.trim().length < 50) {
      setError('Kaynak metni en az 50 karakter olmalı.');
      return;
    }
    setAdding(true);
    try {
      const { run: updated } = await api.addSource(run.id, { title: pasteTitle.trim() || 'Yapıştırılan kaynak', text: pasteText.trim() });
      onRunChanged(updated);
      setPasteTitle('');
      setPasteText('');
      setPasteOpen(false);
      setNotice('Metin kaynağı eklendi ve doğrudan kullanılabilir.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Metin eklenemedi.');
    } finally {
      setAdding(false);
    }
  }

  async function removeSource(sourceId: string, title: string) {
    if (!window.confirm(`“${title.slice(0, 60)}” kaynağı ve ona dayanan olgular silinsin mi?`)) return;
    setError(null);
    try {
      const { run: updated } = await api.removeSource(run.id, sourceId);
      onRunChanged(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kaynak silinemedi.');
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">1 · Kaynaklar</h3>
          <p className="panel-sub">Önce kaynakları bulun ya da URL/metin ekleyin; sonra hepsini indirip doğrulayın. Yalnızca başarıyla indirilen kaynaklar araştırmaya girer.</p>
        </div>
        <div className="toolbar">
          <span className={`counter-pill ${okCount > 0 ? 'counter-ok' : 'counter-warn'}`}>{okCount} kullanılabilir / {run.sources.length} toplam</span>
          {pendingCount > 0 && <span className="counter-pill counter-warn">{pendingCount} bekliyor</span>}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && <InfoBanner tone="ok">{notice}</InfoBanner>}

      {/* Web arama */}
      <div className="card" style={{ boxShadow: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px' }}>
            <label className="f-label" htmlFor="search-query">Web’de kaynak ara</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input id="search-query" className="input" style={{ flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Arama sorgusu" />
              <button className="btn btn-secondary" onClick={() => void doSearch()} disabled={searching || !query.trim()}>
                {searching ? <Spinner dark /> : 'Ara'}
              </button>
            </div>
          </div>
        </div>
        <div className="f-hint" style={{ marginTop: 8 }}>
          {config ? (
            searchConfigured ? (
              <>Arama sağlayıcısı: <strong>{config.search.detail}</strong>. Arama sonuçları “aday kaynak” olarak eklenir; içerik ancak “Kaynakları Getir” ile indirilir.</>
            ) : (
              <><strong>Arama sağlayıcısı anahtarı yok.</strong> {config.search.detail} Anahtar olmadan Wikipedia araması kullanılabilir; daha geniş kapsam için <code>.env</code> dosyasına <code>TAVILY_API_KEY</code> veya <code>BRAVE_API_KEY</code> ekleyin. Ya da aşağıdan URL ekleyin / metin yapıştırın.</>
            )
          ) : (
            'Arama yapılandırması yükleniyor…'
          )}
        </div>
      </div>

      {/* URL ekle + metin yapıştır */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flex: '1 1 380px' }}>
          <input className="input mono" style={{ flex: 1, fontSize: 12.5 }} value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addUrl()} placeholder="https://… ekle" aria-label="URL ekle" />
          <button className="btn btn-secondary" onClick={() => void addUrl()} disabled={adding || !urlInput.trim()}>URL Ekle</button>
        </div>
        <button className="btn btn-ghost" onClick={() => setPasteOpen((v) => !v)}>{pasteOpen ? 'Vazgeç' : '＋ Metin Yapıştır'}</button>
        <button className="btn btn-primary" onClick={() => void doFetch()} disabled={fetching || pendingCount === 0}>
          {fetching ? <><Spinner /> İndiriliyor…</> : `Kaynakları Getir${pendingCount > 0 ? ` (${pendingCount})` : ''}`}
        </button>
      </div>

      {pasteOpen && (
        <div className="card" style={{ boxShadow: 'none' }}>
          <label className="f-label" htmlFor="src-paste-title">Kaynak başlığı</label>
          <input id="src-paste-title" className="input" style={{ margin: '6px 0 10px' }} value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="Örn. Resmî gazete ilanı, 12.03.2026" />
          <label className="f-label" htmlFor="src-paste-text">Kaynak metni (en az 50 karakter)</label>
          <textarea id="src-paste-text" className="input" rows={5} style={{ margin: '6px 0 10px' }} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="Metni buraya yapıştırın…" />
          <button className="btn btn-secondary" onClick={() => void addPaste()} disabled={adding}>{adding ? <><Spinner dark /> Kaydediliyor…</> : 'Metni Kaynağa Ekle'}</button>
        </div>
      )}

      {/* Kaynak listesi */}
      {run.sources.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🗂️</div>
          <strong>Henüz kaynak yok</strong>
          <div>Yukarıdan web’de arayın, URL ekleyin ya da metin yapıştırın. Kaynak olmadan araştırma başlatılamaz — arayüz uydurma bilgiyi engeller.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {run.sources.map((s) => {
            const irrelevant = Boolean(s.error?.startsWith('Konu alaka filtresinden geçmedi'));
            return (
            <div key={s.id} className={`source-row${s.status === 'failed' ? ' failed' : ''}`}>
              <span className={`source-status ${s.status === 'ok' ? 'st-ok' : s.status === 'failed' ? 'st-failed' : 'st-pending'}`} title={s.status === 'ok' ? 'İndirildi ve kullanılabilir' : irrelevant ? 'Konu ile alakasız, araştırmadan çıkarıldı' : s.status === 'failed' ? 'Erişilemedi' : 'Bekliyor'}>
                {s.status === 'ok' ? '✓' : irrelevant ? '↛' : s.status === 'failed' ? '✕' : '…'}
              </span>
              <div className="source-body">
                <div className="source-title">{s.title}</div>
                {s.url && <div className="source-url">{s.url}</div>}
                <div className="source-meta">
                  <span>{s.kind === 'text' ? 'Yapıştırılan metin' : 'Web sayfası'}</span>
                  {s.status === 'ok' && <span>· {s.contentText.length.toLocaleString('tr-TR')} karakter{s.contentTruncated ? ' (kısaltıldı)' : ''}</span>}
                  {s.addedNote && <span>· {s.addedNote.slice(0, 120)}</span>}
                </div>
                {s.status === 'failed' && <div className="source-error">{irrelevant ? 'Konu alaka kapısından geçmedi' : 'Erişilemedi'}: {s.error}</div>}
              </div>
              <button className="btn-icon" title="Kaynağı kaldır" aria-label="Kaynağı kaldır" onClick={() => void removeSource(s.id, s.title)}>🗑</button>
            </div>
            );
          })}
        </div>
      )}

      <div className="section-divider" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12 }}>{okCount > 0 ? 'Hazır olduğunda olgu çıkarımına geçin.' : 'Önce en az bir kaynağın başarıyla inmesi gerekir.'}</span>
        <button className="btn btn-primary" onClick={onAdvance} disabled={okCount === 0}>
          Olgu Listesine Geç →
        </button>
      </div>
    </div>
  );
}
