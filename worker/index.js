/**
 * Uzay Havası ve Gökyüzü Panosu - API ağ geçidi (BFF) + statik ön yüz
 * Cloudflare Workers üzerinde çalışır.
 *
 * Güvenlik kontrolleri (ödev kartı):
 *  - BFF: Tarayıcı üç harici API'ye doğrudan gitmez; tüm kaynaklar /api/* altında birleştirilir.
 *  - CORS allowlist: Yalnızca izinli kökenlere Access-Control-Allow-Origin döner (asla "*").
 *  - Zaman aşımı: Her harici istek UPSTREAM_TIMEOUT_MS sonra kesilir.
 *  - Circuit breaker: Bir kaynak art arda N kez hata verirse devre açılır, bekleme süresi boyunca
 *    o kaynağa istek atılmaz; son başarılı veri sunulur, diğer kaynaklar çalışmaya devam eder.
 *  - Yanıt doğrulama: Harici yanıtlar beklenen şemaya uymuyorsa reddedilir (hata sayılır).
 *  - Önbellek: Bellek içi taze önbellek + KV'de "son başarılı veri" (stale fallback).
 *  - Güvenlik başlıkları: HSTS, CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy,
 *    frame-ancestors - her yanıta eklenir.
 */

// ---------------------------------------------------------------------------
// Kaynak tanımları
// ---------------------------------------------------------------------------
const MANISA = { lat: 38.61, lon: 27.43 };

const SOURCES = {
  kp: {
    url: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    label: "NOAA SWPC - Kp indeksi",
    page: "https://www.swpc.noaa.gov/products/planetary-k-index",
    ttl: 10 * 60, // saniye: bellekte taze sayılma süresi
    validate: (d) =>
      Array.isArray(d) && d.length > 0 &&
      d.every((r) => r && typeof r.time_tag === "string" && typeof r.Kp === "number"),
    shape: (d) => d.slice(-56), // son 7 gün (3 saatlik)
  },
  kp_forecast: {
    url: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
    label: "NOAA SWPC - 3 günlük Kp tahmini",
    page: "https://www.swpc.noaa.gov/products/3-day-forecast",
    ttl: 30 * 60,
    validate: (d) =>
      Array.isArray(d) && d.length > 0 &&
      d.every((r) => r && typeof r.time_tag === "string" && typeof r.kp === "number" && typeof r.observed === "string"),
    shape: (d) => d,
  },
  solar_wind: {
    url: "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json",
    label: "NOAA SWPC - Güneş rüzgârı (plazma)",
    page: "https://www.swpc.noaa.gov/products/real-time-solar-wind",
    ttl: 2 * 60,
    validate: (d) => Array.isArray(d) && d.some((r) => r && r.active === true && typeof r.time_tag === "string"),
    shape: (d) => latestActive(d, 60).map((r) => ({
      time_tag: r.time_tag,
      proton_speed: numOrNull(r.proton_speed),
      proton_density: numOrNull(r.proton_density),
    })),
  },
  magnetic: {
    url: "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json",
    label: "NOAA SWPC - Güneş rüzgârı (manyetik alan)",
    page: "https://www.swpc.noaa.gov/products/real-time-solar-wind",
    ttl: 2 * 60,
    validate: (d) => Array.isArray(d) && d.some((r) => r && r.active === true && typeof r.time_tag === "string"),
    shape: (d) => latestActive(d, 60).map((r) => ({
      time_tag: r.time_tag,
      bt: numOrNull(r.bt),
      bz_gsm: numOrNull(r.bz_gsm),
    })),
  },
  iss: {
    url: "https://api.wheretheiss.at/v1/satellites/25544",
    label: "Where the ISS at? - ISS konumu",
    page: "https://wheretheiss.at/w/developer",
    ttl: 10, // API ~1 istek/sn sınırı koyuyor; 10 sn önbellek bunun çok altında kalır
    validate: (d) =>
      d && typeof d.latitude === "number" && typeof d.longitude === "number" &&
      Math.abs(d.latitude) <= 90 && Math.abs(d.longitude) <= 180 && typeof d.timestamp === "number",
    shape: (d) => ({
      latitude: d.latitude,
      longitude: d.longitude,
      altitude: numOrNull(d.altitude),
      velocity: numOrNull(d.velocity),
      visibility: typeof d.visibility === "string" ? d.visibility : null,
      timestamp: d.timestamp,
    }),
  },
  clouds: {
    url:
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${MANISA.lat}&longitude=${MANISA.lon}` +
      "&hourly=cloud_cover&timezone=Europe%2FIstanbul&forecast_days=3",
    label: "Open-Meteo - Manisa bulutluluk",
    page: "https://open-meteo.com/",
    ttl: 30 * 60,
    validate: (d) =>
      d && d.hourly && Array.isArray(d.hourly.time) && Array.isArray(d.hourly.cloud_cover) &&
      d.hourly.time.length === d.hourly.cloud_cover.length && d.hourly.time.length > 0,
    shape: (d) => ({ time: d.hourly.time, cloud_cover: d.hourly.cloud_cover }),
  },
};

const MAX_BODY_BYTES = 5_000_000; // beklenmedik derecede büyük yanıtları reddet
const KV_WRITE_INTERVAL_MS = 30 * 60 * 1000; // KV ücretsiz katman yazma sınırına saygı
const ADMIN_FLAGS_KEY = "admin:simulated-outages";

// ---------------------------------------------------------------------------
// Bellek içi durum (her Worker örneği için ayrı; KV ile desteklenir)
// ---------------------------------------------------------------------------
const memCache = new Map();   // key -> { data, fetchedAt }
const breakers = new Map();   // key -> { state, failures, openedAt }
const lastKvWrite = new Map();
let outageFlags = { value: [], readAt: 0 };

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function latestActive(records, limit) {
  return records
    .filter((r) => r && r.active === true && typeof r.time_tag === "string")
    .sort((a, b) => (a.time_tag < b.time_tag ? 1 : -1))
    .slice(0, limit);
}

function cfg(env) {
  return {
    threshold: parseInt(env.BREAKER_FAILURE_THRESHOLD || "3", 10),
    cooldownMs: parseInt(env.BREAKER_COOLDOWN_SECONDS || "60", 10) * 1000,
    timeoutMs: parseInt(env.UPSTREAM_TIMEOUT_MS || "4000", 10),
  };
}

function log(event, fields = {}) {
  // Workers Logs bu JSON satırlarını toplar ve panelde aranabilir yapar.
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
function getBreaker(key) {
  if (!breakers.has(key)) breakers.set(key, { state: "closed", failures: 0, openedAt: 0 });
  return breakers.get(key);
}

function breakerAllows(key, c, now) {
  const b = getBreaker(key);
  if (b.state === "open") {
    if (now - b.openedAt >= c.cooldownMs) {
      b.state = "half-open"; // bekleme bitti: tek bir deneme isteğine izin ver
      log("breaker_half_open", { source: key });
      return true;
    }
    return false;
  }
  return true;
}

function breakerSuccess(key) {
  const b = getBreaker(key);
  if (b.state !== "closed") log("breaker_closed", { source: key });
  b.state = "closed";
  b.failures = 0;
}

function breakerFailure(key, c, now, error) {
  const b = getBreaker(key);
  b.failures += 1;
  if (b.state === "half-open" || b.failures >= c.threshold) {
    if (b.state !== "open") log("breaker_opened", { source: key, failures: b.failures, error });
    b.state = "open";
    b.openedAt = now;
  }
}

// ---------------------------------------------------------------------------
// Simüle kesinti bayrakları (doğrulama testi için; KV'de saklanır)
// ---------------------------------------------------------------------------
async function getOutages(env, now) {
  if (now - outageFlags.readAt < 10_000) return outageFlags.value;
  let value = [];
  try {
    const raw = env.CACHE ? await env.CACHE.get(ADMIN_FLAGS_KEY) : null;
    value = raw ? JSON.parse(raw) : [];
  } catch (_) {
    value = [];
  }
  outageFlags = { value, readAt: now };
  return value;
}

// ---------------------------------------------------------------------------
// Harici kaynağı çek (zaman aşımı + boyut sınırı + doğrulama)
// ---------------------------------------------------------------------------
async function fetchUpstream(key, src, c, simulateOutage) {
  if (simulateOutage) throw new Error("simüle kesinti (yönetici testi)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), c.timeoutMs);
  try {
    const res = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "uzay-havasi-panosu-bff/1.0 (ogrenci projesi)", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("yanıt çok büyük");
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error("geçersiz JSON");
    }
    if (!src.validate(json)) throw new Error("yanıt doğrulaması başarısız (şema uyuşmuyor)");
    return src.shape(json);
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`zaman aşımı (${c.timeoutMs} ms)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readKv(env, key) {
  try {
    const raw = env.CACHE ? await env.CACHE.get(`data:${key}`) : null;
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function writeKv(env, ctx, key, entry, now) {
  if (!env.CACHE) return;
  if (now - (lastKvWrite.get(key) || 0) < KV_WRITE_INTERVAL_MS) return;
  lastKvWrite.set(key, now);
  const p = env.CACHE.put(`data:${key}`, JSON.stringify(entry)).catch((e) => log("kv_write_failed", { source: key, error: String(e) }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

/**
 * Bir kaynağın verisini döndürür. Hiçbir zaman hata fırlatmaz:
 * sonuç her zaman { status, breaker, fetchedAt, data, error } biçimindedir.
 *  status: "live" (şimdi çekildi) | "cached" (taze önbellek) | "stale" (son başarılı veri) | "unavailable"
 */
async function getSource(key, env, ctx) {
  const src = SOURCES[key];
  const c = cfg(env);
  const now = Date.now();
  const outages = await getOutages(env, now);
  const simulate = outages.includes(key);
  const mem = memCache.get(key);

  // 1) Taze önbellek varsa harici API'ye hiç gitme (hız sınırına saygı)
  if (!simulate && mem && now - mem.fetchedAt < src.ttl * 1000) {
    return result(key, "cached", mem);
  }

  // 2) Devre açıksa harici API'ye gitme; doğrudan son başarılı veriyi sun
  if (!breakerAllows(key, c, now)) {
    return fallback(key, env, mem, "devre açık: kaynak geçici olarak devre dışı");
  }

  // 3) Harici API'yi dene
  try {
    const data = await fetchUpstream(key, src, c, simulate);
    const entry = { data, fetchedAt: now };
    memCache.set(key, entry);
    breakerSuccess(key);
    await writeKv(env, ctx, key, entry, now);
    return result(key, "live", entry);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    breakerFailure(key, c, now, msg);
    log("upstream_error", { source: key, error: msg, breaker: getBreaker(key).state });
    return fallback(key, env, mem, msg);
  }
}

async function fallback(key, env, mem, error) {
  const entry = mem || (await readKv(env, key));
  if (entry) return result(key, "stale", entry, error);
  return result(key, "unavailable", null, error);
}

function result(key, status, entry, error = null) {
  const src = SOURCES[key];
  const b = getBreaker(key);
  return {
    status,
    breaker: b.state,
    breakerFailures: b.failures,
    label: src.label,
    sourcePage: src.page,
    fetchedAt: entry ? new Date(entry.fetchedAt).toISOString() : null,
    error,
    data: entry ? entry.data : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP katmanı: güvenlik başlıkları, CORS allowlist, yönlendirme
// ---------------------------------------------------------------------------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.tile.openstreetmap.org",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

function withSecurityHeaders(response) {
  const r = new Response(response.body, response);
  const h = r.headers;
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return r;
}

function allowedOrigins(env, requestUrl) {
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  list.push(new URL(requestUrl).origin); // kendi adresimiz her zaman izinli
  return list;
}

function applyCors(response, request, env) {
  const origin = request.headers.get("Origin");
  const h = response.headers;
  h.append("Vary", "Origin");
  if (origin && allowedOrigins(env, request.url).includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    h.set("Access-Control-Max-Age", "600");
  }
  return response;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function handleAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN tanımlı değil" }, 503);
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    log("admin_unauthorized", { ip: request.headers.get("CF-Connecting-IP") });
    return json({ error: "yetkisiz" }, 401);
  }
  if (request.method !== "POST") return json({ error: "yalnızca POST" }, 405, { Allow: "POST" });

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "geçersiz JSON" }, 400);
  }
  const { source, action } = body || {};
  if (!Object.prototype.hasOwnProperty.call(SOURCES, source)) return json({ error: "bilinmeyen kaynak" }, 400);
  if (!["outage-on", "outage-off"].includes(action)) return json({ error: "action: outage-on | outage-off" }, 400);

  const now = Date.now();
  outageFlags.readAt = 0;
  const current = new Set(await getOutages(env, now));
  if (action === "outage-on") current.add(source);
  else current.delete(source);
  const list = [...current];
  await env.CACHE.put(ADMIN_FLAGS_KEY, JSON.stringify(list));
  outageFlags = { value: list, readAt: now };
  if (action === "outage-off") {
    // Test bitince devreyi kapat ki kaynak hemen normale dönsün
    breakers.delete(source);
  }
  log("admin_outage_changed", { source, action, simulatedOutages: list });
  return json({ ok: true, simulatedOutages: list });
}

async function handleApi(request, env, ctx, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (url.pathname === "/api/admin/outage") return handleAdmin(request, env);

  if (request.method !== "GET") return json({ error: "yalnızca GET" }, 405, { Allow: "GET, OPTIONS" });

  if (url.pathname === "/api/health") {
    return json({ ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === "/api/all") {
    const keys = Object.keys(SOURCES);
    // Promise.allSettled + getSource'un hata fırlatmaması: bir kaynak çökse de diğerleri döner
    const settled = await Promise.allSettled(keys.map((k) => getSource(k, env, ctx)));
    const sources = {};
    keys.forEach((k, i) => {
      sources[k] = settled[i].status === "fulfilled"
        ? settled[i].value
        : { status: "unavailable", breaker: getBreaker(k).state, error: "beklenmeyen hata", data: null };
    });
    return json({ generatedAt: new Date().toISOString(), location: MANISA, sources });
  }

  const m = url.pathname.match(/^\/api\/source\/([a-z_]+)$/);
  if (m && Object.prototype.hasOwnProperty.call(SOURCES, m[1])) {
    return json({ generatedAt: new Date().toISOString(), source: m[1], ...(await getSource(m[1], env, ctx)) });
  }

  return json({ error: "bulunamadı" }, 404);
}

function securityTxt(url) {
  const expires = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)).toISOString();
  return [
    "Contact: https://github.com/KerimX54/uzay-havasi-panosu/security/advisories/new",
    `Expires: ${expires}`,
    "Preferred-Languages: tr, en",
    `Canonical: ${url.origin}/.well-known/security.txt`,
    "",
  ].join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response;
    try {
      if (url.pathname.startsWith("/api/")) {
        response = applyCors(await handleApi(request, env, ctx, url), request, env);
      } else if (url.pathname === "/.well-known/security.txt") {
        response = new Response(securityTxt(url), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (err) {
      log("unhandled_error", { path: url.pathname, error: String(err) });
      response = json({ error: "sunucu hatası" }, 500);
    }
    return withSecurityHeaders(response);
  },
};

// Testler için dışa aktarım
export const __test = { SOURCES, breakers, memCache, getSource, reset: () => { breakers.clear(); memCache.clear(); lastKvWrite.clear(); outageFlags = { value: [], readAt: 0 }; } };
