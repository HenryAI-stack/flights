// Ausführen: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, buildPlan, expandAirports, dateRange, addDays, sanitizeQuery } from '../lib/flights-core.js';

const today = new Date().toISOString().slice(0, 10);
const inDays = n => addDays(today, n);

function fakeSerp(priceFor) {
  const calls = [];
  const fetch = async url => {
    const p = Object.fromEntries(new URL(url).searchParams);
    calls.push(p);
    const price = priceFor(p);
    const body = price === null
      ? { error: "Google Flights hasn't returned any results for this query." }
      : { best_flights: [{ price, flights: [{ departure_airport: { id: 'VIE' } }], departure_token: 'dt' }],
          other_flights: [{ price: price + 50, flights: [] }],
          price_insights: { lowest_price: price } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch, calls };
}

function memCache() {
  const m = new Map();
  return {
    match: async req => (m.has(req.url) ? new Response(m.get(req.url)) : undefined),
    put: async (req, res) => { m.set(req.url, await res.text()); },
  };
}

async function call(body, { env = { SERPAPI_KEY: 'k' }, deps, headers = {} } = {}) {
  const req = new Request('https://app.example/api/flights', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  });
  const res = await handleRequest(req, env, {}, deps);
  return { status: res.status, data: await res.json() };
}

test('expandAirports: Nachbarflughäfen und Validierung', () => {
  assert.equal(expandAirports('vie', false), 'VIE');
  assert.equal(expandAirports('VIE', true), 'VIE,BTS');
  assert.equal(expandAirports('VIE, MUC', true), 'VIE,BTS,MUC,MEM,NUE,SZG');
  assert.throws(() => expandAirports('Wien', false), /IATA/);
});

test('dateRange lässt vergangene Tage aus', () => {
  assert.deepEqual(dateRange(today, 1), [today, inDays(1)]);
  assert.equal(dateRange(inDays(10), 3).length, 7);
});

test('Plan: Hin/Rück mit ±1 Tag und Einzelticket-Vergleich', () => {
  const plan = buildPlan({ mode: 'rt', from: 'VIE', to: 'LHR', date: inDays(10), return_date: inDays(17),
    flex: 1, compare_oneways: true });
  assert.equal(plan.tasks.filter(t => t.kind === 'main').length, 9);
  assert.equal(plan.tasks.filter(t => t.kind === 'owOut').length, 3);
  assert.equal(plan.tasks.filter(t => t.kind === 'owRet').length, 3);
  const ret = plan.tasks.find(t => t.kind === 'owRet');
  assert.equal(ret.params.departure_id, 'LHR');
  assert.equal(ret.params.arrival_id, 'VIE');
});

test('Plan: Stopp-Filter wird auf SerpAPI-Werte abgebildet', () => {
  const p = buildPlan({ mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(5), stops: '1', bags: '1', max_price: '200' });
  assert.equal(p.tasks[0].params.stops, '1');
  assert.equal(p.tasks[0].params.bags, '1');
  assert.equal(p.tasks[0].params.max_price, '200');
  const any = buildPlan({ mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(5), stops: '0' });
  assert.equal(any.tasks[0].params.stops, undefined);
});

test('Plan: Verkaufsländer nur für das Wunschdatum', () => {
  const p = buildPlan({ mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(10), flex: 2, gl: 'at', compare_countries: true });
  const c = p.tasks.filter(t => t.kind === 'country');
  assert.deepEqual(c.map(t => t.gl), ['de', 'ch', 'gb', 'us']);
  assert.ok(c.every(t => t.params.outbound_date === inDays(10)));
});

test('Suche: API-Key kommt aus dem Secret und nie aus dem Body', async () => {
  const s = fakeSerp(() => 100);
  const { status } = await call({ action: 'search', mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(5) },
    { deps: { fetch: s.fetch, cache: null } });
  assert.equal(status, 200);
  assert.equal(s.calls[0].api_key, 'k');
  assert.equal(s.calls[0].engine, 'google_flights');
  assert.equal(s.calls[0].show_hidden, 'true');
});

test('Suche: flexible Daten liefern Kalender, günstigster Tag gewinnt', async () => {
  const s = fakeSerp(p => (p.outbound_date === inDays(9) ? 80 : 150));
  const { data } = await call({ action: 'search', mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(10), flex: 2 },
    { deps: { fetch: s.fetch, cache: null } });
  assert.equal(data.results.length, 5);
  const cheapest = data.results.reduce((a, b) => (a.cheapest < b.cheapest ? a : b));
  assert.equal(cheapest.date, inDays(9));
  assert.equal(cheapest.cheapest, 80);
  assert.equal(cheapest.query.outbound_date, inDays(9));
  assert.equal(cheapest.query.api_key, undefined);
});

test('Suche: zwei Einzeltickets werden pro Datumspaar summiert', async () => {
  const s = fakeSerp(p => (p.type === '1' ? 400 : p.departure_id === 'VIE' ? 120 : 90));
  const { data } = await call({ action: 'search', mode: 'rt', from: 'VIE', to: 'LHR', date: inDays(10),
    return_date: inDays(15), compare_oneways: true }, { deps: { fetch: s.fetch, cache: null } });
  const sep = data.separate[`${inDays(10)}|${inDays(15)}`];
  assert.equal(sep.price, 210);
  assert.equal(sep.outbound.query.departure_id, 'VIE');
  assert.equal(sep.inbound.query.departure_id, 'LHR');
});

test('Suche: Trip-Planer vergleicht mit Einzelstrecken', async () => {
  const s = fakeSerp(p => (p.type === '3' ? 500 : 100));
  const { data } = await call({ action: 'search', mode: 'mc', compare_oneways: true, legs: [
    { from: 'VIE', to: 'BCN', date: inDays(10) }, { from: 'BCN', to: 'LIS', date: inDays(13) },
    { from: 'LIS', to: 'VIE', date: inDays(17) }] }, { deps: { fetch: s.fetch, cache: null } });
  assert.equal(data.legsSeparate.price, 300);
  assert.equal(JSON.parse(s.calls.find(c => c.type === '3').multi_city_json).length, 3);
});

test('Suche: "keine Ergebnisse" ist kein Fehler', async () => {
  const s = fakeSerp(p => (p.outbound_date === inDays(10) ? 99 : null));
  const { status, data } = await call({ action: 'search', mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(10), flex: 1 },
    { deps: { fetch: s.fetch, cache: null } });
  assert.equal(status, 200);
  assert.equal(data.results.length, 3);
  assert.equal(data.errors.length, 0);
});

test('Suche: Abfrage-Limit greift', async () => {
  const s = fakeSerp(() => 1);
  const { status, data } = await call({ action: 'search', mode: 'rt', from: 'VIE', to: 'LHR', date: inDays(10),
    return_date: inDays(15), flex: 2, compare_oneways: true }, { env: { SERPAPI_KEY: 'k', MAX_QUERIES: '10' },
    deps: { fetch: s.fetch, cache: null } });
  assert.equal(status, 400);
  assert.match(data.error, /35 Abfragen/);
  assert.equal(s.calls.length, 0);
});

test('Cache: zweite identische Suche fragt SerpAPI nicht erneut', async () => {
  const s = fakeSerp(() => 100);
  const cache = memCache();
  const body = { action: 'search', mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(5) };
  await call(body, { deps: { fetch: s.fetch, cache } });
  await new Promise(r => setTimeout(r, 10));
  const { data } = await call(body, { deps: { fetch: s.fetch, cache } });
  assert.equal(s.calls.length, 1);
  assert.equal(data.stats.cached, 1);
});

test('Rückflug: departure_token wird mit der ursprünglichen Abfrage gesendet', async () => {
  const s = fakeSerp(() => 300);
  const query = { engine: 'google_flights', type: '1', departure_id: 'VIE', arrival_id: 'LHR',
    outbound_date: inDays(10), return_date: inDays(15), api_key: 'evil', foo: 'bar' };
  const { status } = await call({ action: 'next', query, departure_token: 'tok' }, { deps: { fetch: s.fetch, cache: null } });
  assert.equal(status, 200);
  assert.equal(s.calls[0].departure_token, 'tok');
  assert.equal(s.calls[0].api_key, 'k');
  assert.equal(s.calls[0].foo, undefined);
  assert.equal(s.calls[0].return_date, inDays(15));
});

test('sanitizeQuery erzwingt google_flights', () => {
  assert.equal(sanitizeQuery({ engine: 'google', departure_id: 'VIE' }).engine, 'google_flights');
});

test('Eigener Key im Header hat Vorrang, ohne Key gibt es eine klare Meldung', async () => {
  const s = fakeSerp(() => 1);
  await call({ action: 'search', mode: 'ow', from: 'VIE', to: 'LHR', date: inDays(5) },
    { deps: { fetch: s.fetch, cache: null }, headers: { 'X-SerpApi-Key': 'mine' } });
  assert.equal(s.calls[0].api_key, 'mine');
  const { status, data } = await call({ action: 'search' }, { env: {} });
  assert.equal(status, 500);
  assert.match(data.error, /SERPAPI_KEY/);
});

test('Explore: Ziele nach Preis sortiert, ohne Flugpreis ausgefiltert', async () => {
  const fetch = async url => {
    const p = Object.fromEntries(new URL(url).searchParams);
    assert.equal(p.engine, 'google_travel_explore');
    assert.equal(p.departure_id, 'VIE,BTS');
    assert.equal(p.travel_duration, '2');
    return new Response(JSON.stringify({ destinations: [
      { name: 'A', flight_price: 200, destination_airport: { code: 'AAA' } },
      { name: 'B', hotel_price: 50 },
      { name: 'C', flight_price: 40, destination_airport: { code: 'CCC' } }] }));
  };
  const { data } = await call({ action: 'explore', from: 'VIE', nearby: true }, { deps: { fetch, cache: null } });
  assert.deepEqual(data.destinations.map(d => d.name), ['C', 'A']);
});
