import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, parseSearchPage, toDeal, mergeDeals } from '../scripts/fetch-deals.mjs';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Warsaw, Poland to Tokyo, Japan for only €389 roundtrip]]></title>
  <link>https://www.secretflying.com/posts/warsaw-tokyo-389/</link>
  <pubDate>Fri, 09 Oct 2026 08:12:00 +0000</pubDate><category>Asia</category></item>
<item><title>Non-stop from Warsaw, Poland to New York, USA for only &#8364;299 roundtrip</title>
  <link>https://www.secretflying.com/posts/warsaw-nyc/</link>
  <pubDate>Mon, 05 Oct 2026 10:00:00 +0000</pubDate><category>Expired</category></item>
<item><title>Berlin, Germany to Warsaw, Poland for only €19 one way</title>
  <link>https://www.secretflying.com/posts/berlin-warsaw/</link><pubDate>Sun, 04 Oct 2026 10:00:00 +0000</pubDate></item>
</channel></rss>`;

test('RSS: nur Deals ab Warschau, mit Preis, Ziel, Datum und Status', () => {
  const deals = parseRss(RSS);
  assert.equal(deals.length, 2);
  assert.deepEqual(deals[0], {
    title: 'Warsaw, Poland to Tokyo, Japan for only €389 roundtrip', from: 'Warsaw, Poland', to: 'Tokyo, Japan',
    price: '€389', trip: 'roundtrip', date: '2026-10-09', expired: false,
    link: 'https://www.secretflying.com/posts/warsaw-tokyo-389/',
  });
  assert.equal(deals[1].from, 'Warsaw, Poland');
  assert.equal(deals[1].price, '€299');
  assert.equal(deals[1].expired, true);
});

test('Expired im Titel wird erkannt und entfernt', () => {
  const d = toDeal({ title: 'EXPIRED: Warsaw, Poland to Lisbon, Portugal for only €49 one way', link: 'x' });
  assert.equal(d.expired, true);
  assert.equal(d.to, 'Lisbon, Portugal');
  assert.equal(d.trip, 'oneway');
});

test('Suchseite (echte Struktur): Artikel, Sammeldeals, abgelaufen, gesperrte/Werbe-Kacheln übersprungen', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./fixtures/secretflying-search.html', import.meta.url), 'utf8');
  const deals = parseSearchPage(html);
  assert.equal(deals.articles, 5);              // Werbekachel zählt nicht, gesperrter Deal schon
  assert.equal(deals.length, 4);                 // gesperrter Business-Deal ohne Titel fällt weg
  const [mombasa, sharjah, expired, cairo] = deals;
  assert.equal(mombasa.title, 'Katowice or Warsaw, Poland to Mombasa, Kenya from only €335 roundtrip');
  assert.equal(mombasa.from, 'Katowice or Warsaw, Poland');
  assert.equal(mombasa.to, 'Mombasa, Kenya');
  assert.equal(mombasa.price, '€335');
  assert.equal(mombasa.date, '2026-10-04');
  assert.equal(mombasa.expired, false);
  assert.equal(sharjah.from, 'European cities (inkl. Warschau)');
  assert.equal(sharjah.to, 'Sharjah, UAE');
  assert.equal(expired.expired, true);
  assert.equal(expired.title, 'Warsaw, Poland to Mombasa, Kenya for only €256 roundtrip');
  assert.equal(cairo.price, '€201');
  assert.equal(cairo.date, '2026-08-22');
});

test('mergeDeals: alte Deals bleiben, neue Daten gewinnen, zu alte fallen weg', () => {
  const prev = [
    { link: 'a', title: 'A', date: '2026-10-10', expired: false },
    { link: 'b', title: 'B', date: '2026-10-01', expired: false },
    { link: 'c', title: 'C', date: '2026-05-01', expired: true },
  ];
  const fresh = [
    { link: 'a', title: 'A', date: null, expired: true },
    { link: 'd', title: 'D', date: '2026-10-12', expired: false },
  ];
  const { deals, kept } = mergeDeals(fresh, prev, { today: '2026-10-13' });
  assert.equal(kept, 1);
  assert.deepEqual(deals.map(d => d.link), ['d', 'b', 'a']);
  const a = deals.find(d => d.link === 'a');
  assert.equal(a.expired, true);
  assert.equal(a.date, '2026-10-10');
});

test('mergeDeals: ohne alte Liste und mit Obergrenze', () => {
  const fresh = [1, 2, 3].map(i => ({ link: `l${i}`, date: `2026-10-0${i}`, expired: false }));
  assert.deepEqual(mergeDeals(fresh, undefined, { max: 2 }).deals.map(d => d.link), ['l3', 'l2']);
});
