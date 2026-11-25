import { useState } from 'react';
import { api, ApiError, type ResearchRun } from '../api.js';
import { CHECK_LABEL, ErrorBanner, InfoBanner, Spinner } from './common.js';

interface FactcheckStepProps {
  run: ResearchRun;
  onRunChanged: (run: ResearchRun) => void;
  onAdvance: () => void;
}

export default function FactcheckStep({ run, onRunChanged, onAdvance }: FactcheckStepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const script = run.script;
  const report = run.factcheck;
  const facts = new Map(run.facts.map((f) => [f.fact_id, f]));

  async function check() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { run: updated } = await api.factcheck(run.id);
      onRunChanged(updated);
      if (updated.factcheck?.ok) setNotice('Denetim tamamlandı: bütün cümleler kaynaklı ve desteklendi. Yine de metni ve dayanakları gözden geçirin.');
      else setNotice('Denetim tamamlandı ancak uyarılar var. Bu taslak hazır olarak işaretlenmedi; aşağıdaki cümleleri düzeltip yeniden denetleyin.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Denetim tamamlanamadı.');
    } finally {
      setBusy(false);
    }
  }

  if (!script) {
    return <div className="panel"><InfoBanner tone="warn">Denetimden önce 3. adımda senaryo üretin.</InfoBanner></div>;
  }

  const checks = script.sentences;
  const okToExport = Boolean(report?.ok) && checks.length > 0 && checks.every((s) => s.check === 'supported');

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">4 · Fact-check / Editör</h3>
          <p className="panel-sub">Her cümle dayandığı fact_id’ler ve kaynak metniyle karşılaştırılır. Önce deterministik kontroller (boş dayanak, reddedilmiş olgu, sayılar), ardından tek bir LLM semantik denetimi çalışır.</p>
        </div>
        {report && <span className={`counter-pill ${report.ok ? 'counter-ok' : 'counter-warn'}`}>{report.ok ? 'Denetim başarılı' : 'Uyarılar var'}</span>}
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && <InfoBanner tone={report?.ok ? 'ok' : 'warn'}>{notice}</InfoBanner>}
      {report?.ok === false && <InfoBanner tone="warn"><strong>Bu senaryo hazır değil.</strong> Desteksiz, çelişkili, belirsiz veya denetlenememiş cümleleri düzeltmeden dışa aktarmak, onları doğrulanmış yapmaz. Düzeltmeden sonra yeniden denetleyin.</InfoBanner>}

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void check()} disabled={busy}>
          {busy ? <><Spinner /> Kaynaklarla karşılaştırılıyor…</> : report ? 'Yeniden Denetle' : 'Fact-check Başlat'}
        </button>
        {report && <span className="muted" style={{ fontSize: 12 }}>Son denetim: {new Date(report.ran_at).toLocaleString('tr-TR')}</span>}
      </div>

      {!report ? (
        <div className="empty">
          <div className="empty-icon">🔬</div>
          <strong>Denetim henüz çalıştırılmadı</strong>
          <div>Denetim modeli kaynak metnini tekrar okur; API/model hatası durumunda sonuç “hazır” sayılmaz.</div>
        </div>
      ) : (
        <>
          <div className="summary-grid">
            <div className="summary-cell"><div className="summary-num" style={{ color: 'var(--green)' }}>{report.supported}</div><div className="summary-label">Desteklendi</div></div>
            <div className="summary-cell"><div className="summary-num" style={{ color: 'var(--red)' }}>{report.unsupported}</div><div className="summary-label">Desteksiz</div></div>
            <div className="summary-cell"><div className="summary-num" style={{ color: 'var(--red)' }}>{report.contradicted}</div><div className="summary-label">Çelişkili</div></div>
            <div className="summary-cell"><div className="summary-num" style={{ color: 'var(--amber)' }}>{report.uncertain}</div><div className="summary-label">Belirsiz</div></div>
            <div className="summary-cell"><div className="summary-num" style={{ color: 'var(--muted)' }}>{report.unchecked}</div><div className="summary-label">Denetlenemedi</div></div>
          </div>

          <div className="details-box">
            <strong>Denetim özeti:</strong> {report.summary}
            {report.ran_at && <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>Tarih: {new Date(report.ran_at).toLocaleString('tr-TR')}</div>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {checks.map((s, i) => (
              <article key={s.id} className={`check-row check-${s.check}`}>
                <span className={`check-badge cb-${s.check}`}>{CHECK_LABEL[s.check]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="check-text"><span className="mono muted" style={{ fontSize: 10.5 }}>#{String(i + 1).padStart(2, '0')} </span>{s.text}</div>
                  <div className="sentence-foot" style={{ marginTop: 6 }}>
                    {s.fact_ids.length > 0 ? s.fact_ids.map((fid) => {
                      const f = facts.get(fid);
                      return <span key={fid} className={`fact-chip${f?.status !== 'approved' ? ' missing' : ''}`} title={f ? `${f.statement} — ${f.source_title}` : 'Olgu bulunamadı'}>{fid}</span>;
                    }) : <span className="fact-chip missing">DAYANAK YOK</span>}
                  </div>
                  {s.check_note && <div className="check-note">{s.check_note}</div>}
                  {s.fact_ids.map((fid) => {
                    const f = facts.get(fid);
                    if (!f) return <div key={fid} className="check-note">{fid}: olgu kaydı bulunamadı.</div>;
                    return (
                      <details key={fid} className="fact-quote" style={{ marginTop: 6 }}>
                        <summary>{fid} · {f.source_title}</summary>
                        <blockquote>“{f.quote}”</blockquote>
                        <div className="fact-src">{f.source_url ? <a href={f.source_url} target="_blank" rel="noreferrer noopener">Kaynağı aç ↗</a> : 'Yapıştırılan kaynak'} · Alıntı {f.quote_verified ? 'doğrulandı' : 'doğrulanamadı'}</div>
                      </details>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>

          {okToExport ? (
            <InfoBanner tone="ok">Denetim raporu bütün cümlelerin desteklendiğini bildiriyor. Bu, model hatasızlığı garantisi değildir; kaynak bağlantılarını yine de inceleyin.</InfoBanner>
          ) : (
            <InfoBanner tone="warn">Bu çalışma “denetimi geçti” olarak işaretlenemez. Export, uyarıları ve dayanak eşlemesini görünür tutar; kullanıcıya gizlemez.</InfoBanner>
          )}
        </>
      )}

      <div className="section-divider" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12 }}>Senaryoyu ve denetim notlarını dışa aktarabilirsiniz; sorunlar export içinde açıkça korunur.</span>
        <button className="btn btn-primary" onClick={onAdvance} disabled={!script}>
          Dışa Aktar →
        </button>
      </div>
    </div>
  );
}
