/* ══════════════════════════════════════════════════════════
   SkySearch – Backend-Logik für /api/flights
   Läuft als Cloudflare Pages Function (functions/api/flights.js)
   oder als eigenständiger Worker (worker.js).

   Der SerpAPI-Key liegt ausschließlich hier (Secret SERPAPI_KEY),
   nie im Browser. Eine Suche wird in mehrere SerpAPI-Abfragen
   aufgefächert (flexible Daten, Nachbarflughäfen, Einzeltickets,
   Verkaufsländer), parallel ausgeführt und zwischengespeichert.
══════════════════════════════════════════════════════════ */

const SERPAPI_URL       = 'https://serpapi.com/search.json';
const DEFAULT_MAX_QUERY = 40;     // Obergrenze SerpAPI-Abfragen pro Suche
const DEFAULT_CACHE_TTL = 7200;   // Sekunden (2 h)
const CONCURRENCY       = 8;
const MAX_FLIGHTS       = 40;     // pro Abfrage an den Browser geliefert
const MAX_AIRPORTS      = 6;      // pro Seite nach Umkreis-Erweiterung

export const COMPARE_COUNTRIES = ['at', 'de', 'ch', 'gb', 'us'];

/* Flughäfen im Umkreis (ca. ≤ 2 h Anreise). Bewusst klein gehalten:
   jeder zusätzliche Code verbreitert die Suche, kostet aber nichts extra. */
export const NEARBY = {
  VIE: ['BTS'],              BTS: ['VIE'],
  LNZ: ['VIE', 'SZG'],       GRZ: ['VIE', 'LJU'],
  KLU: ['LJU', 'GRZ'],       SZG: ['MUC', 'LNZ'],
  INN: ['MUC'],              MUC: ['MEM', 'NUE', 'SZG'],
  NUE: ['MUC'],              STR: ['FKB', 'FRA'],
  FRA: ['HHN', 'CGN', 'STR'],CGN: ['DUS', 'DTM', 'NRN'],
  DUS: ['CGN', 'DTM', 'NRN', 'EIN'],
  HAM: ['BRE', 'LBC'],       BRE: ['HAM'],
  HAJ: ['BRE'],              BER: ['LEJ'],
  LEJ: ['BER', 'DRS'],       DRS: ['LEJ', 'PRG'],
  ZRH: ['BSL', 'FDH'],       BSL: ['ZRH'],
  MLH: ['ZRH'],              FDH: ['ZRH', 'MEM'],
  GVA: ['LYS'],
  LHR: ['LGW', 'STN', 'LCY', 'LTN', 'SEN'],
  LGW: ['LHR', 'STN', 'LCY', 'LTN'],
  STN: ['LHR', 'LGW', 'LCY', 'LTN'],
  LCY: ['LHR', 'LGW', 'STN'],
  CDG: ['ORY', 'BVA'],       ORY: ['CDG', 'BVA'],
  AMS: ['EIN', 'RTM'],       BRU: ['CRL', 'EIN'],
  MXP: ['LIN', 'BGY'],       LIN: ['MXP', 'BGY'],
  FCO: ['CIA'],              VCE: ['TSF'],
  BLQ: ['FLR', 'PSA'],       FLR: ['PSA', 'BLQ'],
  PSA: ['FLR'],              NAP: ['FCO'],
  BCN: ['GRO', 'REU'],       TFS: ['TFN'],
  CPH: ['MMX'],              ARN: ['NYO', 'BMA'],
  OSL: ['TRF'],              PRG: ['DRS'],
  BUD: ['VIE'],              LJU: ['ZAG', 'TRS'],
  ZAG: ['LJU'],              IST: ['SAW'],
  SAW: ['IST'],              DXB: ['SHJ', 'DWC'],
  JFK: ['EWR', 'LGA'],       EWR: ['JFK', 'LGA'],
  LGA: ['JFK', 'EWR'],       LAX: ['BUR', 'LGB', 'SNA'],
  SFO: ['OAK', 'SJC'],       MIA: ['FLL'],
  NRT: ['HND'],              HND: ['NRT'],
  PEK: ['PKX'],              PKX: ['PEK'],
  BKK: ['DMK'],              DMK: ['BKK'],
  SVO: ['DME', 'VKO'],
};

/* ── kleine Helfer ───────────────────────────────────────── */
class InputError extends Error {}

const ISO_RE  = /^\d{4}-\d{2}-\d{2}$/;
const IATA_RE = /^[A-Z]{3}$/;

function int(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
const oneOf = (v, list, def) => (list.includes(v) ? v : def);

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const todayIso = () => new Date().toISOString().slice(0, 10);

function checkDate(iso, label) {
  if (!ISO_RE.test(iso || '')) throw new InputError(`${label}: Datum fehlt oder ist ungültig.`);
  return iso;
}

/* Datum ± flex Tage, vergangene Tage werden ausgelassen. */
export function dateRange(iso, flex) {
  const today = todayIso();
  const out = [];
  for (let i = -flex; i <= flex; i++) {
    const d = addDays(iso, i);
    if (d >= today) out.push(d);
  }
  return out;
}

/* "vie, bts" → "VIE,BTS"; mit nearby um Nachbarflughäfen erweitert. */
export function expandAirports(value, nearby) {
  const codes = String(value || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!codes.length) throw new InputError('Bitte Abflug- und Zielflughafen angeben.');
  for (const c of codes) {
    if (!IATA_RE.test(c)) throw new InputError(`"${c}" ist kein IATA-Code (z. B. VIE, MUC, LHR).`);
  }
  const out = [];
  for (const c of codes) {
    out.push(c);
    if (nearby) out.push(...(NEARBY[c] || []));
  }
  return [...new Set(out)].slice(0, MAX_AIRPORTS).join(',');
}

function baseParams(body) {
  const adults = int(body.adults, 1, 9, 1);
  const p = {
    engine:       'google_flights',
    currency:     oneOf(body.currency, ['EUR', 'USD', 'GBP', 'CHF'], 'EUR'),
    hl:           oneOf(body.hl, ['de', 'en', 'fr'], 'de'),
    gl:           /^[a-z]{2}$/.test(body.gl || '') ? body.gl : 'at',
    adults:       String(adults),
    travel_class: String(int(body.travel_class, 1, 4, 1)),
    show_hidden:  'true',
  };
  // SerpAPI: 0 = egal, 1 = nur Direktflüge, 2 = max. 1 Stopp, 3 = max. 2 Stopps
  const stops = int(body.stops, 0, 3, 0);
  if (stops) p.stops = String(stops);
  const bags = int(body.bags, 0, 2 * adults, 0);
  if (bags) p.bags = String(bags);
  const maxPrice = int(body.max_price, 0, 1e6, 0);
  if (maxPrice) p.max_price = String(maxPrice);
  if (body.deep_search) p.deep_search = 'true';
  return p;
}

/* ══════════════════════════════════════════════════════════
   SUCHPLAN – welche SerpAPI-Abfragen braucht eine Suche?
══════════════════════════════════════════════════════════ */
export function buildPlan(body) {
  const mode   = oneOf(body.mode, ['ow', 'rt', 'mc'], null);
  if (!mode) throw new InputError('Unbekannter Suchmodus.');
  const base   = baseParams(body);
  const nearby = !!body.nearby;
  const tasks  = [];
  const add    = (kind, params, meta = {}) => tasks.push({ id: tasks.length, kind, params, ...meta });
  const plan   = { mode, base, tasks, requested: {} };

  if (mode === 'ow' || mode === 'rt') {
    const from = expandAirports(body.from, nearby);
    const to   = expandAirports(body.to, nearby);
    const date = checkDate(body.date, 'Abflug');
    if (date < todayIso()) throw new InputError('Das Abflugdatum liegt in der Vergangenheit.');
    plan.requested = { from, to, date };

    if (mode === 'ow') {
      const flex = int(body.flex, 0, 3, 0);
      for (const d of dateRange(date, flex)) {
        add('main', { ...base, type: '2', departure_id: from, arrival_id: to, outbound_date: d }, { date: d });
      }
    } else {
      const ret = checkDate(body.return_date, 'Rückflug');
      if (ret < date) throw new InputError('Der Rückflug liegt vor dem Hinflug.');
      plan.requested.returnDate = ret;
      const flex = int(body.flex, 0, 2, 0);
      const outs = dateRange(date, flex);
      const rets = dateRange(ret, flex);
      for (const d of outs) for (const r of rets) {
        if (r < d) continue;
        add('main', { ...base, type: '1', departure_id: from, arrival_id: to, outbound_date: d, return_date: r },
          { date: d, returnDate: r });
      }
      if (body.compare_oneways) {
        for (const d of outs) add('owOut', { ...base, type: '2', departure_id: from, arrival_id: to, outbound_date: d }, { date: d });
        for (const r of rets) add('owRet', { ...base, type: '2', departure_id: to, arrival_id: from, outbound_date: r }, { date: r });
      }
    }
  } else {
    const rawLegs = Array.isArray(body.legs) ? body.legs : [];
    if (rawLegs.length < 2 || rawLegs.length > 6) throw new InputError('Der Trip-Planer braucht 2 bis 6 Strecken.');
    let prev = todayIso();
    const legs = rawLegs.map((l, i) => {
      const d = checkDate(l.date, `Strecke ${i + 1}`);
      if (d < prev) throw new InputError(`Strecke ${i + 1}: Datum liegt vor der vorherigen Strecke oder in der Vergangenheit.`);
      prev = d;
      return { departure_id: expandAirports(l.from, nearby), arrival_id: expandAirports(l.to, nearby), date: d };
    });
    plan.requested = { legs };
    add('main', { ...base, type: '3', multi_city_json: JSON.stringify(legs) }, { date: legs[0].date });
    if (body.compare_oneways) {
      legs.forEach((l, i) => add('owLeg',
        { ...base, type: '2', departure_id: l.departure_id, arrival_id: l.arrival_id, outbound_date: l.date },
        { leg: i, date: l.date }));
    }
  }

  // Verkaufsland-Vergleich: nur für das Wunschdatum, sonst explodiert die Anzahl
  if (body.compare_countries) {
    const center = tasks.find(t => t.kind === 'main'
      && t.date === plan.requested.date
      && (mode !== 'rt' || t.returnDate === plan.requested.returnDate))
      || tasks.find(t => t.kind === 'main');
    if (center) {
      for (const gl of COMPARE_COUNTRIES) {
        if (gl === base.gl) continue;
        add('country', { ...center.params, gl }, { date: center.date, returnDate: center.returnDate, gl });
      }
    }
  }

  if (!tasks.some(t => t.kind === 'main')) throw new InputError('Alle gewählten Daten liegen in der Vergangenheit.');
  return plan;
}

/* ══════════════════════════════════════════════════════════
   SERPAPI-ZUGRIFF mit Cache
══════════════════════════════════════════════════════════ */
const NO_RESULTS_RE = /hasn't returned any results|no results/i;

async function serp(params, ctx) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const qs = new URLSearchParams(entries);
  const cacheKey = ctx.cache ? new Request(`${ctx.origin}/__serpcache?${qs}`) : null;

  if (cacheKey) {
    const hit = await ctx.cache.match(cacheKey).catch(() => null);
    if (hit) { ctx.stats.cached++; return hit.json(); }
  }

  qs.set('api_key', ctx.apiKey);
  ctx.stats.fetched++;
  const res = await ctx.fetch(`${SERPAPI_URL}?${qs}`);
  let json;
  try { json = await res.json(); }
  catch { throw new Error(`SerpAPI antwortet nicht (HTTP ${res.status}).`); }

  if (json.error) {
    if (NO_RESULTS_RE.test(json.error)) return { best_flights: [], other_flights: [], destinations: [] };
    throw new Error(json.error);
  }
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);

  if (cacheKey) {
    const stored = new Response(JSON.stringify(json), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ctx.ttl}` },
    });
    ctx.waitUntil(ctx.cache.put(cacheKey, stored).catch(() => {}));
  }
  return json;
}

async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { ok: true, data: await fn(items[i]) }; }
      catch (e) { out[i] = { ok: false, error: e.message || String(e) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* Antwort verschlanken: beste Flüge + günstigste übrige, max. MAX_FLIGHTS. */
export function summarize(json) {
  const strip = f => {
    const { carbon_emissions, ...rest } = f;
    return rest;
  };
  const best  = (json.best_flights  || []).map(f => ({ ...strip(f), _best: true }));
  const other = (json.other_flights || []).map(strip)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const flights = [...best, ...other].slice(0, MAX_FLIGHTS);
  const prices  = flights.map(f => f.price).filter(p => typeof p === 'number');
  return {
    flights,
    price_insights: json.price_insights || null,
    cheapest: prices.length ? Math.min(...prices) : null,
  };
}

function cheapestFlight(summary) {
  if (!summary?.flights?.length) return null;
  return summary.flights
    .filter(f => typeof f.price === 'number')
    .sort((a, b) => a.price - b.price)[0] || null;
}

const publicQuery = params => ({ ...params });

/* ══════════════════════════════════════════════════════════
   AKTIONEN
══════════════════════════════════════════════════════════ */
async function actionSearch(body, ctx) {
  const plan = buildPlan(body);
  if (plan.tasks.length > ctx.maxQueries) {
    throw new InputError(`Diese Suche bräuchte ${plan.tasks.length} Abfragen (Limit ${ctx.maxQueries}). `
      + 'Bitte weniger flexible Tage oder Vergleiche wählen.');
  }

  const raw = await runPool(plan.tasks, CONCURRENCY, t => serp(t.params, ctx));
  const results = [];
  const errors  = [];
  const owOut = {}, owRet = {}, owLeg = {};

  plan.tasks.forEach((t, i) => {
    const r = raw[i];
    if (!r.ok) { errors.push({ kind: t.kind, date: t.date, gl: t.gl, error: r.error }); return; }
    const s = summarize(r.data);
    const entry = { kind: t.kind, date: t.date, returnDate: t.returnDate, gl: t.params.gl, leg: t.leg,
      query: publicQuery(t.params), ...s };
    if (t.kind === 'main' || t.kind === 'country') results.push(entry);
    else if (t.kind === 'owOut') owOut[t.date] = entry;
    else if (t.kind === 'owRet') owRet[t.date] = entry;
    else if (t.kind === 'owLeg') owLeg[t.leg] = entry;
  });

  if (!results.length) {
    throw new Error(errors[0]?.error || 'Keine Ergebnisse von SerpAPI.');
  }

  // Zwei Einzeltickets (Hin + Rück getrennt) je Datumspaar
  const separate = {};
  if (plan.mode === 'rt') {
    for (const r of results.filter(x => x.kind === 'main')) {
      const o = cheapestFlight(owOut[r.date]);
      const b = cheapestFlight(owRet[r.returnDate]);
      if (!o || !b) continue;
      separate[`${r.date}|${r.returnDate}`] = {
        price: o.price + b.price,
        outbound: { flight: o, query: owOut[r.date].query },
        inbound:  { flight: b, query: owRet[r.returnDate].query },
      };
    }
  }

  // Trip-Planer: jede Strecke als Einzelticket
  let legsSeparate = null;
  if (plan.mode === 'mc' && Object.keys(owLeg).length) {
    const legs = plan.requested.legs.map((_, i) => {
      const e = owLeg[i];
      const f = cheapestFlight(e);
      return f ? { leg: i, flight: f, query: e.query } : null;
    });
    if (legs.every(Boolean)) legsSeparate = { price: legs.reduce((s, l) => s + l.flight.price, 0), legs };
  }

  return {
    mode: plan.mode,
    currency: plan.base.currency,
    requested: plan.requested,
    results,
    separate,
    legsSeparate,
    errors,
    stats: { queries: plan.tasks.length, ...ctx.stats },
  };
}

/* Von der Antwort zurückgeschickte Abfrage prüfen (Rückflug/Buchung). */
const QUERY_KEYS = new Set(['engine', 'type', 'departure_id', 'arrival_id', 'outbound_date', 'return_date',
  'multi_city_json', 'adults', 'travel_class', 'stops', 'bags', 'max_price', 'currency', 'hl', 'gl',
  'deep_search', 'show_hidden']);

export function sanitizeQuery(q) {
  if (!q || typeof q !== 'object') throw new InputError('Abfrage fehlt.');
  const out = {};
  for (const [k, v] of Object.entries(q)) {
    if (!QUERY_KEYS.has(k)) continue;
    const s = String(v);
    if (s.length > 2000) throw new InputError(`Parameter ${k} ist zu lang.`);
    out[k] = s;
  }
  out.engine = 'google_flights';
  return out;
}

function checkToken(t) {
  if (typeof t !== 'string' || !t || t.length > 4000) throw new InputError('Token fehlt oder ist ungültig.');
  return t;
}

async function actionNext(body, ctx) {
  const query = sanitizeQuery(body.query);
  const json  = await serp({ ...query, departure_token: checkToken(body.departure_token) }, ctx);
  return { query, ...summarize(json), stats: ctx.stats };
}

async function actionBooking(body, ctx) {
  const query = sanitizeQuery(body.query);
  const json  = await serp({ ...query, booking_token: checkToken(body.booking_token) }, ctx);
  return {
    booking_options: json.booking_options || [],
    baggage_prices:  json.baggage_prices || null,
    price_insights:  json.price_insights || null,
    stats: ctx.stats,
  };
}

async function actionExplore(body, ctx) {
  const base = baseParams(body);
  const p = {
    engine:       'google_travel_explore',
    departure_id: expandAirports(body.from, !!body.nearby),
    currency:     base.currency,
    hl:           base.hl,
    gl:           base.gl,
    adults:       base.adults,
    type:         body.type === '2' ? '2' : '1',
  };
  if (base.stops) p.stops = base.stops;
  if (base.max_price) p.max_price = base.max_price;
  if (body.outbound_date) {
    p.outbound_date = checkDate(body.outbound_date, 'Abflug');
    if (p.type === '1' && body.return_date) p.return_date = checkDate(body.return_date, 'Rückflug');
  } else if (p.type === '1') {
    p.travel_duration = String(int(body.travel_duration, 1, 3, 2));
  }
  const json = await serp(p, ctx);
  const destinations = (json.destinations || [])
    .filter(d => typeof d.flight_price === 'number' && d.destination_airport?.code)
    .sort((a, b) => a.flight_price - b.flight_price)
    .slice(0, 60)
    .map(({ gps_coordinates, ...d }) => d);
  return { query: p, destinations, stats: ctx.stats };
}

const ACTIONS = { search: actionSearch, next: actionNext, booking: actionBooking, explore: actionExplore };

/* ══════════════════════════════════════════════════════════
   HTTP-EINSTIEG
══════════════════════════════════════════════════════════ */
function corsHeaders(request, env) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow   = !allowed.length ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-SerpApi-Key',
    'Vary': 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export async function handleRequest(request, env = {}, execCtx = {}, deps = {}) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Nur POST wird unterstützt.' }, 405, cors);

  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin  = request.headers.get('Origin');
  if (allowed.length && origin && !allowed.includes(origin)) {
    return json({ error: 'Origin nicht erlaubt.' }, 403, cors);
  }

  const apiKey = request.headers.get('X-SerpApi-Key') || env.SERPAPI_KEY;
  if (!apiKey) {
    return json({ error: 'Kein SerpAPI-Key konfiguriert. Secret SERPAPI_KEY im Cloudflare-Projekt setzen '
      + 'oder einen eigenen Key in den Einstellungen eintragen.' }, 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Ungültiger JSON-Body.' }, 400, cors); }

  const action = ACTIONS[body?.action];
  if (!action) return json({ error: 'Unbekannte Aktion.' }, 400, cors);

  const ctx = {
    apiKey,
    fetch:      deps.fetch || ((...a) => fetch(...a)),
    cache:      null,
    origin:     new URL(request.url).origin,
    ttl:        int(env.CACHE_TTL, 0, 86400, DEFAULT_CACHE_TTL),
    maxQueries: int(env.MAX_QUERIES, 1, 200, DEFAULT_MAX_QUERY),
    waitUntil:  p => (execCtx.waitUntil ? execCtx.waitUntil(p) : p),
    stats:      { fetched: 0, cached: 0 },
  };
  if (ctx.ttl > 0) ctx.cache = deps.cache !== undefined ? deps.cache : (globalThis.caches?.default || null);

  try {
    return json(await action(body, ctx), 200, cors);
  } catch (e) {
    const status = e instanceof InputError ? 400 : 502;
    return json({ error: e.message || String(e) }, status, cors);
  }
}
