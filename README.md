# Uzay Havası ve Gökyüzü Panosu

Amatör gökbilimcilerin gözlem gecesi planlamasına yardım eden canlı veri panosu.
Kp indeksi ve 3 günlük tahmini, güneş rüzgârı, ISS'in anlık konumu ve Manisa'nın bulutluluk
tahminini bir araya getirerek "Bu gece Manisa'dan gözlem uygun mu?" sorusunu yanıtlar.

> BVA 2245 Kullanıcı Arayüzü Tasarımı dersi için hazırlanmış bir öğrenci projesidir.
> Müşteri (bir bilim merkezi/planetaryum) kurgusaldır; ürün herhangi bir kurumun resmî aracı değildir.

Canlı link:

## Durum

- [x] Otomatik veri hattı (GitHub Actions, 3 saatte bir)
- [x] Anlık görüntü (snapshot) birikimi
- [ ] Arayüz: KPI kartları, grafikler, ISS haritası, tablo
- [ ] Kırmızı gece modu
- [ ] Yükleniyor / boş / hata durumları
- [ ] Kullanıcı testi
- [ ] Portfolyo vaka sayfası ve demo videosu

## Mimari

```
NOAA SWPC (Kp, Kp tahmini, güneş rüzgârı)  ─┐
wheretheiss.at (ISS konumu)                 ├─> GitHub Actions (cron, 3 saatte bir)
Open-Meteo (Manisa bulutluluğu)            ─┘        │  scripts/fetch_data.py
                                                     ▼
                                   data/latest.json   (son veri + özet)
                                   data/snapshots/    (anlık görüntüler)
                                   data/history.csv   (biriken zaman serisi)
                                                     │
                                                     ▼
                                   Tarayıcıdaki pano (GitHub Pages)
```

Bir kaynak yanıt vermezse önceki başarılı verisi korunur ve `"ok": false` olarak işaretlenir;
arayüz bu durumda son başarılı veriyle açılıp kullanıcıya bunu bildirir.

## Veri kaynakları ve lisanslar

| Kaynak | Ne için | Lisans / kullanım |
| --- | --- | --- |
| [NOAA SWPC](https://www.swpc.noaa.gov/) – `noaa-planetary-k-index.json`, `noaa-planetary-k-index-forecast.json`, `rtsw_wind_1m.json`, `rtsw_mag_1m.json` | Kp indeksi, 3 günlük tahmin, güneş rüzgârı | ABD kamu verisi (public domain) |
| [Where the ISS at?](https://wheretheiss.at/w/developer) | ISS anlık konumu | Ücretsiz API, ~1 istek/sn sınırı |
| [Open-Meteo](https://open-meteo.com/) | Manisa saatlik bulutluluk | CC BY 4.0, ticari olmayan kullanımda anahtarsız |

Hiçbir kaynak API anahtarı gerektirmez.

## Kurulum

```bash
git clone https://github.com/<kullanici-adi>/uzay-havasi-panosu.git
cd uzay-havasi-panosu
python scripts/fetch_data.py   # Python 3.10+, ek paket gerekmez
```

## CV cümlesi


 
