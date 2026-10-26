#!/usr/bin/env python3
"""Uzay Havası ve Gökyüzü Panosu - veri çekme betiği.

GitHub Actions tarafından zamanlanmış olarak çalıştırılır.
Yalnızca Python standart kütüphanesini kullanır (ek kurulum gerekmez).

Ürettiği dosyalar:
  data/latest.json            -> arayüzün okuyacağı son veri (her kaynak ayrı)
  data/snapshots/<zaman>.json -> her çalıştırmada küçük bir anlık görüntü
  data/history.csv            -> anlık görüntülerden biriken zaman serisi

Bir kaynak çökerse önceki başarılı verisi korunur ve "ok": false işaretlenir;
böylece arayüz "son başarılı veri" ile açılabilir.
"""

import csv
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SNAP_DIR = DATA_DIR / "snapshots"
LATEST_FILE = DATA_DIR / "latest.json"
HISTORY_FILE = DATA_DIR / "history.csv"

# Türkiye 2016'dan beri yıl boyu UTC+3 kullanıyor.
TR_TZ = timezone(timedelta(hours=3))

MANISA = {"ad": "Manisa", "lat": 38.61, "lon": 27.43}

SOURCES = {
    "kp": {
        "url": "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
        "kaynak": "NOAA SWPC - Planetary K-index",
        "sayfa": "https://www.swpc.noaa.gov/products/planetary-k-index",
    },
    "kp_tahmin": {
        "url": "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
        "kaynak": "NOAA SWPC - 3 günlük Kp tahmini",
        "sayfa": "https://www.swpc.noaa.gov/products/3-day-forecast",
    },
    "gunes_ruzgari": {
        "url": "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json",
        "kaynak": "NOAA SWPC - Gerçek zamanlı güneş rüzgârı (plazma)",
        "sayfa": "https://www.swpc.noaa.gov/products/real-time-solar-wind",
    },
    "manyetik_alan": {
        "url": "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json",
        "kaynak": "NOAA SWPC - Gerçek zamanlı güneş rüzgârı (manyetik alan)",
        "sayfa": "https://www.swpc.noaa.gov/products/real-time-solar-wind",
    },
    "iss": {
        "url": "https://api.wheretheiss.at/v1/satellites/25544",
        "kaynak": "Where the ISS at?",
        "sayfa": "https://wheretheiss.at/w/developer",
    },
    "bulutluluk": {
        "url": (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={MANISA['lat']}&longitude={MANISA['lon']}"
            "&hourly=cloud_cover&timezone=Europe%2FIstanbul&forecast_days=3"
        ),
        "kaynak": "Open-Meteo - saatlik bulutluluk (Manisa)",
        "sayfa": "https://open-meteo.com/",
    },
}

USER_AGENT = "uzay-havasi-panosu/1.0 (ogrenci projesi, GitHub Actions)"


def fetch_json(url, tries=3, timeout=30):
    """URL'den JSON çeker; geçici hatalarda birkaç kez yeniden dener."""
    last_err = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            last_err = err
            print(f"  deneme {attempt}/{tries} başarısız: {err}")
            if attempt < tries:
                time.sleep(5 * attempt)  # hız sınırına saygı: giderek uzayan bekleme
    raise RuntimeError(str(last_err))


def latest_active(records, limit):
    """RTSW listelerinden yalnızca aktif kayıtları, en yeniden eskiye doğru alır."""
    active = [r for r in records if isinstance(r, dict) and r.get("active")]
    active.sort(key=lambda r: r.get("time_tag", ""), reverse=True)
    return active[:limit]


def trim(key, data):
    """Depo şişmesin diye büyük kaynakları kırpar."""
    if key in ("gunes_ruzgari", "manyetik_alan"):
        return latest_active(data, 180)  # son ~3 saat (dakikalık)
    return data


def tonight_cloud(cloud):
    """Bu gecenin (20:00-04:00, yerel saat) ortalama bulutluluğu."""
    if not cloud:
        return None
    times = cloud.get("hourly", {}).get("time", [])
    values = cloud.get("hourly", {}).get("cloud_cover", [])
    now = datetime.now(TR_TZ)
    start_day = now.date() if now.hour >= 6 else now.date() - timedelta(days=1)
    start = datetime(start_day.year, start_day.month, start_day.day, 20)
    end = start + timedelta(hours=8)  # ertesi gün 04:00
    picked = []
    for t, v in zip(times, values):
        try:
            ts = datetime.fromisoformat(t)
        except ValueError:
            continue
        if start <= ts <= end and v is not None:
            picked.append(v)
    return round(sum(picked) / len(picked), 1) if picked else None


def build_summary(sources):
    """Arayüzdeki KPI kartları için kısa özet."""
    def data(key):
        return sources.get(key, {}).get("veri")

    kp_list = data("kp") or []
    kp_now = kp_list[-1] if kp_list else {}

    forecast = data("kp_tahmin") or []
    predicted = [r.get("kp") for r in forecast if r.get("observed") == "predicted" and r.get("kp") is not None]

    wind = (data("gunes_ruzgari") or [{}])
    wind = wind[0] if wind else {}
    mag = (data("manyetik_alan") or [{}])
    mag = mag[0] if mag else {}
    iss = data("iss") or {}

    cloud_avg = tonight_cloud(data("bulutluluk"))
    if cloud_avg is None:
        gozlem = "bilinmiyor"
    elif cloud_avg < 30:
        gozlem = "uygun"
    elif cloud_avg < 60:
        gozlem = "kısmen uygun"
    else:
        gozlem = "uygun değil"

    return {
        "kp_son": kp_now.get("Kp"),
        "kp_son_zaman": kp_now.get("time_tag"),
        "kp_tahmin_max_3gun": max(predicted) if predicted else None,
        "ruzgar_hizi_kms": wind.get("proton_speed"),
        "proton_yogunlugu": wind.get("proton_density"),
        "bz_gsm_nT": mag.get("bz_gsm"),
        "bt_nT": mag.get("bt"),
        "iss_enlem": iss.get("latitude"),
        "iss_boylam": iss.get("longitude"),
        "iss_gorunurluk": iss.get("visibility"),
        "bulut_bu_gece_ort": cloud_avg,
        # Taslak kural - final sürümde arayüzde Kp ve ISS ile birlikte yorumlanacak.
        "gozlem_durumu": gozlem,
    }


def main():
    DATA_DIR.mkdir(exist_ok=True)
    SNAP_DIR.mkdir(exist_ok=True)

    previous = {}
    if LATEST_FILE.exists():
        try:
            previous = json.loads(LATEST_FILE.read_text(encoding="utf-8")).get("kaynaklar", {})
        except json.JSONDecodeError:
            previous = {}

    now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    results = {}

    for key, meta in SOURCES.items():
        print(f"[{key}] {meta['url']}")
        try:
            raw = fetch_json(meta["url"])
            results[key] = {
                "ok": True,
                "kaynak": meta["kaynak"],
                "sayfa": meta["sayfa"],
                "url": meta["url"],
                "cekildi": now_iso,
                "veri": trim(key, raw),
            }
            print("  tamam")
        except Exception as err:  # bir kaynak çökse de diğerleri devam eder
            old = previous.get(key, {})
            results[key] = {
                "ok": False,
                "kaynak": meta["kaynak"],
                "sayfa": meta["sayfa"],
                "url": meta["url"],
                "hata": str(err),
                "cekildi": old.get("cekildi"),  # son başarılı çekim zamanı
                "veri": old.get("veri"),        # son başarılı veri
            }
            print(f"  HATA: {err} -> önceki veri korunuyor")
        time.sleep(1)  # kaynaklara art arda yüklenmemek için

    summary = build_summary(results)
    latest = {
        "son_guncelleme": now_iso,
        "konum": MANISA,
        "ozet": summary,
        "kaynaklar": results,
    }
    LATEST_FILE.write_text(json.dumps(latest, ensure_ascii=False, indent=1), encoding="utf-8")

    # Anlık görüntü (küçük tutulur; zaman serisi bundan birikir)
    snap_name = now.strftime("%Y-%m-%dT%H-%MZ") + ".json"
    snapshot = {"zaman": now_iso, "ozet": summary, "iss": results["iss"].get("veri")}
    (SNAP_DIR / snap_name).write_text(json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8")

    new_file = not HISTORY_FILE.exists()
    with HISTORY_FILE.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["zaman_utc"] + list(summary.keys()))
        writer.writerow([now_iso] + list(summary.values()))

    ok_count = sum(1 for r in results.values() if r["ok"])
    print(f"Bitti: {ok_count}/{len(results)} kaynak başarılı. Özet: {summary}")


if __name__ == "__main__":
    main()
