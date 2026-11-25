import type { ConfigResponse, RunSummary } from '../api.js';
import { fmtDate } from './common.js';

interface SidebarProps {
  runs: RunSummary[];
  activeId: string | null;
  config: ConfigResponse | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

function runDot(r: RunSummary): { cls: string; title: string } {
  if (r.factcheck_ok === true) return { cls: 'dot-green', title: 'Denetim temiz' };
  if (r.factcheck_ok === false) return { cls: 'dot-red', title: 'Denetim uyarı buldu' };
  if (r.has_script) return { cls: 'dot-amber', title: 'Senaryo var, denetlenmedi' };
  if (r.approved_fact_count > 0) return { cls: 'dot-amber', title: 'Olgu onayı sürüyor' };
  return { cls: 'dot-gray', title: 'Kaynak/olgu aşamasında' };
}

export default function Sidebar({ runs, activeId, config, onNew, onOpen, onDelete }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">S</div>
        <div>
          <div className="brand-name">ScriptLLM</div>
          <div className="brand-tag">Kaynaklı Araştırma & Senaryo</div>
        </div>
      </div>

      <button className="btn btn-primary btn-block sidebar-new" onClick={onNew}>
        <span aria-hidden="true">＋</span> Yeni Araştırma
      </button>

      <div className="run-list-label">Çalışmalarım ({runs.length})</div>
      <div className="run-list" role="list">
        {runs.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--sidebar-muted)', padding: '10px 4px', lineHeight: 1.6 }}>
            Henüz çalışma yok. “Yeni Araştırma” ile ilk kaynaklı çalışmanızı başlatın.
          </div>
        )}
        {runs.map((r) => {
          const dot = runDot(r);
          return (
            <div key={r.id} className={`run-item${activeId === r.id ? ' active' : ''}`} role="listitem" style={{ position: 'relative' }}>
              <button
                className="btn-icon"
                style={{ position: 'absolute', top: 6, right: 6, fontSize: 13 }}
                title="Çalışmayı sil"
                aria-label="Çalışmayı sil"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`“${r.topic.slice(0, 80)}” çalışması kalıcı olarak silinsin mi?`)) onDelete(r.id);
                }}
              >
                🗑
              </button>
              <button className="run-item" style={{ border: 'none', background: 'transparent', padding: 0 }} onClick={() => onOpen(r.id)}>
                <span className="run-item-title">{r.topic}</span>
                <span className="run-item-meta">
                  <span className={`dot ${dot.cls}`} title={dot.title} />
                  <span>{fmtDate(r.updated_at)}</span>
                  <span>· {r.ok_source_count}/{r.source_count} kaynak</span>
                  <span>· {r.approved_fact_count}/{r.fact_count} olgu</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        {config ? (
          <>
            <div className="config-line">
              <span aria-hidden="true" className={config.llm.configured ? 'config-ok' : 'config-warn'}>
                {config.llm.configured ? '●' : '○'}
              </span>
              <span>
                LLM: <strong>{config.llm.configured ? `${config.llm.provider} · ${config.llm.model}` : 'yapılandırılmadı'}</strong>
                {!config.llm.configured && (
                  <>
                    <br />
                    <code>.env</code> içine <code>LLM_API_KEY</code> ekleyin veya <code>LLM_PROVIDER=ollama</code> kullanın
                  </>
                )}
              </span>
            </div>
            <div className="config-line">
              <span aria-hidden="true" className={config.search.configured ? 'config-ok' : 'config-warn'}>
                {config.search.configured ? '●' : '○'}
              </span>
              <span>
                Arama: <strong>{config.search.provider === 'none' ? 'kapalı' : config.search.detail}</strong>
              </span>
            </div>
            <div className="config-line" style={{ color: 'var(--sidebar-muted)' }}>
              Anahtarlar yalnızca sunucuda <code>.env</code> içinde tutulur; arayüze gönderilmez.
            </div>
          </>
        ) : (
          <div>Yapılandırma yükleniyor…</div>
        )}
      </div>
    </aside>
  );
}
