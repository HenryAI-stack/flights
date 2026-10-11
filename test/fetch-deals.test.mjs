import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, parseSearchPage, toDeal } from '../scripts/fetch-deals.mjs';

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

test('Suchseite als Fallback: Deal-Links ab Warschau', () => {
  const html = `<div><a href="https://www.secretflying.com/posts/warsaw-bangkok/"><h2>Warsaw, Poland to Bangkok, Thailand for only 1599 PLN roundtrip</h2></a>
    <a href="https://www.secretflying.com/posts/warsaw-bangkok/">mehr</a>
    <a href="https://www.secretflying.com/posts/vienna-rome/">Vienna, Austria to Rome, Italy for only €29</a></div>`;
  const deals = parseSearchPage(html);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].to, 'Bangkok, Thailand');
  assert.equal(deals[0].price, '1599 PLN');
});

test('Expired im Titel wird erkannt und entfernt', () => {
  const d = toDeal({ title: 'EXPIRED: Warsaw, Poland to Lisbon, Portugal for only €49 one way', link: 'x' });
  assert.equal(d.expired, true);
  assert.equal(d.to, 'Lisbon, Portugal');
  assert.equal(d.trip, 'oneway');
});

test('Suchseite: relative Links, title-Attribut und URL-Slug als Titel', () => {
  const html = `<a href="/posts/warsaw-poland-to-oslo-norway-for-only-19-one-way/"><img src="x.jpg"></a>
    <a title="Warsaw, Poland to Rome, Italy for only €25 roundtrip" href="https://www.secretflying.com/posts/x-rome/"><img></a>
    <a href="https://www.secretflying.com/posts/vienna-austria-to-rome-italy/">Vienna</a>`;
  const deals = parseSearchPage(html);
  assert.equal(deals.links, 3);
  assert.equal(deals.length, 2);
  assert.equal(deals[0].link, 'https://www.secretflying.com/posts/warsaw-poland-to-oslo-norway-for-only-19-one-way/');
  assert.equal(deals[0].trip, 'oneway');
  assert.equal(deals[1].to, 'Rome, Italy');
  assert.equal(deals[1].price, '€25');
});
