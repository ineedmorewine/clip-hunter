# clip-hunter

Kick yayın linkinden komik anları bulup dikey (9:16) klip çıkaran kişisel araç.

## Nasıl kullanılır

**Hiçbir şey yapmana gerek yok.** Her gün iki kez (11:20 ve 19:20 civarı) araç Kick kanalındaki
yeni yayınları kendisi bulur, klipleri çıkarır ve her yayın için bir **Issue** açar. GitHub sana
bildirim/e-posta gönderir. Issue'da klip listesi ve indirme linki vardır.

Gemini'nin günlük ücretsiz kotası biterse kaldığı yerden bir sonraki çalışmada devam eder.

**Elle çalıştırmak istersen:** Actions → **Klip bul** → **Run workflow**.
Link kutusunu boş bırakırsan yeni yayınları arar; bir Kick linki yapıştırırsan sadece onu işler.

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
