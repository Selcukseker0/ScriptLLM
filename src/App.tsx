import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ConfigResponse, type ResearchRun, type RunSummary } from './api.js';
import Sidebar from './components/Sidebar.js';
import Home from './components/Home.js';
import SourcesStep from './components/SourcesStep.js';
import FactsStep from './components/FactsStep.js';
import ScriptStep from './components/ScriptStep.js';
import FactcheckStep from './components/FactcheckStep.js';
import ExportStep from './components/ExportStep.js';
import { ErrorBanner, Spinner, fmtDate, fmtDuration } from './components/common.js';

const STEPS = [
  { id: 'sources', name: 'Kaynaklar', desc: 'Bul ve indir' },
  { id: 'facts', name: 'Olgu listesi', desc: 'İncele ve onayla' },
  { id: 'script', name: 'Senaryo', desc: 'Yaz ve düzenle' },
  { id: 'factcheck', name: 'Denetim', desc: 'Kaynaklarla karşılaştır' },
  { id: 'export', name: 'Dışa aktar', desc: 'MD / JSON indir' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

function highestAvailable(run: ResearchRun): number {
  if (run.factcheck) return 4;
  if (run.script) return 3;
  if (run.facts.length > 0) return 2;
  return 1;
}

function doneAt(run: ResearchRun, index: number): boolean {
  if (index === 0) return run.sources.some((s) => s.status === 'ok');
  if (index === 1) return run.facts.some((f) => f.status === 'approved');
  if (index === 2) return Boolean(run.script);
  if (index === 3) return Boolean(run.factcheck);
  return Boolean(run.factcheck);
}

export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [step, setStep] = useState<StepId>('sources');
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const reloadRuns = useCallback(async () => {
    try {
      const data = await api.listRuns();
      setRuns(data.runs);
    } catch (err) {
      setGlobalError(err instanceof ApiError ? err.message : 'Çalışmalar yüklenemedi.');
    }
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([api.config(), api.listRuns()])
      .then(([cfg, data]) => {
        if (!live) return;
        setConfig(cfg);
        setRuns(data.runs);
      })
      .catch((err) => {
        if (live) setGlobalError(err instanceof ApiError ? err.message : 'Sunucuya bağlanılamadı.');
      })
      .finally(() => { if (live) setInitializing(false); });
    return () => { live = false; };
  }, [refreshKey]);

  const loadRun = useCallback(async (id: string) => {
    setActiveId(id);
    setLoading(true);
    setGlobalError(null);
    try {
      const { run: loaded } = await api.getRun(id);
      setRun(loaded);
      const idx = highestAvailable(loaded);
      setStep(STEPS[Math.min(idx - 1, 4)].id);
      await reloadRuns();
    } catch (err) {
      setRun(null);
      setGlobalError(err instanceof ApiError ? err.message : 'Çalışma açılamadı.');
    } finally {
      setLoading(false);
    }
  }, [reloadRuns]);

  function onRunChanged(updated: ResearchRun) {
    setRun(updated);
    void reloadRuns();
  }

  async function createRun(id: string) {
    await reloadRuns();
    await loadRun(id);
  }

  async function deleteRun(id: string) {
    try {
      await api.deleteRun(id);
      setRuns((items) => items.filter((item) => item.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setRun(null);
      }
    } catch (err) {
      setGlobalError(err instanceof ApiError ? err.message : 'Çalışma silinemedi.');
    }
  }

  function newRun() {
    setActiveId(null);
    setRun(null);
    setGlobalError(null);
  }

  function goToStep(next: StepId) {
    const idx = STEPS.findIndex((x) => x.id === next);
    if (run && idx <= highestAvailable(run)) setStep(next);
  }

  if (initializing) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}><Spinner dark /> <span style={{ marginLeft: 10 }}>ScriptLLM yükleniyor…</span></div>;
  }

  return (
    <div className="app-shell">
      <Sidebar runs={runs} activeId={activeId} config={config} onNew={newRun} onOpen={(id) => void loadRun(id)} onDelete={(id) => void deleteRun(id)} />
      <main className="main">
        {globalError && <div style={{ marginBottom: 16 }}><ErrorBanner message={globalError} onRetry={() => setRefreshKey((k) => k + 1)} /></div>}
        {loading ? (
          <div className="empty"><Spinner dark /><div style={{ marginTop: 8 }}>Çalışma açılıyor…</div></div>
        ) : run ? (
          <>
            <header className="run-header">
              <div>
                <div className="eyebrow">Araştırma çalışması</div>
                <h1 className="run-topic">{run.topic}</h1>
                <div className="meta-pills">
                  <span className="pill pill-accent">{run.audience}</span>
                  <span className="pill">{run.tone}</span>
                  <span className="pill">Hedef ~{fmtDuration(run.target_seconds)}</span>
                  <span className="pill">Güncellendi {fmtDate(run.updated_at)}</span>
                </div>
              </div>
              {run.script && (
                <div className="toolbar">
                  <a className="btn btn-secondary btn-sm" href={api.exportMarkdownUrl(run.id)} download>↓ .md</a>
                  <a className="btn btn-secondary btn-sm" href={api.exportJsonUrl(run.id)} download>↓ .json</a>
                </div>
              )}
            </header>

            <nav className="stepper" aria-label="Araştırma adımları">
              {STEPS.map((s, i) => {
                const available = i <= highestAvailable(run);
                const done = doneAt(run, i);
                return (
                  <button key={s.id} className={`step-tab${step === s.id ? ' active' : ''}${done ? ' done' : ''}`} onClick={() => goToStep(s.id)} disabled={!available} aria-current={step === s.id ? 'step' : undefined}>
                    <span className="step-bubble">{done ? '✓' : i + 1}</span>
                    <span><span className="step-name">{s.name}</span><br /><span className="step-desc">{s.desc}</span></span>
                  </button>
                );
              })}
            </nav>

            {step === 'sources' && <SourcesStep run={run} config={config} onRunChanged={onRunChanged} onAdvance={() => goToStep('facts')} />}
            {step === 'facts' && <FactsStep run={run} onRunChanged={onRunChanged} onAdvance={() => goToStep('script')} />}
            {step === 'script' && <ScriptStep run={run} onRunChanged={onRunChanged} onAdvance={() => goToStep('factcheck')} />}
            {step === 'factcheck' && <FactcheckStep run={run} onRunChanged={onRunChanged} onAdvance={() => goToStep('export')} />}
            {step === 'export' && <ExportStep run={run} />}
          </>
        ) : (
          <Home onCreated={(id) => void createRun(id)} />
        )}
      </main>
    </div>
  );
}
