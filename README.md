# ScriptLLM

Türkçe, kaynak odaklı araştırma ve senaryo hazırlama web uygulaması. Her olgu kaynak URL’si ve dayanak alıntısıyla saklanır; senaryo yalnızca kullanıcı tarafından onaylanan olgulardan üretilir ve her cümle yeniden denetlenir.

> **Kapsam:** Bu uygulama yalnızca araştırma notları ve senaryo metni üretir. Video, seslendirme, görsel, altyazı veya YouTube yüklemesi oluşturmaz.

## Gereksinimler

- Node.js 20 veya üzeri (Node 22 önerilir)
- npm
- Senaryo/araştırma/denetim için OpenAI-uyumlu LLM API erişimi **veya** yerelde çalışan Ollama modeli. Üç aşama da kullanıcı tarafından ayrı ayrı başlatılır.
- Web araması için ayrıca API anahtarı isteğe bağlıdır; anahtar olmadan sınırlı Wikipedia API sağlayıcısı kullanılabilir. URL ekleme ve metin yapıştırma her zaman kullanılabilir.

## Kurulum ve çalıştırma

```bash
npm install
cp .env.example .env
# .env dosyasında sağlayıcı/model/anahtar değerlerinizi düzenleyin
npm run dev
```

Vite arayüzü `http://localhost:5173`, Express API `http://localhost:5174` üzerinde çalışır. Arayüz API çağrılarını Vite üzerinden göreli `/api` URL’leriyle yapar; LLM ve arama sırları tarayıcıya gönderilmez. Üretim derlemesi ve çalıştırması:

```bash
npm run build
npm start
```

Üretim sunucusu `PORT` (varsayılan 5174) üzerinde API ve `dist/` arayüzünü birlikte sunar. Sunucu `0.0.0.0` üzerinde dinler. Çalışmalar yerel olarak `data/runs/<id>.json` dosyalarına atomik biçimde kaydedilir. Başka bir konum için `DATA_DIR` ayarlayın. `data/` ve `.env` Git’e alınmaz.

## LLM yapılandırması

### OpenAI-uyumlu API

`.env` içine `LLM_PROVIDER=openai`, `LLM_API_KEY=...` ve isteğe bağlı `LLM_MODEL` / `LLM_BASE_URL` girin. `OPENAI_API_KEY` de desteklenir. API kullanımı sağlayıcının ücret, oran sınırı ve kullanım koşullarına tabidir; ScriptLLM ücretsiz veya sınırsız kullanım vaat etmez.

### Ollama

Ollama’yı bilgisayarınızda çalıştırın ve gerekli modeli indirin. `.env`:

```env
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1
```

Ollama yerel ağ uç noktasında API anahtarı gerekmez. Performans/kullanılabilirlik makineye ve modele bağlıdır. Sağlayıcı hatasında otomatik başka modele geçilmez; işlem açık hata ile durur.

## Web araması

- `TAVILY_API_KEY`: Tavily Search API — kullanım planı, kota ve ücretleri Tavily belirler.
- `BRAVE_API_KEY`: Brave Search API — kullanım planı, kota ve ücretleri Brave belirler.
- Anahtar yoksa Wikipedia API (Türkçe/İngilizce) sınırlı kapsamlı yardımcı arama olarak kullanılır; her konu için yeterli değildir.
- `SEARCH_PROVIDER=tavily|brave|wikipedia|none` ile açık sağlayıcı seçilebilir. Sağlayıcı anahtarı eksikse UI bunu belirtir. Google SERP kazıma yapılmaz.
- URL arama sonuçları yalnızca aday kaynak olarak eklenir. İçerik kullanılmadan önce HTTP üzerinden getirilir. Kaynağa erişilemiyorsa hata kaydı tutulur ve başarısız içerik araştırma girdisi sayılmaz.

## Kullanıcı akışı

1. Konu, hedef kitle, ton, hedef süre, URL ve/veya metinle çalışma başlatın.
2. Aday web kaynaklarını arayın veya URL/metin ekleyin. `Kaynakları Getir` içeriği indirir; indirilemeyenler araştırılmış gibi gösterilmez.
3. Researcher aşamasını açıkça başlatın. Kaynaklı olguları, alıntıları ve varsa çelişkileri gözden geçirip tek tek onaylayın. Doğrulanamayan alıntılar düşük güvenli `unverified` olarak işaretlenir.
4. Scriptwriter aşamasını başlatın. Yalnızca onaylanan olgulara referans veren Türkçe senaryo taslağını inceleyin/düzenleyin.
5. Fact-checker aşamasını açıkça başlatın. Cümleler kaynaklarla karşılaştırılır. API/model hatası varsa denetim başarı sayılmaz; desteklenmeyen veya denetlenmemiş bir taslak “hazır” olarak sunulmaz.
6. Markdown veya şema sürümü 1 JSON dışa aktarın. Uyarılar, kaynaklar ve cümle↔fact_id eşlemesi export’ta korunur.

## Komutlar

```bash
npm run dev         # Vite + API geliştirme sunucuları
npm run dev:web     # yalnızca Vite
npm run dev:server  # yalnızca API
npm run typecheck   # server ve frontend TypeScript kontrolü
npm test            # Vitest test paketi
npm run build       # typecheck (server) + Vite üretim derlemesi
npm start           # üretim sunucusu
```

## Güvenlik ve doğruluk sınırları

- LLM anahtarları yalnızca sunucu tarafındaki `.env` dosyasından okunur; `/api/config` yalnızca sağlayıcı/model durumu ve açıklama döndürür, sırları döndürmez.
- URL getirici `http(s)` dışında protokolü ve yaygın localhost/özel IPv4/IPv6 hedeflerini engeller, yanıt boyutu/süresini sınırlar. Bu temel bir SSRF korumasıdır; DNS rebinding ve tüm bulut/IPv6 adresleme biçimlerine karşı kurumsal bir güvenlik duvarı olarak değerlendirilmemelidir. Yalnızca güvendiğiniz kaynak URL’lerini kullanın.
- Alıntı eşlemesi metin normalizasyonu ve sözcük kapsama sezgisidir; alıntı doğrulaması anlam doğruluğunun kanıtı değildir. LLM fact-check de otomatik karar desteğidir, insan incelemesinin yerine geçmez.
- Arama API’leri sınırlı sonuç verir; Wikipedia tek başına yeterli olmayabilir. Model yalnızca getirilen kaynak içeriklerinden olgu çıkarmaya yönlendirilir; kaynak bulamazsa işlem durur.
- Araştırma en fazla dört metin parçasında ve kullanıcı eylemiyle çağrı yapar; senaryo yazımı ve denetim ayrı kullanıcı adımlarıdır. Maliyet ve kota seçilen sağlayıcıya/modeline göre değişir.
- Çelişkiler otomatik çözülmez; iki taraf kaynaklarıyla birlikte gösterilir. Olguların onay/red kararını kullanıcı verir.
- Dosya deposu tek makinede yerel MVP kullanımı içindir. Kimlik doğrulama/çok kullanıcılı erişim, bulut veritabanı, eşzamanlı kullanıcı senkronizasyonu ve ekip izinleri bu sürümde yoktur. `data/` dizini yerel çalışma verisi içerir; sistem yedeği alın.

## Test kapsamı

Vitest paketleri HTTP sağlayıcı hata eşlemesi (401/429/5xx), bozuk JSON, alıntı eşleme, araştırma kaynağı doğrulama, senaryo referansları, desteklenmeyen iddia/sayı tespiti, LLM denetim hatası, SSRF URL engelleme, arama sağlayıcı normalizasyonu, yerel depolama round-trip/bozuk dosya ve Markdown/JSON dışa aktarmayı sınar.
