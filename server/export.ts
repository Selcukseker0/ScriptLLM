import type { ResearchRun } from '../shared/schema.js';
import { ResearchRunSchema } from '../shared/schema.js';

const trTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'long', timeStyle: 'short' }) : '—');

/** Araştırma + senaryoyu tek bir taşınabilir Markdown belgesine dönüştürür */
export function toMarkdown(run: ResearchRun): string {
  const lines: string[] = [];
  const usedFactIds = new Set(run.script?.sentences.flatMap((s) => s.fact_ids) ?? []);

  lines.push(`# ${run.script?.title || run.topic}`);
  lines.push('');
  lines.push(`**Konu:** ${run.topic}  `);
  lines.push(`**Hedef kitle:** ${run.audience}  `);
  lines.push(`**Ton:** ${run.tone}  `);
  lines.push(`**Hedef süre:** ${Math.floor(run.target_seconds / 60)} dk ${run.target_seconds % 60} sn  `);
  lines.push(`**Oluşturulma:** ${trTime(run.created_at)} · ScriptLLM v1`);
  lines.push('');
  lines.push('> Bu belge yalnızca listelenen kaynaklara dayanır. Kaynakta bulunamayan iddialar senaryoya dâhil edilmemiştir. ');
  lines.push('');

  lines.push('## 1. Kaynaklar');
  lines.push('');
  if (run.sources.length === 0) {
    lines.push('_Kaynak kaydedilmemiş._');
  } else {
    run.sources.forEach((s, i) => {
      const status = s.status === 'ok' ? 'indirildi' : s.status === 'failed' ? `erişilemedi (${s.error ?? 'bilinmeyen hata'})` : 'bekliyor';
      lines.push(`**K${i + 1}.** ${s.title}  `);
      lines.push(`  - URL: ${s.url ?? '(elle yapıştırılan metin)'}`);
      lines.push(`  - Durum: ${status} · Alınan: ${trTime(s.fetchedAt)}`);
      if (s.contentTruncated) lines.push('  - Not: içerik uzunluk sınırı nedeniyle kısaltıldı');
    });
  }
  lines.push('');

  lines.push('## 2. Olgu Listesi (kayıtlı dayanaklar)');
  lines.push('');
  if (run.facts.length === 0) {
    lines.push('_Olgu çıkarımı yapılmamış._');
  } else {
    for (const f of run.facts) {
      const state = f.status === 'approved' ? '✅ onaylı' : f.status === 'rejected' ? '❌ reddedildi' : '⏳ bekliyor';
      const kind = f.kind === 'fact' ? 'olgu' : f.kind === 'inference' ? 'çıkarım' : 'DOĞRULANAMADI';
      lines.push(`### ${f.fact_id} · ${kind} · güven: ${f.confidence} · ${state}`);
      lines.push('');
      lines.push(f.statement);
      lines.push('');
      lines.push(`- Kaynak: [${f.source_title}](${f.source_url ?? '#'})`);
      lines.push(`- Alıntı: “${f.quote}”`);
      lines.push(`- Alıntı doğrulandı: ${f.quote_verified ? 'evet' : 'HAYIR — kaynakta birebir bulunamadı'}`);
      if (f.note) lines.push(`- Not: ${f.note}`);
      lines.push('');
    }
  }

  if (run.contradictions.length > 0) {
    lines.push('## 3. Çelişkili Konular (karar için kullanıcı incelemeli)');
    lines.push('');
    for (const c of run.contradictions) {
      lines.push(`### ${c.id} · ${c.topic}`);
      for (const p of c.positions) {
        lines.push(`- **${p.source_title}**${p.source_url ? ` (${p.source_url})` : ''}: ${p.statement}`);
      }
      if (c.note) lines.push(`- Not: ${c.note}`);
      lines.push('');
    }
  }

  lines.push('## 4. Senaryo');
  lines.push('');
  if (!run.script || run.script.sentences.length === 0) {
    lines.push('_Senaryo üretilmemiş._');
  } else {
    for (const s of run.script.sentences) {
      const refs = s.fact_ids.length ? ` ⟵ ${s.fact_ids.join(', ')}` : ' ⟵ DAYANAK YOK';
      lines.push(`${s.text}  ${refs}`);
      lines.push('');
    }
    if (run.script.estimated_seconds) {
      lines.push(`_Tahmini süre: ${Math.floor(run.script.estimated_seconds / 60)} dk ${run.script.estimated_seconds % 60} sn_`);
      lines.push('');
    }
  }

  if (run.factcheck) {
    lines.push('## 5. Denetim Sonucu (fact-check)');
    lines.push('');
    lines.push(`**${run.factcheck.ok ? '✅ Denetim temiz' : '⚠️ Denetim uyarı/hata buldu'}** — ${run.factcheck.summary}`);
    lines.push('');
    lines.push(`desteklenen: ${run.factcheck.supported} · desteksiz: ${run.factcheck.unsupported} · çelişkili: ${run.factcheck.contradicted} · belirsiz: ${run.factcheck.uncertain} · denetlenmemiş: ${run.factcheck.unchecked}`);
    lines.push('');
    if (run.script) {
      for (const s of run.script.sentences) {
        if (s.check === 'supported') continue;
        lines.push(`- ${s.id} [${s.check}] ${s.text.slice(0, 140)}${s.text.length > 140 ? '…' : ''}${s.check_note ? ` — ${s.check_note}` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('## 6. Cümle ⟷ Dayanak Eşlemesi');
  lines.push('');
  if (run.script) {
    lines.push('| Cümle | Dayanaklar | Denetim |');
    lines.push('|-------|-----------|---------|');
    for (const s of run.script.sentences) {
      const text = s.text.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
      lines.push(`| ${s.id}: ${text}${s.text.length > 120 ? '…' : ''} | ${s.fact_ids.join(', ') || '—'} | ${s.check} |`);
    }
    lines.push('');
  }

  lines.push('## 7. Senaryoda Gerçekte Kullanılan Dayanaklar');
  lines.push('');
  const used = run.facts.filter((f) => usedFactIds.has(f.fact_id));
  if (used.length === 0) {
    lines.push('_Senaryoda kullanılan dayanak yok._');
  } else {
    for (const f of used) {
      lines.push(`- **${f.fact_id}** → [${f.source_title}](${f.source_url ?? '#'})`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('ScriptLLM ile üretildi. Üretilen her iddianın dayanağı yukarıda listelenmiştir; listelenmeyen bilgi senaryoya girmemiştir.');
  return lines.join('\n');
}

/** Şeması doğrulanmış, kararlı JSON dışa aktarım */
export function toJson(run: ResearchRun): string {
  const parsed = ResearchRunSchema.parse(run);
  return JSON.stringify(parsed, null, 2);
}
