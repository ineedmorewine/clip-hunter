# clip-hunter

Kick yayın linkinden komik anları bulup dikey (9:16) klip çıkaran kişisel araç.

## Nasıl kullanılır

1. **Actions** sekmesi → soldan **Klip bul** → sağda **Run workflow**.
2. `Kick yayın linki` kutusuna linki yapıştır (`https://kick.com/lunverra/videos/...`).
3. İstersen klip sayısını ve en düşük puanı değiştir, **Run workflow**'a bas.
4. Bitince çalışmanın sayfasını aç:
   - Üstteki özet tabloda her klibin yayındaki yeri, süresi, puanı ve nedeni yazar.
   - En altta **Artifacts → klipler** zip'ini indir. İçinde `klipler/` klasöründe mp4'ler ve `klipler.md` listesi var.

Dosya adları sıra numarası ve yayındaki başlangıç zamanıdır: `03_1-42-15.mp4` → yayının 1:42:15'i.

## Nasıl çalışır

1. Yayının düşük kaliteli kopyası indirilir, sesi çıkarılır.
2. Ses seviyesindeki ani yükselişler (kahkaha, bağırma) ipucu olarak işaretlenir.
3. Gemini, yayını 20 dakikalık parçalar halinde **dinler** ve Türkçe mizaha göre aday anları seçer.
4. Her aday için Gemini o bölümü **izler**, gerçekten iyi mi diye kontrol eder ve başlangıç/bitişi düzeltir.
5. Seçilen anlar en yüksek kaliteden kesilir, bulanık arka planlı 1080×1920 klip yapılır.

Altyazı ve kurgu eklenmez.

## Ayarlar

- `GEMINI_API_KEY` (Settings → Secrets → Actions): zorunlu.
- `GEMINI_MODELS` (Settings → Variables → Actions, isteğe bağlı): virgülle ayrılmış model sırası.
- Mizah tarifi `prompts/` klasöründe; neyin komik sayılacağı oradan değiştirilir.
