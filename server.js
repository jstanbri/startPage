import express from 'express';
import { readFile } from 'node:fs/promises';

const {
  PORT = 3000, ANTHROPIC_API_KEY, ANTHROPIC_MODEL = 'claude-sonnet-5-5',
  ANTHROPIC_WORKSPACE_ID, NOTION_TOKEN, TOMTOM_KEY, LAT = '50.8365', LON = '-0.7792', PLACE = 'Chichester',
  INFLUX_URL = 'http://influxdb:8086', INFLUX_ORG = 'home', INFLUX_BUCKET = 'enviro', INFLUX_TOKEN,
} = process.env;

const BLOCK = /trump/i;
const FEEDS = [
  ['BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['Guardian', 'https://www.theguardian.com/world/rss'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
];
// extra tech/science sources, used for the Claude briefing only
const TECH_FEEDS = [
  ['HN', 'https://news.ycombinator.com/rss'],
  ['NYT Tech', 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml'],
  ['TechCrunch', 'https://techcrunch.com/feed/'],
];

const app = express();
app.use(express.static('public'));

// tiny TTL cache so a refresh-happy start page doesn't hammer upstreams or the Claude API
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  try {
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    if (hit) return hit.v; // stale beats nothing
    throw e;
  }
}

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").trim();
const tag = (x, t) => decode((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');

async function fetchFeed([source, url]) {
  const r = await fetch(url, { headers: { 'user-agent': 'startpage/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${source} ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, x]) => ({
    source, title: tag(x, 'title'), summary: tag(x, 'description').slice(0, 240),
    link: tag(x, 'link'), date: new Date(tag(x, 'pubDate')).getTime() || 0,
  }));
}

async function getNews() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((i) => i.title && !BLOCK.test(`${i.title} ${i.summary}`))
    .sort((a, b) => b.date - a.date);
  const seen = new Set();
  return items.filter((i) => {
    const k = i.title.toLowerCase().slice(0, 40);
    return seen.has(k) ? false : seen.add(k);
  }).slice(0, 24);
}

app.get('/api/news', async (_req, res) => {
  try { res.json(await cached('news', 10 * 60e3, getNews)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/briefing', async (_req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ items: null, reason: 'ANTHROPIC_API_KEY not set' });
  try {
    const text = await cached('briefing', 30 * 60e3, async () => {
      const news = await cached('news', 10 * 60e3, getNews);
      const tech = (await Promise.allSettled(TECH_FEEDS.map(fetchFeed)))
        .flatMap((r) => (r.status === 'fulfilled' ? r.value.slice(0, 5) : []))
        .filter((i) => !BLOCK.test(`${i.title} ${i.summary}`));
      const list = [...news.slice(0, 12), ...tech].map((n) => `[${n.source}] ${n.title}: ${n.summary}`).join('\n');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
          ...(ANTHROPIC_WORKSPACE_ID && { 'anthropic-workspace-id': ANTHROPIC_WORKSPACE_ID }) },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL, max_tokens: 3000,
          system: 'You are a personalised news filter for a busy founder. Pick 5-6 items spanning world news and tech/science. Strictly exclude political commentary, celebrity, pop culture and rage-bait, and anything about Donald Trump. Reply with ONLY a JSON array of objects {"category","headline","summary"} (summary max 25 words). No markdown fences.',
          messages: [{ role: 'user', content: list }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
      const j = await r.json();
      const raw = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const a = raw.indexOf('['), z = raw.lastIndexOf(']');
      if (a < 0 || z < a) throw new Error(`Claude returned no JSON (stop=${j.stop_reason}): ${raw.slice(0, 200)}`);
      return JSON.parse(raw.slice(a, z + 1));
    });
    res.json({ items: text.filter((i) => !BLOCK.test(`${i.headline} ${i.summary}`)) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/weather', async (_req, res) => {
  try {
    const data = await cached('weather', 10 * 60e3, async () => {
      const u = new URL('https://api.open-meteo.com/v1/forecast');
      u.search = new URLSearchParams({
        latitude: LAT, longitude: LON, timezone: 'Europe/London', forecast_days: '4',
        current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        wind_speed_unit: 'mph',
      });
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`open-meteo ${r.status}`);
      return r.json();
    });
    res.json({ place: PLACE, ...data });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/traffic', async (_req, res) => {
  const lat = +LAT, lon = +LON;
  const links = {
    google: `https://www.google.com/maps/@${lat},${lon},12z/data=!5m1!1e1`,
    nh: 'https://nationalhighways.co.uk/travel-updates/',
    traveline: 'https://www.traveline.info/',
  };
  if (!TOMTOM_KEY) return res.json({ incidents: null, links });
  try {
    const incidents = await cached('traffic', 5 * 60e3, async () => {
      const d = 0.15; // ~±10 miles box
      const bbox = [lon - d, lat - d / 1.6, lon + d, lat + d / 1.6].join(',');
      const fields = '{incidents{type,properties{iconCategory,magnitudeOfDelay,events{description},from,to,roadNumbers,delay}}}';
      const u = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${TOMTOM_KEY}&bbox=${bbox}&fields=${encodeURIComponent(fields)}&language=en-GB&timeValidityFilter=present`;
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`tomtom ${r.status}`);
      const j = await r.json();
      return (j.incidents || []).map((i) => i.properties).filter((p) => p.magnitudeOfDelay > 0)
        .sort((a, b) => b.magnitudeOfDelay - a.magnitudeOfDelay).slice(0, 8).map((p) => ({
          road: (p.roadNumbers || []).join(', '), text: p.events?.[0]?.description || 'Incident',
          from: p.from, to: p.to, delayMin: p.delay ? Math.round(p.delay / 60) : null, severity: p.magnitudeOfDelay,
        }));
    });
    res.json({ incidents, links });
  } catch (e) { res.status(502).json({ error: e.message, links }); }
});

// weather station (InfluxDB, bucket written to by the Enviro board over the LAN)
const STATION_MEAN = ['temperature', 'humidity', 'pressure', 'wind_speed', 'luminance', 'voltage'];
const STATION_RANGES = { today: ['today()', '15m'], '24h': ['-24h', '15m'], '7d': ['-7d', '2h'], '30d': ['-30d', '6h'] };

app.get('/api/station', async (req, res) => {
  if (!INFLUX_TOKEN) return res.json({ latest: null, reason: 'INFLUX_TOKEN not set' });
  const range = STATION_RANGES[req.query.range] ? req.query.range : '24h';
  try {
    const data = await cached(`station:${range}`, 2 * 60e3, async () => {
      const [start, win] = STATION_RANGES[range];
      const meanFilter = STATION_MEAN.map((m) => `r._measurement == "${m}"`).join(' or ');
      const flux = `
base = from(bucket: "${INFLUX_BUCKET}") |> range(start: ${start}) |> filter(fn: (r) => r._field == "value")
base |> filter(fn: (r) => ${meanFilter}) |> aggregateWindow(every: ${win}, fn: mean, createEmpty: false) |> yield(name: "series")
base |> filter(fn: (r) => r._measurement == "rain") |> aggregateWindow(every: ${win}, fn: sum, createEmpty: false) |> yield(name: "rainseries")
from(bucket: "${INFLUX_BUCKET}") |> range(start: -48h) |> filter(fn: (r) => r._field == "value") |> last() |> yield(name: "latest")
from(bucket: "${INFLUX_BUCKET}") |> range(start: today()) |> filter(fn: (r) => r._measurement == "rain" and r._field == "value") |> sum() |> yield(name: "rainToday")`;
      const r = await fetch(`${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`, {
        method: 'POST',
        headers: { authorization: `Token ${INFLUX_TOKEN}`, 'content-type': 'application/vnd.flux', accept: 'application/csv' },
        body: flux, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`influx ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const latest = {}, series = {};
      let rainToday = 0, cols = null;
      for (const line of (await r.text()).split('\n')) {
        const l = line.trim();
        if (!l) { cols = null; continue; }
        if (l.startsWith('#')) continue;
        const c = l.split(',');
        if (c.includes('_value')) { cols = Object.fromEntries(c.map((k, i) => [k, i])); continue; }
        if (!cols) continue;
        const m = c[cols._measurement], v = +c[cols._value];
        if (!m || m.startsWith('test') || !Number.isFinite(v)) continue;
        if (c[1] === 'latest') latest[m] = { v, t: c[cols._time] };
        else if (c[1] === 'rainToday') rainToday = v;
        else (series[m] ||= []).push([Date.parse(c[cols._time]), v]);
      }
      return { range, latest, series, rainToday };
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/artifacts', async (_req, res) => {
  try { res.json(JSON.parse(await readFile('data/artifacts.json', 'utf8'))); }
  catch { res.json([]); }
});

app.get('/api/notion', async (_req, res) => {
  if (!NOTION_TOKEN) return res.json({ pages: null, reason: 'NOTION_TOKEN not set' });
  try {
    const pages = await cached('notion', 5 * 60e3, async () => {
      const r = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: { authorization: `Bearer ${NOTION_TOKEN}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' },
        body: JSON.stringify({ page_size: 10, sort: { direction: 'descending', timestamp: 'last_edited_time' } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`notion ${r.status}`);
      const j = await r.json();
      return j.results.map((p) => {
        const props = Object.values(p.properties || {});
        const rt = props.find((x) => x.type === 'title')?.title;
        const t = [Array.isArray(rt) ? rt : p.title].flat().filter(Boolean).map((x) => x.plain_text).join('') || 'Untitled';
        return { title: t, url: p.url, edited: p.last_edited_time, icon: p.icon?.emoji || '', type: p.object };
      });
    });
    res.json({ pages });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`start page on :${PORT}`));
