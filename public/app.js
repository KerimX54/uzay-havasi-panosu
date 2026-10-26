// Uzay Havası ve Gökyüzü Panosu - ön yüz
// Tarayıcı yalnızca kendi BFF'imiz (/api/all) ile konuşur; harici API'lere doğrudan gitmez.
"use strict";

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 60_000;

const STATUS_TEXT = {
  live: { icon: "●", text: "Canlı", cls: "s-ok" },
  cached: { icon: "●", text: "Canlı (önbellek)", cls: "s-ok" },
  stale: { icon: "▲", text: "Son başarılı veri", cls: "s-warn" },
  unavailable: { icon: "✕", text: "Veri yok", cls: "s-bad" },
};
const BREAKER_TEXT = {
  closed: { icon: "●", text: "Kapalı (normal)", cls: "s-ok" },
  "half-open": { icon: "◐", text: "Yarı açık (deneniyor)", cls: "s-warn" },
  open: { icon: "✕", text: "Açık (kaynak devre dışı)", cls: "s-bad" },
};

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function badge(map, key) {
  const b = map[key] || { icon: "?", text: key, cls: "" };
  const span = document.createElement("span");
  span.className = `badge ${b.cls}`;
  span.textContent = `${b.icon} ${b.text}`;
  return span;
}

function setText(id, text) { $(id).textContent = text; }

function tonightCloud(clouds) {
  if (!clouds || !clouds.time) return null;
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
  const start = new Date(now);
  if (now.getHours() < 6) start.setDate(start.getDate() - 1);
  start.setHours(20, 0, 0, 0);
  const end = new Date(start.getTime() + 8 * 3600 * 1000);
  const vals = [];
  clouds.time.forEach((t, i) => {
    const d = new Date(t);
    if (d >= start && d <= end && typeof clouds.cloud_cover[i] === "number") vals.push(clouds.cloud_cover[i]);
  });
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

function render(payload) {
  const s = payload.sources;
  setText("updated", `Son güncelleme: ${fmtTime(payload.generatedAt)} (TSİ)`);

  // Banner: herhangi bir kaynak canlı değilse açıkça söyle
  const degraded = Object.values(s).filter((x) => x.status === "stale" || x.status === "unavailable");
  const banner = $("banner");
  if (degraded.length) {
    banner.hidden = false;
    banner.textContent = `▲ ${degraded.length} kaynağa şu an ulaşılamıyor: ${degraded.map((x) => x.label).join(", ")}. Bu bölümlerde son başarılı veri gösteriliyor; diğer bölümler canlı.`;
  } else {
    banner.hidden = true;
  }

  // KPI: Kp
  const kp = s.kp && s.kp.data ? s.kp.data[s.kp.data.length - 1] : null;
  setText("kpi-kp", kp ? `${kp.Kp.toFixed(1)} / 9` : "—");
  setText("kpi-kp-sub", kp ? (kp.Kp >= 5 ? "Jeomanyetik fırtına" : kp.Kp >= 4 ? "Hareketli" : "Sakin") : "Veri yok");

  // KPI: bulut
  const cloud = tonightCloud(s.clouds && s.clouds.data);
  setText("kpi-cloud", cloud === null ? "—" : `%${cloud}`);

  // KPI: rüzgâr
  const w = s.solar_wind && s.solar_wind.data ? s.solar_wind.data[0] : null;
  const m = s.magnetic && s.magnetic.data ? s.magnetic.data[0] : null;
  setText("kpi-wind", w && w.proton_speed !== null ? `${Math.round(w.proton_speed)} km/s` : "—");
  setText("kpi-wind-sub", [w && w.proton_density !== null ? `Yoğunluk ${w.proton_density.toFixed(1)} p/cm³` : null, m && m.bz_gsm !== null ? `Bz ${m.bz_gsm.toFixed(1)} nT` : null].filter(Boolean).join(" · ") || "Veri yok");

  // KPI: ISS
  const iss = s.iss && s.iss.data;
  if (iss) {
    const lat = `${Math.abs(iss.latitude).toFixed(1)}°${iss.latitude >= 0 ? "K" : "G"}`;
    const lon = `${Math.abs(iss.longitude).toFixed(1)}°${iss.longitude >= 0 ? "D" : "B"}`;
    setText("kpi-iss", `${lat}, ${lon}`);
    setText("kpi-iss-sub", iss.visibility === "daylight" ? "☀ Gündüz tarafında" : "☾ Gece tarafında");
  } else {
    setText("kpi-iss", "—");
    setText("kpi-iss-sub", "Veri yok");
  }

  // Özet (taslak kural; final sürümde Kp ve ISS geçişiyle birlikte değerlendirilecek)
  let verdict = "Bilinmiyor";
  let why = "Bulutluluk verisine ulaşılamadı.";
  if (cloud !== null) {
    if (cloud < 30) { verdict = "✓ Uygun"; }
    else if (cloud < 60) { verdict = "▲ Kısmen uygun"; }
    else { verdict = "✕ Uygun değil"; }
    why = `Bu gece ortalama bulutluluk %${cloud}` + (kp ? ` · Kp ${kp.Kp.toFixed(1)}` : "") + ".";
  }
  setText("verdict", verdict);
  setText("verdict-why", why);

  // Kaynak tablosu
  const tbody = $("sources");
  tbody.replaceChildren();
  Object.values(s).forEach((x) => {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    const a = document.createElement("a");
    a.href = x.sourcePage; a.textContent = x.label; a.rel = "noopener";
    name.append(a);
    const st = document.createElement("td"); st.append(badge(STATUS_TEXT, x.status));
    const br = document.createElement("td"); br.append(badge(BREAKER_TEXT, x.breaker));
    const at = document.createElement("td"); at.textContent = fmtTime(x.fetchedAt);
    const note = document.createElement("td"); note.textContent = x.error || "";
    tr.append(name, st, br, at, note);
    tbody.append(tr);
  });
}

async function load() {
  try {
    const res = await fetch("/api/all", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    const banner = $("banner");
    banner.hidden = false;
    banner.textContent = `✕ Sunucuya ulaşılamadı (${err.message}). Ekrandaki veriler en son başarılı yüklemeden kalmadır.`;
  }
}

function initNight() {
  const btn = $("night");
  let on = false;
  try { on = localStorage.getItem("theme") === "night"; } catch (_) { /* depolama kapalı olabilir */ }
  const apply = () => {
    document.documentElement.dataset.theme = on ? "night" : "";
    btn.setAttribute("aria-pressed", String(on));
  };
  apply();
  btn.addEventListener("click", () => {
    on = !on;
    apply();
    try { localStorage.setItem("theme", on ? "night" : "day"); } catch (_) { /* yok say */ }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNight();
  $("refresh").addEventListener("click", load);
  load();
  setInterval(load, REFRESH_MS);
});
