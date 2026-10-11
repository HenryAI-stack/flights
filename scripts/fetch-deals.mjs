// Holt Flug-Deals ab Warschau von Secret Flying und schreibt sie als JSON.
// Läuft täglich in .github/workflows/deploy.yml; die Seite zeigt deals.json an
// und verlinkt jeden Deal zurück auf Secret Flying.
//
// Aufruf: node scripts/fetch-deals.mjs <ausgabe.json> [--fallback <url der alten deals.json>]

const CITY        = 'Warsaw';
const RSS_URL     = `https://www.secretflying.com/?s=${CITY}&feed=rss2`;
const SEARCH_URL  = `https://www.secretflying.com/search2/?cityFrom=${CITY}&month=&showOldDeals=on&cityTo=`;
const MAX_DEALS   = 40;
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
export function toDeal({ title, link, date, expired = false }) {
  title = decode(title);
  if (!title || !link) return null;
  const isExpired = expired || /\bexpired\b/i.test(title);
  const clean = title.replace(/^\s*(?:\[?expired\]?\s*[-:–]?\s*)/i, '');
  const m = clean.match(/^(.*?)\s+to\s+(.+?)(?:\s+for\s+(?:only\s+)?(.*))?$/i);
  if (!m || !new RegExp(`\\b${CITY}\\b`, 'i').test(m[1])) return null;
  const price = (m[3] || clean).match(PRICE_RE)?.[0] || null;
  return {
    title: clean,
    from: m[1].replace(/^(?:non-?stop|direct)\s+(?:flights?\s+)?from\s+/i, '').replace(/^from\s+/i, '').trim(),
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

/* Fallback: Links auf Deal-Beiträge aus der Suchseite lesen. */
export function parseSearchPage(html) {
  const seen = new Set();
  const deals = [];
  for (const [, href, inner] of String(html).matchAll(/<a\b[^>]*href="(https:\/\/www\.secretflying\.com\/posts\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (seen.has(href)) continue;
    const d = toDeal({ title: inner, link: href });
    if (d) { seen.add(href); deals.push(d); }
  }
  return deals;
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return res.text();
}

async function main() {
  const [out, flag, fallbackUrl] = process.argv.slice(2);
  if (!out) throw new Error('Ausgabedatei fehlt.');
  const { writeFile } = await import('node:fs/promises');
  const problems = [];
  let deals = [];
  let source = null;

  for (const [name, url, parse] of [['rss', RSS_URL, parseRss], ['search', SEARCH_URL, parseSearchPage]]) {
    try {
      deals = parse(await get(url));
      if (deals.length) { source = name; break; }
      problems.push(`${name}: keine Deals ab ${CITY} gefunden`);
    } catch (e) { problems.push(`${name}: ${e.message}`); }
  }

  let result;
  if (deals.length) {
    deals.sort((a, b) => (a.expired - b.expired) || String(b.date || '').localeCompare(String(a.date || '')));
    result = { city: CITY, source, updated: new Date().toISOString(), searchUrl: SEARCH_URL, deals: deals.slice(0, MAX_DEALS) };
  } else if (flag === '--fallback' && fallbackUrl) {
    // Quelle nicht erreichbar → letzte veröffentlichte Liste behalten
    try { result = JSON.parse(await get(fallbackUrl)); result.stale = true; }
    catch (e) { problems.push(`fallback: ${e.message}`); }
  }
  result ||= { city: CITY, source: null, updated: new Date().toISOString(), searchUrl: SEARCH_URL, deals: [] };

  for (const p of problems) console.log(`::warning::Deals: ${p}`);
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(`${result.deals.length} Deals ab ${CITY} geschrieben (${result.stale ? 'alte Liste' : result.source || 'keine Quelle'}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.log(`::warning::Deals: ${e.message}`); process.exit(0); });
}
