// Holt Flug-Deals ab Warschau von Secret Flying und Fly4free.pl und schreibt sie als JSON.
// Läuft täglich in .github/workflows/deploy.yml; die Seite zeigt deals.json an
// und verlinkt jeden Deal zurück auf die Quelle.
//
// Aufruf: node scripts/fetch-deals.mjs <ausgabe.json> [--fallback <url der alten deals.json>]
// Die alte Liste wird mit den neuen Deals zusammengeführt (siehe mergeDeals).

const CITY        = 'Warsaw';
const RSS_URL     = `https://www.secretflying.com/?s=${CITY}&feed=rss2`;
const SEARCH_URL  = `https://www.secretflying.com/search2/?cityFrom=${CITY}&month=&showOldDeals=on&cityTo=`;
const MAX_DEALS   = 100;
const RSS_PAGES   = 8;       // WordPress liefert je Feed-Seite ~10 Suchtreffer
const SEARCH_PAGES = 6;      // Suchseite: ~10 Deals je Seite (inkl. alter Deals)
// Folgeseiten genau im Format, das die Seite selbst nachlädt (snews_alp.nextLink)
const searchPageUrl = n => n === 1 ? SEARCH_URL
  : `https://www.secretflying.com/search2/page/${n}/?cityFrom=${CITY}&month&showOldDeals=on&cityTo`;
const F4F_URL     = 'https://www.fly4free.pl/tanie-loty/z-warszawy/';
const F4F_PAGES   = 3;       // ~22 Angebote je Seite
const f4fPageUrl  = n => n === 1 ? F4F_URL : `${F4F_URL}page/${n}/`;
const F4F_RSS_PAGES = 3;     // ~20 Beiträge je Feed-Seite, liefert das Veröffentlichungsdatum
const f4fRssUrl   = n => `${F4F_URL}feed/${n > 1 ? `?paged=${n}` : ''}`;
const PAGE_DELAY_MS = 4000;  // Abstand zwischen Seitenabrufen, sonst antwortet die Seite mit 403
const sleep = ms => new Promise(r => setTimeout(r, ms));
const USER_AGENT  = 'Mozilla/5.0 (compatible; SkySearchDeals/1.0; +https://henryai-stack.github.io/flights/)';

const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const PRICE_RE = /(?:€|\$|£)\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|EUR|PLN|zł|USD|GBP)/i;

/* "Warsaw, Poland to Tokyo, Japan for only €389 roundtrip" → Deal-Objekt,
   oder null, wenn der Deal nicht ab Warschau geht. */
export function toDeal({ title, link, date, expired = false }, { fromCityPage = false } = {}) {
  title = decode(title);
  if (!title || !link) return null;
  const isExpired = expired || /\bexpired\b/i.test(title);
  const clean = title
    .replace(/\*+\s*expired\s*\*+|\[?expired\]?\s*[-:–]/gi, '')
    .replace(/^[^\p{L}\d]+/u, '')                          // Emojis, Zeichen am Anfang
    .replace(/^(?:[A-Z][A-Z0-9 '!&-]*:\s*)+/, '')             // "LAST MINUTE:", "ERROR FARE:"
    .trim();
  const m = clean.match(/^(.*?)\s+to\s+(.+?)(?:\s+for\s+(?:only\s+)?(.*))?$/i);
  if (!m) return null;
  const viaCity = new RegExp(`\\b${CITY}\\b`, 'i').test(m[1]);
  // Auf der Städte-Suchseite gehören alle Deals zu Warschau (auch "European cities to …")
  if (!viaCity && !fromCityPage) return null;
  const price = (m[3] || clean).match(PRICE_RE)?.[0] || null;
  return {
    title: clean,
    from: (() => {
      const f = m[1].replace(/^(?:non-?stop|direct)\s+(?:flights?\s+)?from\s+/i, '').replace(/^from\s+/i, '').trim();
      return viaCity ? f : `${f} (inkl. Warschau)`;
    })(),
    to: m[2].replace(/\s+(?:for|from)\s+.*$/i, '').trim(),
    price,
    trip: /one[- ]?way/i.test(clean) ? 'oneway' : /round[- ]?trip|return/i.test(clean) ? 'roundtrip' : null,
    date: date ? new Date(date).toISOString().slice(0, 10) : null,
    expired: isExpired,
    link,
  };
}

export function parseRss(xml) {
  const items = [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(([it]) => {
    const tag = t => it.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'i'))?.[1] || '';
    const cats = [...it.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map(c => decode(c[1]));
    return { title: tag('title'), link: decode(tag('link')), date: decode(tag('pubDate')) || null,
      expired: cats.some(c => /expired/i.test(c)) };
  });
  return items.map(toDeal).filter(Boolean);
}

/* Suchseite (search2): jeder Deal ist ein <article class="post-123 … category-warsaw …">
   mit <a class="title-link" href="…">Titel</a>, <time class="entry-date">Oct 4, 2026</time>
   und bei abgelaufenen Deals dem Bild EXPIRED1.gif. Werbe- und gesperrte Kacheln
   (Business-Deals nur für Premium) haben keinen title-link und werden übersprungen. */
export function parseSearchPage(html) {
  const deals = [];
  let articles = 0;
  for (const [art] of String(html).matchAll(/<article\b[\s\S]*?<\/article>/gi)) {
    const cls = art.match(/^<article\b[^>]*class="([^"]*)"/i)?.[1] || '';
    if (!/\bpost-\d+/.test(cls)) continue;
    articles++;
    const tag = art.match(/<a\b([^>]*class="[^"]*\btitle-link\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/i);
    const href = tag?.[1].match(/href="([^"]+)"/)?.[1];
    if (!href || !/\/posts\//.test(href)) continue;
    const title = decode(tag[2]) || decode(tag[1].match(/title="([^"]+)"/)?.[1]);
    const when = decode(art.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i)?.[1]);
    const ts = when ? Date.parse(`${when} UTC`) : NaN;
    const d = toDeal({
      title, link: href,
      date: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
      expired: /EXPIRED1\.gif|\*\*EXPIRED\*\*/i.test(art),
    }, { fromCityPage: new RegExp(`\\bcategory-${CITY.toLowerCase()}\\b`).test(cls) });
    if (d) deals.push(d);
  }
  deals.articles = articles;
  return deals;
}

/* Fly4free.pl, Kategorie „z Warszawy“: jedes Angebot ist ein
   <a href="…" class="js-stats-count offer [offer--soldout]" data-pid="…"> mit
   <span class="offer__description">Ateny z&nbsp;Warszawy</span>, <span class="offer__price">529 PLN</span>
   und <h2 class="offer__title">…</h2>. Die Liste hat kein Datum – das kommt aus dem
   RSS-Feed (combineFly4free), sonst gilt der Tag des ersten Auftauchens (undated, siehe mergeDeals). */
const F4F_FROM = [
  [/^Warszawy$/i, 'Warschau'], [/^Krakowa$/i, 'Krakau'], [/^Polski$/i, 'Polen'], [/^Gdańska$/i, 'Danzig'],
  [/^Katowic$/i, 'Kattowitz'], [/^Wrocławia$/i, 'Breslau'], [/^Poznania$/i, 'Posen'], [/^Łodzi$/i, 'Lodz'],
  [/^(\d+) miast$/i, '$1 Städten'],
];
const stripEmoji = s => s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, '')
  .replace(/^[^\p{L}\d]+/u, '').replace(/\s+/g, ' ').trim();

export function parseFly4free(html) {
  const deals = [];
  for (const [, attrs, body] of String(html).matchAll(/<a\b([^>]*class="[^"]*\boffer\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)) {
    const link = attrs.match(/href="([^"]+)"/)?.[1];
    if (!link || !/^https:\/\/www\.fly4free\.pl\//.test(link)) continue;
    const span = c => decode(body.match(new RegExp(`<span\\b[^>]*class="[^"]*\\b${c}\\b[^"]*"[^>]*>([\\s\\S]*?)<\/span>`, 'i'))?.[1]);
    const title = stripEmoji(decode(body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1]
      || body.match(/<img\b[^>]*alt="([^"]*)"/i)?.[1]));
    if (!title) continue;
    const desc = span('offer__description');
    const m = desc.match(/^(.*\S)\s+z\s+(.+)$/);
    const fromPl = m?.[2].trim();
    const from = fromPl ? F4F_FROM.reduce((f, [re, de]) => re.test(f) ? f.replace(re, de) : f, fromPl) : null;
    deals.push({
      title, from, to: m ? m[1] : desc || null,
      price: span('offer__price').replace(/^od\s+/i, 'ab ') || null,
      trip: null, date: null, undated: true,
      expired: /\boffer--soldout\b/.test(attrs),
      link, source: 'fly4free',
    });
  }
  return deals;
}

// Nur Flüge: Pauschalreisen (Kategorien „Wczasy“, „pakiety“ = Flug + Hotel, „Rejsy“ = Kreuzfahrt)
// fliegen raus. Ohne Feed-Eintrag entscheidet der Titel.
const F4F_PACKAGE_CATS = /^(wczasy|pakiety|rejsy)$/i;
const F4F_PACKAGE_TITLE = /all inclusive|hotel|noclegi?\b|wczasy|rejs|wyżywieniem|pakiet/i;
const F4F_PRICE_RE = /(od\s+)?(\d[\d\s.]*\d|\d)\s*PLN/i;

/* RSS-Feed der Kategorie: Titel, Link, pubDate und Kategorien („do Aten“, „z Warszawy“). */
export function parseFly4freeRss(xml) {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(([it]) => {
    const tag = t => decode(it.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'i'))?.[1]);
    const cats = [...it.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map(c => decode(c[1]));
    const title = stripEmoji(tag('title'));
    const link = tag('link');
    if (!title || !/^https:\/\/www\.fly4free\.pl\//.test(link)) return null;
    const ts = Date.parse(tag('pubDate'));
    const pm = title.match(F4F_PRICE_RE);
    return {
      title, from: cats.some(c => /^z Warszawy$/i.test(c)) ? 'Warschau' : null,
      to: cats.find(c => /^(do|na)\s/i.test(c))?.replace(/^(do|na)\s+/i, '') || null,
      price: pm ? `${pm[1] ? 'ab ' : ''}${pm[2].replace(/\s/g, '')} PLN` : null,
      trip: null, date: Number.isNaN(ts) ? null : new Date(ts).toISOString().slice(0, 10),
      expired: false, link, source: 'fly4free',
      package: cats.some(c => F4F_PACKAGE_CATS.test(c)) || F4F_PACKAGE_TITLE.test(title),
    };
  }).filter(Boolean);
}

/* Seite (Ziel, Abflugort, Preis, ausverkauft) und Feed (Datum, Kategorien) zusammenführen;
   Beiträge, die nur im Feed stehen, kommen dazu. Pauschalreisen werden ausgelassen. */
export function combineFly4free(pageDeals, rssDeals) {
  const rss = new Map(rssDeals.map(d => [d.link, d]));
  const out = [];
  for (const d of pageDeals) {
    const r = rss.get(d.link);
    if (r ? r.package : F4F_PACKAGE_TITLE.test(d.title)) continue;
    if (!r?.date) { out.push(d); continue; }
    const { undated, ...deal } = d;
    out.push({ ...deal, date: r.date });
  }
  const seen = new Set(pageDeals.map(d => d.link));
  for (const { package: pkg, ...d } of rssDeals) if (!pkg && !seen.has(d.link)) out.push(d);
  return out;
}

/* Polnische Angebote (Fly4free) ins Deutsche übersetzen – kostenlos und ohne Key:
   zuerst über den Endpunkt von Google Translate (translate.googleapis.com, client=gtx),
   fällt der aus, über MyMemory (~5000 Zeichen/Tag). Übersetzungen bleiben in deals.json
   und werden über mergeDeals wiederverwendet. */
const TRANSLATE_MAX = 40;    // höchstens so viele Angebote pro Lauf neu übersetzen

async function googleGtx(texts, fetchImpl) {
  const out = [];
  for (const t of texts) {
    const res = await fetchImpl(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=pl&tl=de&dt=t&q=${encodeURIComponent(t)}`);
    if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
    const j = await res.json();
    const text = (j?.[0] || []).map(seg => seg?.[0] || '').join('').trim();
    if (!text) throw new Error('Google: leere Antwort');
    out.push(text);
  }
  return out;
}

async function myMemory(texts, fetchImpl) {
  const out = [];
  for (const t of texts) {
    const res = await fetchImpl(`https://api.mymemory.translated.net/get?langpair=pl|de&q=${encodeURIComponent(t)}`);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const j = await res.json();
    if (j.responseStatus !== 200 && j.responseStatus !== '200') throw new Error(`MyMemory: ${j.responseDetails || j.responseStatus}`);
    out.push(decode(j.responseData?.translatedText) || t);
  }
  return out;
}

const TRANSLATORS = [['google', googleGtx], ['mymemory', myMemory]];

export async function translateDeals(deals, { fetchImpl = fetch, max = TRANSLATE_MAX } = {}) {
  const todo = deals.filter(d => d.source === 'fly4free' && !d.titleDe).slice(0, max);
  if (!todo.length) return { translated: 0, via: null };
  const texts = todo.flatMap(d => [d.title, d.to || '']);
  const keep = texts.map((t, i) => [t, i]).filter(([t]) => t);
  const errors = [];
  for (const [via, translate] of TRANSLATORS) {
    let res;
    try { res = await translate(keep.map(([t]) => t), fetchImpl); }
    catch (e) { errors.push(e.message); continue; }
    const tr = [...texts];
    keep.forEach(([, i], n) => { tr[i] = res[n]; });
    todo.forEach((d, n) => { d.titleDe = tr[2 * n]; d.toDe = d.to ? tr[2 * n + 1] : null; });
    return { translated: todo.length, via };
  }
  throw new Error(errors.join('; '));
}

const KEEP_DAYS = 90;        // bisherige Deals so lange behalten, auch wenn die Quelle sie gerade nicht liefert
const byDate = (a, b) => (a.expired - b.expired) || String(b.date || '').localeCompare(String(a.date || ''));

/* Neue Deals mit der bisher veröffentlichten Liste zusammenführen: Ist eine Seite
   von Secret Flying gerade gesperrt, verschwinden die Deals von dort nicht.
   Neue Daten gewinnen (z. B. Status „abgelaufen“), fehlendes Datum kommt aus der alten Liste. */
export function mergeDeals(fresh, previous = [], { today = new Date().toISOString().slice(0, 10), keepDays = KEEP_DAYS, max = MAX_DEALS } = {}) {
  const cutoff = new Date(Date.parse(today) - keepDays * 864e5).toISOString().slice(0, 10);
  const old = new Map((previous || []).filter(d => d?.link).map(d => [d.link, d]));
  const byLink = new Map();
  for (const d of fresh) {
    const prev = old.get(d.link);
    const { undated, ...deal } = d;
    deal.date = d.date || prev?.date || (undated ? today : null);   // ohne Datum: Tag des ersten Auftauchens
    if (prev?.titleDe && prev.title === d.title) Object.assign(deal, { titleDe: prev.titleDe, toDe: prev.toDe ?? null });
    byLink.set(d.link, deal);
  }
  let kept = 0;
  for (const [link, d] of old) {
    if (byLink.has(link) || (d.date && d.date < cutoff)) continue;
    byLink.set(link, d);
    kept++;
  }
  return { deals: [...byLink.values()].sort(byDate).slice(0, max), kept };
}

async function get(url, referer = null) {
  const headers = { 'user-agent': USER_AGENT, accept: '*/*' };
  if (referer) headers.referer = referer;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return res.text();
}

async function main() {
  const [out, flag, fallbackUrl] = process.argv.slice(2);
  if (!out) throw new Error('Ausgabedatei fehlt.');
  const { writeFile } = await import('node:fs/promises');
  const problems = [];
  const byLink = new Map();
  const counts = {};

  // 1) Suchseite der Städte-Suche (alle Deals ab Warschau, mit Datum und Status)
  counts.search = 0;
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    try {
      if (page > 1) await sleep(PAGE_DELAY_MS);
      const html = await get(searchPageUrl(page), page > 1 ? searchPageUrl(page - 1) : null);
      const found = parseSearchPage(html);
      console.log(`Suchseite ${page}: ${html.length} Zeichen, ${found.articles} Beiträge, davon ${found.length} lesbar`);
      if (page === 1 && !found.articles) problems.push('search: keine Deal-Beiträge im HTML gefunden');
      for (const d of found) if (!byLink.has(d.link)) { byLink.set(d.link, d); counts.search++; }
      if (!found.articles) break;
    } catch (e) {
      if (page === 1) problems.push(`search: ${e.message}`);
      else console.log(`Suchseite ${page}: ${e.message} – Ende`);
      break;
    }
  }

  // 2) RSS-Feed der Textsuche ergänzt, was die Suchseite nicht liefert
  counts.rss = 0;
  for (let page = 1; page <= RSS_PAGES; page++) {
    try {
      const xml = await get(page === 1 ? RSS_URL : `${RSS_URL}&paged=${page}`);
      const items = (xml.match(/<item\b/gi) || []).length;
      const found = parseRss(xml);
      console.log(`RSS Seite ${page}: ${items} Beiträge, davon ${found.length} ab ${CITY}`);
      for (const d of found) if (!byLink.has(d.link)) { byLink.set(d.link, d); counts.rss++; }
      if (!items) break;
    } catch (e) {
      if (page === 1) problems.push(`rss: ${e.message}`);
      else console.log(`RSS Seite ${page}: ${e.message} – Ende`);
      break;
    }
  }

  // 3) Fly4free.pl, Kategorie „z Warszawy“: Seite (Details) + RSS-Feed (Datum)
  const f4fPage = [], f4fRss = [];
  for (let page = 1; page <= F4F_PAGES; page++) {
    try {
      await sleep(page > 1 ? PAGE_DELAY_MS : 1000);
      const html = await get(f4fPageUrl(page), page > 1 ? f4fPageUrl(page - 1) : null);
      const found = parseFly4free(html);
      console.log(`Fly4free Seite ${page}: ${html.length} Zeichen, ${found.length} Angebote`);
      f4fPage.push(...found);
      if (!found.length) break;
    } catch (e) {
      console.log(`Fly4free Seite ${page}: ${e.message} – Ende`);
      break;
    }
  }
  for (let page = 1; page <= F4F_RSS_PAGES; page++) {
    try {
      await sleep(PAGE_DELAY_MS);
      const found = parseFly4freeRss(await get(f4fRssUrl(page)));
      console.log(`Fly4free RSS Seite ${page}: ${found.length} Beiträge`);
      f4fRss.push(...found);
      if (!found.length) break;
    } catch (e) {
      console.log(`Fly4free RSS Seite ${page}: ${e.message} – Ende`);
      break;
    }
  }
  if (!f4fPage.length && !f4fRss.length) problems.push('fly4free: weder Seite noch Feed lieferten Angebote');
  counts.fly4free = 0;
  for (const d of combineFly4free(f4fPage, f4fRss)) if (!byLink.has(d.link)) { byLink.set(d.link, d); counts.fly4free++; }

  // 4) Bisher veröffentlichte Liste einlesen und zusammenführen
  let previous = null;
  if (flag === '--fallback' && fallbackUrl) {
    try { previous = JSON.parse(await get(fallbackUrl)); }
    catch (e) { problems.push(`bisherige Liste: ${e.message}`); }
  }

  const fresh = [...byLink.values()];
  const { deals, kept } = mergeDeals(fresh, previous?.deals);
  try {
    const t = await translateDeals(deals);
    if (t.translated) console.log(`${t.translated} Angebote übersetzt (${t.via}).`);
  } catch (e) { problems.push(`Übersetzung: ${e.message} – Angebote bleiben vorerst polnisch`); }
  counts.kept = kept;
  const source = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(', ') || null;

  let result;
  if (fresh.length) {
    result = { city: CITY, source, counts, updated: new Date().toISOString(), searchUrl: SEARCH_URL, deals };
  } else if (previous) {
    // Quelle nicht erreichbar → letzte veröffentlichte Liste behalten
    result = { ...previous, deals, stale: true };
  }
  result ||= { city: CITY, source: null, updated: new Date().toISOString(), searchUrl: SEARCH_URL, deals: [] };

  for (const p of problems) console.log(`::warning::Deals: ${p}`);
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(`${result.deals.length} Deals ab ${CITY} geschrieben (${result.stale ? 'alte Liste' : result.source || 'keine Quelle'}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.log(`::warning::Deals: ${e.message}`); process.exit(0); });
}
