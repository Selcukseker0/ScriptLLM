import { describe, it, expect } from 'vitest';
import { assessSourceRelevance } from '../server/research/relevance.js';

const diskSource = {
  title: 'DİSK tarihi',
  contentText: 'Türkiye Devrimci İşçi Sendikaları Konfederasyonu (DİSK), 1967 yılında kuruldu. Sendikanın tarihi ve örgütlenmesi hakkında bilgi.',
};

describe('konu-kaynak alaka kapısı', () => {
  it('Türkiye kelimesi ortak diye deprem konusu ile DİSK kaynağını alakalı saymaz', () => {
    const result = assessSourceRelevance("Türkiye'de deprem güvenliği", diskSource);
    expect(result.relevant).toBe(false);
    expect(result.reason).toContain('bulunmadı');
  });

  it('Türkçe deprem ve güvenlik kavramlarını ilgili kaynaktan yakalar', () => {
    const result = assessSourceRelevance('Türkiye deprem güvenliği', {
      title: 'Deprem güvenliği ve bina dayanıklılığı',
      contentText: 'Deprem riskini azaltmak için yapı güvenliği ve bina dayanıklılığı önemlidir. AFAD hazırlık önerileri yayımladı.',
    });
    expect(result.relevant).toBe(true);
    expect(result.matched.length).toBeGreaterThan(0);
  });

  it('sendika metnindeki tekrarlı genel güvenlik kelimeleri deprem konusunu karşılamaz', () => {
    const result = assessSourceRelevance('Türkiye deprem güvenliği', {
      title: 'DİSK tarihi',
      contentText: 'Türkiye Devrimci İşçi Sendikaları Konfederasyonu 1967 yılında kuruldu. İşçi sağlığı ve güvenliği için çalışmalar yaptı. İş güvenliği, güvenlik ve çalışma koşulları konularını ele aldı.',
    });
    expect(result.relevant).toBe(false);
  });

  it('tek genel ülke adı geçmesi kaynak alaka kapısından geçirmez', () => {
    const result = assessSourceRelevance('Türkiye deprem güvenliği', {
      title: 'Türkiye’de sendikacılık',
      contentText: 'Türkiye’de işçi hareketleri ve sendikal örgütlenmelerin tarihi.',
    });
    expect(result.relevant).toBe(false);
  });
});
