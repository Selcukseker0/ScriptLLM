import { useState } from 'react';
import { api, ApiError } from '../api.js';
import { Spinner, ErrorBanner } from './common.js';

interface HomeProps {
  onCreated: (id: string) => void;
}

export default function Home({ onCreated }: HomeProps) {
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('Genel izleyici');
  const [tone, setTone] = useState('Bilgilendirici');
  const [minutes, setMinutes] = useState('10');
  const [urls, setUrls] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const urlList = urls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    const pasted = pasteText.trim() ? [{ title: pasteTitle.trim() || 'Yapıştırılan kaynak', text: pasteText.trim() }] : [];
    setBusy(true);
    try {
      const { run } = await api.createRun({
        topic: topic.trim(),
        audience: audience.trim() || 'Genel izleyici',
        tone: tone.trim() || 'Bilgilendirici',
        target_seconds: Math.round(Number(minutes) * 60),
        urls: urlList,
        pasted_sources: pasted,
      });
      onCreated(run.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Beklenmeyen bir hata oluştu.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="hero">
        <div>
          <div className="eyebrow">Araştır · Doğrula · Senaryolaştır</div>
          <h1 className="hero-title">
            Her cümlesi <em>dayanağına</em> bağlı Türkçe senaryolar.
          </h1>
          <p className="hero-sub">
            Siz yalnızca konuyu girin. Otomatik ajan kaynak arar ve indirir, alıntısı doğrulanan olgulardan senaryo üretir,
            ardından her cümleyi denetler. Sonuçları isterseniz sonradan inceleyip düzenleyebilirsiniz. Kaynak veya model
            hatasında uydurma bilgiyle devam etmez; açıkça durur.
          </p>
          <div className="pipeline" aria-label="İş akışı">
            {[
              ['1', 'Kaynakları topla', 'URL arama/indirme veya elle metin yapıştırma'],
              ['2', 'Olguları çıkar & onayla', 'Her olgu: fact_id + alıntı + kaynak + güven düzeyi'],
              ['3', 'Senaryoyu üret', 'Yalnızca onaylı olgular kullanılır'],
              ['4', 'Fact-check & dışa aktar', 'Cümle ⟷ olgu eşlemesi, Markdown/JSON'],
            ].map(([n, title, sub], i, arr) => (
              <div key={n}>
                <div className="pipe-step">
                  <div className="pipe-num">{n}</div>
                  <div className="pipe-body">
                    <strong>{title}</strong>
                    <span>{sub}</span>
                  </div>
                </div>
                {i < arr.length - 1 && <div className="pipe-line" />}
              </div>
            ))}
          </div>
        </div>

        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2 className="card-title">Yeni Araştırma</h2>
          <p className="card-sub">Konuyu verin; ajan araştırma, senaryo ve denetimi otomatik çalıştırsın. URL/metin eklemek isteğe bağlıdır.</p>

          {error && <div style={{ marginBottom: 12 }}><ErrorBanner message={error} /></div>}

          <div className="form-grid">
            <div className="form-field full">
              <label className="f-label" htmlFor="topic">Konu *</label>
              <input id="topic" className="input" required minLength={3} maxLength={300} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Örn. Türkiye’de deprem gerçeği: bilim ne diyor?" />
            </div>
            <div className="form-field">
              <label className="f-label" htmlFor="audience">Hedef kitle</label>
              <input id="audience" className="input" maxLength={200} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Genel izleyici" />
            </div>
            <div className="form-field">
              <label className="f-label" htmlFor="tone">Ton</label>
              <select id="tone" className="input" value={tone} onChange={(e) => setTone(e.target.value)}>
                {['Bilgilendirici', 'Merak uyandırıcı', 'Ciddi / belgesel', 'Samimi / sohbet', 'Analitik / akademik'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label className="f-label" htmlFor="minutes">Hedef süre</label>
              <select id="minutes" className="input" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
                {['3', '5', '8', '10', '15', '20', '30'].map((m) => (
                  <option key={m} value={m}>~{m} dakika</option>
                ))}
              </select>
            </div>
            <div className="form-field full">
              <label className="f-label" htmlFor="urls">Kaynak URL’leri <span className="opt">(satır başına bir tane, en fazla 12 — opsiyonel)</span></label>
              <textarea id="urls" className="input mono" style={{ fontSize: 12 }} rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={'https://tr.wikipedia.org/wiki/…\nhttps://www.example.com/haber/…'} />
              <div className="f-hint">Kaynaklar oluşturulduktan sonra “Kaynakları Getir” ile indirilir. Erişilemeyen kaynaklar açıkça işaretlenir.</div>
            </div>
            <div className="form-field full">
              <label className="f-label" htmlFor="pasteTitle">Yapıştırılacak kaynak başlığı <span className="opt">(opsiyonel)</span></label>
              <input id="pasteTitle" className="input" maxLength={300} value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="Örn. TÜİK basın bülteni, Kasım 2026" />
            </div>
            <div className="form-field full">
              <label className="f-label" htmlFor="pasteText">Kaynak metni yapıştır <span className="opt">(opsiyonel, en az 50 karakter)</span></label>
              <textarea id="pasteText" className="input" rows={4} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="İnternetten erişilemeyen ya da PDF’ten aldığınız metni buraya yapıştırın…" />
            </div>
          </div>

          <button className="btn btn-primary btn-block" type="submit" disabled={busy || topic.trim().length < 3} style={{ marginTop: 16 }}>
            {busy ? <><Spinner /> Ajan başlatılıyor…</> : 'Konuyu Ver ve Otomatik Başlat →'}
          </button>
        </form>
      </div>

      <div className="details-box">
        <strong>Otomatik ama izlenebilir.</strong>
        <div style={{ marginTop: 4 }}>
          Researcher (kaynak→olgu), Scriptwriter (doğrulanmış olgu→senaryo) ve Fact-checker (senaryo→olgu karşılaştırması) ayrı veri
          şemalarıyla arka arkaya çalışır. Siz aşamaları tek tek başlatmak zorunda değilsiniz; tamamlanan tüm kaynakları, olguları,
          cümle-dayanak eşleşmelerini ve uyarıları sonradan inceleyip düzenleyebilirsiniz.
        </div>
      </div>
    </div>
  );
}
