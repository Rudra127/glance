#!/usr/bin/env node
// Glance — always-on display server.
// Reads what the Mac is playing (any app) via `media-control`, finds synced
// lyrics on LRCLIB, and pushes everything to the iPad over Server-Sent Events.
// No npm dependencies.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 4173;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const WALLS = path.join(ROOT, 'wallpapers');
const CACHE = path.join(ROOT, '.cache', 'lyrics');
const UA = 'glance-display/1.0 (local always-on display)';
const MC = process.env.MEDIA_CONTROL || 'media-control';

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(WALLS, { recursive: true });

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ───────────────────────────── now playing ─────────────────────────────

const APP_NAMES = {
  'com.google.Chrome': 'Chrome', 'com.apple.Music': 'Music', 'com.spotify.client': 'Spotify',
  'com.apple.Safari': 'Safari', 'company.thebrowser.Browser': 'Arc', 'org.mozilla.firefox': 'Firefox',
  'com.brave.Browser': 'Brave', 'com.apple.WebKit.GPU': 'Safari', 'org.videolan.vlc': 'VLC',
  'com.colliderli.iina': 'IINA', 'com.tidal.desktop': 'TIDAL', 'com.microsoft.edgemac': 'Edge',
};

let state = { active: false };
let lyrics = { key: null, kind: 'none', lines: [] };
const art = new Map(); // id -> { mime, buf }
const clients = new Set();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}
const statePacket = () => ({ now: Date.now(), state });

function onPayload(p) {
  if (!p || !p.title) {
    if (state.active) { state = { active: false }; broadcast('state', statePacket()); }
    return;
  }
  let artId = null;
  if (p.artworkData) {
    artId = sha(p.artworkData).slice(0, 16);
    if (!art.has(artId)) {
      art.set(artId, { mime: p.artworkMimeType || 'image/jpeg', buf: Buffer.from(p.artworkData, 'base64') });
      while (art.size > 12) art.delete(art.keys().next().value);
    }
  }
  const duration = p.durationMicros ? p.durationMicros / 1e6 : null;
  const key = sha([p.title, p.artist || '', p.album || '', duration ? Math.round(duration) : ''].join('|')).slice(0, 16);
  const bundle = p.parentApplicationBundleIdentifier || p.bundleIdentifier || '';
  const next = {
    active: true,
    key,
    title: p.title,
    artist: p.artist || '',
    album: p.album || '',
    duration,
    elapsed: p.elapsedTimeMicros != null ? p.elapsedTimeMicros / 1e6 : null,
    at: p.timestampEpochMicros ? p.timestampEpochMicros / 1000 : Date.now(),
    rate: p.playbackRate || 1,
    playing: !!p.playing,
    app: APP_NAMES[bundle] || bundle.split('.').pop() || '',
    // Artwork often arrives a moment after the title; keep the old one for the same track.
    artId: artId || (state.key === key ? state.artId : null),
  };
  const trackChanged = next.key !== state.key;
  state = next;
  broadcast('state', statePacket());
  if (trackChanged) loadLyrics(next);
}

function startStream() {
  const child = spawn(MC, ['stream', '--no-diff', '--micros', '--debounce=120'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { const msg = JSON.parse(line); if (msg.type === 'data') onPayload(msg.payload); }
      catch (e) { console.error('[now-playing] bad line:', e.message); }
    }
  });
  child.stderr.on('data', (d) => console.error('[media-control]', String(d).trim()));
  child.on('error', (e) => {
    console.error(e.code === 'ENOENT'
      ? '\n  media-control is not installed. Run:  brew install media-control\n'
      : `[media-control] ${e.message}`);
  });
  child.on('close', () => setTimeout(startStream, 3000));
}

const COMMANDS = { toggle: ['toggle-play-pause'], next: ['next-track'], prev: ['previous-track'], play: ['play'], pause: ['pause'] };
function runCommand(body) {
  let args = COMMANDS[body.cmd];
  if (body.cmd === 'seek' && Number.isFinite(body.pos)) args = ['seek', String(Math.max(0, body.pos))];
  if (!args) return false;
  execFile(MC, args, (err) => err && console.error('[control]', err.message));
  return true;
}

// ─────────────────────────────── lyrics ────────────────────────────────

const cleanTitle = (t) => t
  .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|hd|hq|4k|mv|live session)\b[^)\]]*[)\]]/gi, '')
  .replace(/\s+[-–|]\s+(official|lyrics?)\b.*$/i, '')
  .trim();
const cleanArtist = (a) => a.replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').trim();

function parseLrc(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: words });
  }
  out.sort((a, b) => a.t - b.t);
  // collapse runs of empty lines (they mark instrumental gaps)
  return out.filter((l, i) => l.text || (i > 0 && out[i - 1].text));
}

async function lrclib(pathAndQuery) {
  const res = await fetch('https://lrclib.net' + pathAndQuery, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('LRCLIB ' + res.status);
  return res.json();
}

function pickBest(list, duration) {
  if (!Array.isArray(list) || !list.length) return null;
  const score = (r) => (r.syncedLyrics ? 0 : 1000) + (duration && r.duration ? Math.abs(r.duration - duration) : 5);
  const sorted = [...list].filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental).sort((a, b) => score(a) - score(b));
  const best = sorted[0];
  if (!best) return null;
  if (duration && best.duration && Math.abs(best.duration - duration) > 12) return null; // different recording
  return best;
}

async function findLyrics(t) {
  const title = cleanTitle(t.title), artist = cleanArtist(t.artist);
  const q = (o) => '?' + new URLSearchParams(o).toString();
  let hit = null;
  if (artist && t.duration) {
    hit = await lrclib('/api/get' + q({ track_name: title, artist_name: artist, album_name: t.album || '', duration: Math.round(t.duration) }));
  }
  if (!hit || !hit.syncedLyrics) {
    const found = pickBest(await lrclib('/api/search' + q(artist ? { track_name: title, artist_name: artist } : { q: title })), t.duration);
    if (found && (found.syncedLyrics || !hit)) hit = found;
  }
  // YouTube-style "Artist - Song" titles where the "artist" is really a channel name
  if ((!hit || !hit.syncedLyrics) && / [-–] /.test(title)) {
    const [a, ...rest] = title.split(/ [-–] /);
    const found = pickBest(await lrclib('/api/search' + q({ track_name: rest.join(' - '), artist_name: a })), t.duration);
    if (found && (found.syncedLyrics || !hit)) hit = found;
  }
  if (!hit) return { kind: 'none', lines: [] };
  if (hit.syncedLyrics) return { kind: 'synced', lines: parseLrc(hit.syncedLyrics) };
  if (hit.instrumental) return { kind: 'instrumental', lines: [] };
  if (hit.plainLyrics) return { kind: 'plain', lines: hit.plainLyrics.split('\n').map((text) => ({ t: null, text: text.trim() })) };
  return { kind: 'none', lines: [] };
}

async function loadLyrics(t) {
  const key = t.key;
  lyrics = { key, kind: 'loading', lines: [] };
  broadcast('lyrics', lyrics);
  const file = path.join(CACHE, key + '.json');
  let result = null;
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    // "not found" answers are retried after a day; real lyrics are kept forever
    if (cached.kind !== 'none' || Date.now() - cached.savedAt < 864e5) result = cached;
  } catch {}
  if (!result) {
    try {
      result = await findLyrics(t);
      fs.writeFileSync(file, JSON.stringify({ ...result, savedAt: Date.now(), title: t.title, artist: t.artist }));
    } catch (e) {
      console.error('[lyrics]', e.message);
      result = { kind: 'none', lines: [], error: true };
    }
  }
  if (state.key !== key) return; // track changed while we were fetching
  lyrics = { key, kind: result.kind, lines: result.lines };
  broadcast('lyrics', lyrics);
}

// ─────────────────────────────── weather ───────────────────────────────

const memo = new Map();
async function cachedJson(url, ttl) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error('upstream ' + res.status);
  const data = await res.json();
  memo.set(url, { at: Date.now(), data });
  return data;
}

// ──────────────────────────────── http ─────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.mp4': 'video/mp4',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveFile(req, res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': base === WALLS ? 'max-age=3600' : 'no-cache',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''); // iOS wants ranges for <video>
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      send(res, 'state', statePacket());
      send(res, 'lyrics', lyrics);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p.startsWith('/art/')) {
      const a = art.get(p.slice(5));
      if (!a) return json(res, 404, { error: 'no artwork' });
      res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': a.buf.length, 'Cache-Control': 'max-age=31536000, immutable' });
      return res.end(a.buf);
    }
    if (p === '/api/cmd' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 2000) break; }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      return json(res, runCommand(parsed) ? 200 : 400, { ok: true });
    }
    if (p === '/api/wallpapers') {
      const files = fs.readdirSync(WALLS).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).sort();
      return json(res, 200, files.map((f) => '/wallpapers/' + encodeURIComponent(f)));
    }
    if (p === '/api/geocode') {
      const name = (url.searchParams.get('q') || '').slice(0, 80);
      const d = await cachedJson('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(name), 864e5);
      const r = d.results && d.results[0];
      return r ? json(res, 200, { name: r.name, lat: r.latitude, lon: r.longitude }) : json(res, 404, { error: 'not found' });
    }
    if (p === '/api/weather') {
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'lat/lon required' });
      const unit = url.searchParams.get('unit') === 'F' ? 'fahrenheit' : 'celsius';
      const d = await cachedJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,weather_code,is_day&temperature_unit=${unit}`, 6e5);
      return json(res, 200, { temp: d.current.temperature_2m, code: d.current.weather_code, day: !!d.current.is_day });
    }
    if (p.startsWith('/wallpapers/')) return serveFile(req, res, WALLS, p.slice('/wallpapers/'.length));
    return serveFile(req, res, PUBLIC, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    console.error('[http]', p, e.message);
    if (!res.headersSent) json(res, 502, { error: e.message });
  }
});

setInterval(() => broadcast('ping', { now: Date.now() }), 10000);

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => i.address);
  console.log('\n  Glance is running. Open one of these in Safari on the iPad (same Wi-Fi):\n');
  console.log(`    http://${os.hostname().replace(/\.local$/, '')}.local:${PORT}`);
  for (const ip of ips) console.log(`    http://${ip}:${PORT}`);
  console.log('\n  Then Share → Add to Home Screen for a full-screen display.\n');
  startStream();
});
