import { useEffect, useState } from 'react';
import { api, ApiError, type ResearchRun } from '../api.js';
import { ErrorBanner, InfoBanner, Spinner, fmtDuration } from './common.js';

interface ScriptStepProps {
  run: ResearchRun;
  onRunChanged: (run: ResearchRun) => void;
  onAdvance: () => void;
}

export default function ScriptStep({ run, onRunChanged, onAdvance }: ScriptStepProps) {
  const approvedFacts = run.facts.filter((f) => f.status === 'approved');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [titleDirty, setTitleDirty] = useState(false);
  const [title, setTitle] = useState(run.script?.title ?? '');
  const [draft, setDraft] = useState<Record<string, { text: string; fact_ids: string }>>({});

  const approvedIds = new Set(approvedFacts.map((f) => f.fact_id));
  const factMap = new Map(run.facts.map((f) => [f.fact_id, f]));

  useEffect(() => {
    setTitle(run.script?.title ?? '');
    const next: Record<string, { text: string; fact_ids: string }> = {};
    for (const s of run.script?.sentences ?? []) next[s.id] = { text: s.text, fact_ids: s.fact_ids.join(', ') };
    setDraft(next);
    setDirtyIds(new Set());
    setTitleDirty(false);
  }, [run.script?.generated_at, run.script?.title, run.updated_at]);

  async function doGenerate() {
    if (run.script && !window.confirm('Yeni senaryo mevcut taslağın üstüne yazılacak ve denetim sonucu silinecek. Devam edilsin mi?')) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { run: updated } = await api.generateScript(run.id);
      onRunChanged(updated);
      setNotice('Senaryo taslağı yalnızca onaylı olgulardan üretildi. Cümleleri gözden geçirip “Değişiklikleri Kaydet”e basın, sonra denetime geçin.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Senaryo üretilemedi.');
    } finally {
      setBusy(false);
    }
  }

  function markDirty(sentenceId: string, patch: Partial<{ text: string; fact_ids: string }>) {
    setDraft((d) => ({ ...d, [sentenceId]: { ...d[sentenceId], ...patch } }));
    setDirtyIds((s) => new Set(s).add(sentenceId));
  }

  async function saveAll() {
    if (!run.script) return;
    setError(null);
    setSaving(true);
    try {
      const sentences = [...dirtyIds].map((id) => {
        const entry = draft[id];
        const fact_ids = entry.fact_ids.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
        return { id, text: entry.text.trim(), fact_ids };
      }).filter((s) => s.text.length > 0);
      const { run: updated } = await api.patchScript(run.id, { title: titleDirty ? title.trim() || run.script.title : undefined, sentences });
      onRunChanged(updated);
      setTitleDirty(false);
      setDirtyIds(new Set());
      setNotice('Değişiklikler kaydedildi. Denetim sonuçları sıfırlandı — tekrar denetleyin.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Değişiklikler kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  }

  async function removeSentence(sentenceId: string) {
    if (!window.confirm('Bu cümle senaryodan çıkarılsın mı?')) return;
    setError(null);
    try {
      const { run: updated } = await api.deleteSentence(run.id, sentenceId);
      onRunChanged(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cümle silinemedi.');
    }
  }

  const script = run.script;

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">3 · Senaryo</h3>
          <p className="panel-sub">Taslak yalnızca “Onaylı” işaretlediğiniz olgularla yazılır. Her cümlenin dayandığı olgular çiplerle gösterilir; bilinmeyen fact_id girerseniz kayıt reddedilir.</p>
        </div>
        <div className="toolbar">
          <span className="counter-pill counter-ok">{approvedFacts.length} onaylı olgu</span>
          {script && <span className="counter-pill">{script.sentences.length} cümle · ~{fmtDuration(script.estimated_seconds)}</span>}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && <InfoBanner tone="ok">{notice}</InfoBanner>}

      {approvedFacts.length === 0 && (
        <InfoBanner tone="warn">Onaylı olgu yok. 2. adıma dönüp en az bir olguyu “Onayla” ile işaretleyin. Senaryo dayanağı olmayan bilgiyi kabul etmez.</InfoBanner>
      )}

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void doGenerate()} disabled={busy || approvedFacts.length === 0}>
          {busy ? <><Spinner /> Senaryo yazılıyor…</> : script ? 'Yeniden Üret' : 'Senaryoyu Üret'}
        </button>
        {(dirtyIds.size > 0 || titleDirty) && (
          <button className="btn btn-secondary" onClick={() => void saveAll()} disabled={saving}>
            {saving ? <><Spinner dark /> Kaydediliyor…</> : `Değişiklikleri Kaydet${dirtyIds.size > 0 ? ` (${dirtyIds.size})` : ''}`}
          </button>
        )}
      </div>

      {script ? (
        <>
          <div className="card" style={{ boxShadow: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="f-label" htmlFor="script-title">Video başlığı</label>
            <input id="script-title" className="input" value={title} onChange={(e) => { setTitle(e.target.value); setTitleDirty(true); }} />
            {script.style_notes && <div className="f-hint">{script.style_notes}</div>}
            <div className="script-meta">
              <span>Hedef: {fmtDuration(run.target_seconds)}</span>
              <span>Tahmini: {fmtDuration(script.estimated_seconds)}</span>
              <span>Üretildi: {script.generated_at ? new Date(script.generated_at).toLocaleString('tr-TR') : '—'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {script.sentences.map((s, i) => {
              const entry = draft[s.id] ?? { text: s.text, fact_ids: s.fact_ids.join(', ') };
              return (
                <div key={s.id} className="sentence-row">
                  <div className="sentence-idx">{String(i + 1).padStart(2, '0')}</div>
                  <div className="sentence-main">
                    <textarea className="input sentence-text" value={entry.text} onChange={(e) => markDirty(s.id, { text: e.target.value })} rows={Math.max(1, Math.ceil(entry.text.length / 110))} aria-label={`Cümle ${i + 1}`} />
                    <div className="sentence-foot">
                      <span className="muted" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700 }}>Dayanak:</span>
                      {s.fact_ids.length === 0 ? (
                        <span className="fact-chip missing">DAYANAK YOK</span>
                      ) : (
                        s.fact_ids.map((fid) => {
                          const known = approvedIds.has(fid);
                          const f = factMap.get(fid);
                          return (
                            <span key={fid} className={`fact-chip${known ? '' : ' missing'}`} title={f ? f.statement : 'Olgu bulunamadı'}>
                              {fid}{known ? '' : ' ?'}
                            </span>
                          );
                        })
                      )}
                      <input className="input mono" style={{ fontSize: 11, padding: '4px 8px', width: 170 }} value={entry.fact_ids} onChange={(e) => markDirty(s.id, { fact_ids: e.target.value })} placeholder="F001, F003" aria-label="fact_id listesi" title="Virgülle ayırın — yalnızca onaylı olgu id’leri" />
                      <button className="icon-btn" title="Cümleyi sil" aria-label="Cümleyi sil" onClick={() => void removeSentence(s.id)}>✕</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty">
          <div className="empty-icon">✍️</div>
          <strong>Henüz senaryo yok</strong>
          <div>“Senaryoyu Üret” yalnızca onaylı olguları kullanır; model hiçbir bilgiyi dışarıdan eklememesi için yönlendirilir ve çıktıdaki bilinmeyen fact_id’ler otomatik atılır.</div>
        </div>
      )}

      <div className="section-divider" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12 }}>Kaydetmeden denetime geçerseniz son kaydedilmiş hâli denetlenir.</span>
        <button className="btn btn-primary" onClick={onAdvance} disabled={!script}>
          Denetim Adımına Geç →
        </button>
      </div>
    </div>
  );
}
