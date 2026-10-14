import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, parseSearchPage, parseFly4free, parseFly4freeRss, combineFly4free, toDeal, mergeDeals } from '../scripts/fetch-deals.mjs';

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

test('Fly4free (echte Struktur): Angebote, Abfahrtsort, Preis, ausverkauft, Werbung übersprungen', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./fixtures/fly4free-warszawa.html', import.meta.url), 'utf8');
  const deals = parseFly4free(html);
  assert.equal(deals.length, 5);               // „Wczytaj więcej“ und Sidebar-Werbung zählen nicht
  assert.deepEqual(deals[0], {
    title: 'Przedłużony weekend w cieniu Akropolu City break w Atenach za 529 PLN',
    from: 'Warschau', to: 'Ateny', price: '529 PLN', trip: null, date: null, undated: true,
    expired: false, link: 'https://www.fly4free.pl/w-cieniu-akropolu-za-529-pln/', source: 'fly4free',
  });
  assert.equal(deals[1].from, 'Krakau');
  assert.equal(deals[1].price, 'ab 293 PLN');
  assert.equal(deals[2].title, 'Tunezja z all inclusive za 1981 PLN 4* hotel Skanes Serail & Aquapark');
  assert.equal(deals[3].from, null);
  assert.equal(deals[3].to, 'Szalona Środa w PLL LOT');
  assert.equal(deals[4].expired, true);        // offer--soldout
});

test('mergeDeals: Angebote ohne Datum bekommen den Tag des ersten Auftauchens und behalten ihn', () => {
  const fresh = [{ link: 'f1', undated: true, date: null, expired: false }];
  const first = mergeDeals(fresh, [], { today: '2026-10-14' }).deals;
  assert.deepEqual(first, [{ link: 'f1', date: '2026-10-14', expired: false }]);
  const later = mergeDeals(fresh, first, { today: '2026-10-20' }).deals;
  assert.equal(later[0].date, '2026-10-14');
});

test('Fly4free-Feed liefert Datum; Seite und Feed werden kombiniert, nur Flüge', async () => {
  const { readFile } = await import('node:fs/promises');
  const fx = f => readFile(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
  const rss = parseFly4freeRss(await fx('fly4free-warszawa-feed.xml'));
  assert.equal(rss.length, 4);
  assert.deepEqual(rss[2], {
    title: 'SUPER Majówka w Turcji od 293 PLN Tanie loty Pegasus Airlines',
    from: 'Warschau', to: 'Ankary', price: 'ab 293 PLN', trip: null, date: '2026-10-14',
    expired: false, link: 'https://www.fly4free.pl/tanie-loty-pegasus-airlines-do-turcji-od-293-pln/',
    source: 'fly4free', package: false,
  });
  assert.equal(rss[0].package, true);             // Kategorie „pakiety“ (Flug + Hotel)
  assert.equal(rss[1].package, true);             // Kategorie „Wczasy“
  assert.equal(rss[3].to, 'Wyspy Kanaryjskie');
  assert.equal(rss[3].price, 'ab 281 PLN');

  const all = combineFly4free(parseFly4free(await fx('fly4free-warszawa.html')), rss);
  // Seite: Ateny (pakiety laut Feed), Tunezja + Wietnam (Hotel im Titel) fallen raus;
  // Turcja (Datum aus Feed) und Szalona Środa bleiben, dazu Kanaren nur aus dem Feed
  assert.deepEqual(all.map(d => d.link.split('/')[3]), [
    'tanie-loty-pegasus-airlines-do-turcji-od-293-pln', 'sprawdz-szalona-srode-w-pll-lot-loty-od-449-pln',
    'wyspy-kanaryjskie-tanie-loty-od-281pln',
  ]);
  assert.equal(all[0].to, 'Turcja');              // Details von der Seite …
  assert.equal(all[0].date, '2026-10-14');        // … Datum aus dem Feed
  assert.equal('undated' in all[0], false);
  assert.equal(all[1].undated, true);             // nicht im Feed
  assert.equal('package' in all[2], false);
});
