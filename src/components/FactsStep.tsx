import { useMemo, useState } from 'react';
import { api, ApiError, type ResearchRun } from '../api.js';
import type { Fact, FactStatus } from '../../shared/schema.js';
import { CONFIDENCE_LABEL, ErrorBanner, InfoBanner, KIND_LABEL, Spinner } from './common.js';

interface FactsStepProps {
  run: ResearchRun;
  onRunChanged: (run: ResearchRun) => void;
  onAdvance: () => void;
}

export default function FactsStep({ run, onRunChanged, onAdvance }: FactsStepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const okSources = run.sources.filter((s) => s.status === 'ok').length;
  const approved = run.facts.filter((f) => f.status === 'approved').length;
  const rejected = run.facts.filter((f) => f.status === 'rejected').length;
  const unverified = run.facts.filter((f) => !f.quote_verified).length;

  const sorted = useMemo(
    () => [...run.facts].sort((a, b) => Number(a.fact_id.slice(1)) - Number(b.fact_id.slice(1))),
    [run.facts],
  );

  async function doResearch() {
    if (run.facts.length > 0 && !window.confirm('Yeni araştırma mevcut olgu listesini (onaylarınız dâhil) tamamen değiştirir ve senaryoyu geçersiz kılar. Devam edilsin mi?')) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { run: updated, stats } = await api.research(run.id);
      onRunChanged(updated);
      setNotice(`Araştırma tamam: ${stats.facts} olgu, ${stats.contradictions} çelişki (${stats.batches} parça, ${stats.sources} kaynaktan). Olguların her birinin durumunu gözden geçirip onaylayın.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Araştırma tamamlanamadı.');
    } finally {
      setBusy(false);
    }
  }

  async function patchFacts(patches: Parameters<typeof api.patchFacts>[1], after?: () => void) {
    setError(null);
    try {
      const { run: updated } = await api.patchFacts(run.id, patches);
      onRunChanged(updated);
      after?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Olgu güncellenemedi.');
    }
  }

  const setStatus = (fact: Fact, status: FactStatus) => patchFacts([{ fact_id: fact.fact_id, status }]);

  async function saveStatement(fact: Fact) {
    const text = editing[fact.fact_id];
    if (text === undefined) return;
    if (text.trim() === fact.statement) {
      setEditing((m) => { const next = { ...m }; delete next[fact.fact_id]; return next; });
      return;
    }
    setError(null);
    try {
      const { run: updated } = await api.patchFacts(run.id, [{ fact_id: fact.fact_id, statement: text.trim() }]);
      onRunChanged(updated);
      setEditing((m) => { const next = { ...m }; delete next[fact.fact_id]; return next; });
      setNotice(`${fact.fact_id} metin olarak güncellendi.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Olgu güncellenemedi.');
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">2 · Olgu Listesi</h3>
          <p className="panel-sub">
            Her olgu; kaynak URL’si, destekleyici alıntı ve güven düzeyiyle birlikte gösterilir. Senaryo yalnızca <strong>onayladığınız</strong> olgulardan yazılır.
          </p>
        </div>
        <div className="toolbar">
          <span className={`counter-pill ${approved > 0 ? 'counter-ok' : 'counter-warn'}`}>{approved} onaylı</span>
          <span className="counter-pill">{run.facts.length} toplam</span>
          {rejected > 0 && <span className="counter-pill">{rejected} reddedildi</span>}
          {unverified > 0 && <span className="counter-pill counter-warn">{unverified} doğrulanamadı</span>}
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setError(null)} />}
      {notice && <InfoBanner tone="ok">{notice}</InfoBanner>}

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void doResearch()} disabled={busy || okSources === 0}>
          {busy ? <><Spinner /> Kaynaklar analiz ediliyor…</> : run.facts.length > 0 ? 'Yeniden Araştır' : 'Olgu Listesini Oluştur'}
        </button>
        {run.facts.length > 0 && (
          <>
            <button className="btn btn-secondary btn-sm" onClick={() => void patchFacts(run.facts.filter((f) => f.status !== 'approved' && f.quote_verified).map((f) => ({ fact_id: f.fact_id, status: 'approved' as const })))} disabled={busy}>
              Dayanak doğrulananların tümünü onayla
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => void patchFacts(run.facts.filter((f) => !f.quote_verified && f.status === 'pending').map((f) => ({ fact_id: f.fact_id, status: 'rejected' as const })))} disabled={busy}>
              Doğrulanamayanları reddet
            </button>
          </>
        )}
      </div>

      {okSources === 0 && (
        <InfoBanner tone="warn">İndirilebilir kaynak yok. 1. adımda en az bir URL’yi getirip başarılı olmasını sağlayın veya metin yapıştırın.</InfoBanner>
      )}

      {run.research_notes && (
        <details className="details-box">
          <summary>Araştırma notları ({run.contradictions.length > 0 ? `${run.contradictions.length} çelişki kaydı dâhil` : 'otomatik kayıt'})</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: '8px 0 0', fontSize: 12 }}>{run.research_notes}</pre>
        </details>
      )}

      {run.contradictions.length > 0 && (
        <div className="contradiction-card">
          <h4>⚠️ Kaynaklar çelişirken kesin hüküm verilmedi — {run.contradictions.length} çelişki kaydı</h4>
          {run.contradictions.map((c) => (
            <div key={c.id} style={{ margin: '8px 0' }}>
              <strong style={{ fontSize: 13 }}>{c.id} · {c.topic}</strong>
              <ul>
                {c.positions.map((p, i) => (
                  <li key={i}>
                    {p.statement} — <span className="muted">{p.source_title}{p.source_url ? ` (${p.source_url})` : ''}</span>
                  </li>
                ))}
              </ul>
              {c.note && <div style={{ fontSize: 12, marginTop: 2 }}>Not: {c.note}</div>}
            </div>
          ))}
          <div style={{ fontSize: 12 }}>Bu iddiaları senaryoda kullanmadan önce kendiniz karar verin; dilerseniz ilgili olguları reddedin.</div>
        </div>
      )}

      {run.facts.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🔍</div>
          <strong>Olgu çıkarımı henüz yapılmadı</strong>
          <div>“Olgu Listesini Oluştur” düğmesi, indirilen kaynakları analiz eder. Her olgu için fact_id, alıntı ve kaynak saklanır; uydurma alıntılar otomatik tespit edilip “doğrulanamadı” olarak işaretlenir.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sorted.map((fact) => {
            const isEditing = editing[fact.fact_id] !== undefined;
            return (
              <article key={fact.fact_id} className={`fact-card ${fact.status}`}>
                <div className="fact-top">
                  <span className="fact-id">{fact.fact_id}</span>
                  <span className={`badge badge-${fact.confidence}`}>{CONFIDENCE_LABEL[fact.confidence]}</span>
                  <span className={`badge badge-${fact.kind}`}>{KIND_LABEL[fact.kind]}</span>
                  {fact.quote_verified ? <span className="quote-ok" title="Alıntı kaynak metninde bulundu">✓ alıntı doğrulandı</span> : <span className="quote-flag" title="Alıntı kaynak metninde birebir bulunamadı; dayanaksız olabilir">✕ alıntı doğrulanamadı</span>}
                  <div className="fact-state">
                    <div className="seg" role="group" aria-label={`${fact.fact_id} durumu`}>
                      <button className={fact.status === 'approved' ? 'on-approve' : ''} onClick={() => void setStatus(fact, 'approved')} aria-pressed={fact.status === 'approved'}>Onayla</button>
                      <button className={fact.status === 'pending' ? 'on-pending' : ''} onClick={() => void setStatus(fact, 'pending')} aria-pressed={fact.status === 'pending'}>Beklet</button>
                      <button className={fact.status === 'rejected' ? 'on-reject' : ''} onClick={() => void setStatus(fact, 'rejected')} aria-pressed={fact.status === 'rejected'}>Reddet</button>
                    </div>
                  </div>
                </div>

                {isEditing ? (
                  <textarea className="input statement-edit" value={editing[fact.fact_id]} autoFocus onChange={(e) => setEditing((m) => ({ ...m, [fact.fact_id]: e.target.value }))} onBlur={() => void saveStatement(fact)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing((m) => { const n = { ...m }; delete n[fact.fact_id]; return n; }); }} />
                ) : (
                  <div className="fact-statement" onDoubleClick={() => setEditing((m) => ({ ...m, [fact.fact_id]: fact.statement }))} title="Düzenlemek için çift tıklayın">{fact.statement}</div>
                )}

                <details className="fact-quote">
                  <summary>Alıntı ve kaynak</summary>
                  <blockquote>“{fact.quote}”</blockquote>
                  <div className="fact-src">
                    Kaynak:{' '}
                    {fact.source_url ? <a href={fact.source_url} target="_blank" rel="noreferrer noopener">{fact.source_title} ↗</a> : <span>{fact.source_title} (yapıştırılan metin)</span>}
                    {' '}· {KIND_LABEL[fact.kind]}
                    {fact.note && <> · Not: {fact.note}</>}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      )}

      <div className="section-divider" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12 }}>{approved > 0 ? `${approved} onaylı olgu senaryoya gidecek.` : 'Senaryoya geçmeden önce en az 1 olgu onaylayın.'}</span>
        <button className="btn btn-primary" onClick={onAdvance} disabled={approved === 0}>
          Senaryo Adımına Geç →
        </button>
      </div>
    </div>
  );
}
