import { type ReactNode } from 'react';

export function Spinner({ dark = false }: { dark?: boolean }) {
  return <span className={`spinner${dark ? ' spinner-dark' : ''}`} aria-hidden="true" />;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <span className="banner-icon">⚠️</span>
      <div>
        <div>{message}</div>
        {onRetry && (
          <button className="btn btn-sm btn-danger" style={{ marginTop: 8 }} onClick={onRetry}>
            Tekrar dene
          </button>
        )}
      </div>
    </div>
  );
}

export function InfoBanner({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  const icon = tone === 'warn' ? '🟡' : tone === 'ok' ? '✅' : 'ℹ️';
  return (
    <div className={`banner banner-${tone}`}>
      <span className="banner-icon">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

export const CONFIDENCE_LABEL: Record<string, string> = { high: 'Yüksek güven', medium: 'Orta güven', low: 'Düşük güven' };
export const KIND_LABEL: Record<string, string> = { fact: 'Olgu', inference: 'Çıkarım', unverified: 'Doğrulanamadı' };
export const CHECK_LABEL: Record<string, string> = {
  supported: 'Desteklendi',
  unsupported: 'Desteksiz',
  contradicted: 'Çelişkili',
  uncertain: 'Belirsiz',
  unchecked: 'Denetlenmedi',
};

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} dk ${s} sn` : `${s} sn`;
}

export function factStatusOf(run: { facts: Array<{ status: string }> }) {
  const approved = run.facts.filter((f) => f.status === 'approved').length;
  return { approved, total: run.facts.length };
}
