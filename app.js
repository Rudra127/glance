/* Glance — always-on display client */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const app = $('app');

  // ───────────── settings ─────────────
  const DEFAULTS = { h24: true, bg: 'art', dim: 'off', offset: 0, unit: 'C', place: null };
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('glance') || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem('glance', JSON.stringify(v)); } catch {} },
  };
  const S = Object.assign({}, DEFAULTS, store.get());
  const save = () => store.set(S);

  // ───────────── live state ─────────────
  let state = { active: false };
  let lyrics = { key: null, kind: 'none', lines: [] };
  let clockSkew = 0;          // server clock minus this device's clock, ms
  let pausedSince = 0;
  let showPlayer = false;
  let activeLine = -2;
  let weather = null;
  let wallpapers = [];
  let wallIndex = 0;
  let upNext = '';

  const serverNow = () => Date.now() + clockSkew;
  function position() {
    if (state.elapsed == null) return null;
    let p = state.elapsed;
    if (state.playing) p += ((serverNow() - state.at) / 1000) * (state.rate || 1);
    if (state.duration) p = Math.min(p, state.duration);
    return Math.max(0, p);
  }
  const mmss = (s) => {
    s = Math.max(0, Math.floor(s));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  let MODE = 'mac';           // 'mac' = this page is served by the Mac helper; 'spotify' = talk to Spotify directly
  let hasServer = false;
  const cmd = (body) => MODE === 'spotify' ? spCmd(body)
    : fetch('api/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});

  // ───────────── clock ─────────────
  const WMO = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
    56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow', 80: 'showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers',
    86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm' };

  function tickClock() {
    const d = new Date();
    let h = d.getHours();
    if (!S.h24) { $('ampm').textContent = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; } else $('ampm').textContent = '';
    $('hh').textContent = String(h).padStart(2, '0');
    $('mm').textContent = String(d.getMinutes()).padStart(2, '0');
    $('date').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    const bits = [];
    if (weather) bits.push(`${Math.round(weather.temp)}°${S.unit} ${WMO[weather.code] || ''}`.trim());
    if (!showPlayer) {
      if (state.active) bits.push(`paused · ${state.title}${state.artist ? ' — ' + state.artist : ''}`);
      else bits.push(MODE === 'spotify' && !spTokens() ? 'Spotify not connected' : 'nothing playing');
    } else if (upNext) bits.push('Up next · ' + upNext);
    else if (S.place && weather) bits.push(S.place.name);
    $('status').textContent = bits.join('  ·  ');

    const night = d.getHours() >= 23 || d.getHours() < 7;
    $('dim').classList.toggle('on', S.dim === 'on' || (S.dim === 'auto' && night));
  }

  // ───────────── mode + now playing ─────────────
  const PAUSE_GRACE = 120000; // keep the player up for 2 min after pausing, then fall back to the clock

  function refreshMode() {
    const want = state.active && (state.playing || Date.now() - pausedSince < PAUSE_GRACE);
    if (want === showPlayer) return;
    showPlayer = want;
    app.classList.add('switching');
    setTimeout(() => {
      app.classList.toggle('idle', !showPlayer);
      app.classList.remove('switching');
      activeLine = -2;
      tickClock(); tickPlayback(); chooseBackground();
    }, 460);
  }

  function applyState(next) {
    const prev = state;
    state = next;
    // `at` is when the Mac last reported the position, i.e. the moment of the pause — so a reload doesn't restart the grace period
    pausedSince = state.active && !state.playing ? state.at - clockSkew : 0;
    document.body.classList.toggle('paused', !!state.active && !state.playing);

    if (state.active) {
      $('title').textContent = state.title;
      $('artist').textContent = [state.artist, state.album].filter(Boolean).join(' — ');
      $('src').textContent = state.app ? 'Playing on ' + state.app : 'Now playing';
      document.querySelector('.np').classList.toggle('no-time', state.elapsed == null || !state.duration);
      $('total').textContent = state.duration ? 'of ' + mmss(state.duration) : '';
      if (state.art !== prev.art) setArtwork(state.art);
    }
    refreshMode();
    tickPlayback();
    tickClock();
  }

  function setArtwork(url) {
    for (const img of [$('art'), $('bigartImg')]) { if (url) img.src = url; else img.removeAttribute('src'); }
    if (url) pickAccent(url); else setAccent(null);
    chooseBackground();
  }

  // ───────────── accent colour from artwork ─────────────
  function setAccent(rgb) {
    document.documentElement.style.setProperty('--accent', rgb ? `rgb(${rgb.join(',')})` : '#b9a2ff');
  }
  function pickAccent(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Spotify covers come from another host
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 32, 32);
        const px = g.getImageData(0, 0, 32, 32).data;
        const bins = new Map(); // hue bucket -> weighted sums
        for (let i = 0; i < px.length; i += 4) {
          const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
          if (s < 0.22 || l < 0.12 || l > 0.92) continue;
          const k = Math.floor(h * 18), w = s * (1 - Math.abs(l - 0.55));
          const b = bins.get(k) || { w: 0, h: 0, s: 0 };
          b.w += w; b.h += h * w; b.s += s * w; bins.set(k, b);
        }
        let best = null;
        for (const b of bins.values()) if (!best || b.w > best.w) best = b;
        if (!best) return setAccent([235, 235, 240]); // greyscale cover
        setAccent(hslToRgb(best.h / best.w, Math.min(0.9, Math.max(0.5, best.s / best.w)), 0.74));
      } catch { setAccent(null); }
    };
    img.src = url;
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }

  // ───────────── background ─────────────
  const layers = [$('bgA'), $('bgB')];
  let front = 0, currentBg = null;

  function chooseBackground() {
    document.body.classList.toggle('bg-black', S.bg === 'black');
    let url = null, kind = 'art';
    if (S.bg === 'photos' && wallpapers.length) { url = wallpapers[wallIndex % wallpapers.length]; kind = 'photo'; }
    else if (S.bg !== 'black' && state.active && state.art) url = state.art;
    if (url === currentBg) return;
    currentBg = url;
    if (!url) { layers.forEach((l) => l.classList.remove('on')); return; }
    const img = new Image();
    img.onload = () => {
      if (currentBg !== url) return;
      const back = layers[1 - front];
      back.className = 'bgl k-' + kind;
      back.style.backgroundImage = `url("${url}")`;
      void back.offsetWidth;
      back.classList.add('on');
      layers[front].classList.remove('on');
      front = 1 - front;
    };
    img.src = url;
  }
  async function loadWallpapers() {
    wallpapers = [];
    for (const src of ['api/wallpapers', 'wallpapers/index.json']) {
      try { const r = await fetch(src); if (r.ok) { wallpapers = await r.json(); break; } } catch {}
    }
    wallIndex = Math.floor(Math.random() * Math.max(1, wallpapers.length));
    $('photoHint').textContent = wallpapers.length
      ? `${wallpapers.length} photo${wallpapers.length > 1 ? 's' : ''} in the wallpapers folder, changing every 10 minutes.`
      : hasServer ? 'Drop images into the "wallpapers" folder on your Mac to use Photos. Until then, album art is used.' : 'No photos are bundled yet, so album art is used.';
    chooseBackground();
  }
  setInterval(() => { if (S.bg === 'photos' && wallpapers.length > 1) { wallIndex++; chooseBackground(); } }, 600000);

  // ───────────── progress bar ─────────────
  const SEGMENTS = 44;
  const bar = $('bar');
  const cells = [];
  for (let i = 0; i < SEGMENTS; i++) cells.push(bar.appendChild(document.createElement('i')));
  let lastFill = -1;
  function drawBar(frac) {
    const fill = Math.min(SEGMENTS - 1, Math.floor(frac * SEGMENTS));
    if (fill === lastFill) return;
    lastFill = fill;
    cells.forEach((c, i) => { c.className = i < fill ? 'on' : i === fill ? 'head' : ''; });
  }
  bar.addEventListener('click', (e) => {
    if (!state.duration) return;
    const r = bar.getBoundingClientRect();
    seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * state.duration);
  });
  function seek(pos) {
    cmd({ cmd: 'seek', pos });
    state.elapsed = pos; state.at = serverNow(); // optimistic until the Mac confirms
    tickPlayback();
  }

  // ───────────── lyrics ─────────────
  const lyrBox = $('lyrics'), lyrInner = $('lyrInner');

  function applyLyrics(next) {
    lyrics = next;
    activeLine = -2;
    lyrInner.textContent = '';
    const hasText = lyrics.kind === 'synced' || lyrics.kind === 'plain';
    lyrBox.classList.toggle('hidden', !hasText);
    lyrBox.classList.toggle('plain', lyrics.kind === 'plain');
    $('bigart').classList.toggle('hidden', hasText);
    $('lyrTag').textContent = lyrics.kind === 'synced' ? 'Lyrics · synced' : lyrics.kind === 'plain' ? 'Lyrics · not timed' : '';
    $('bigartNote').textContent = { loading: 'Finding lyrics…', instrumental: 'Instrumental', none: 'No lyrics found' }[lyrics.kind] || '';
    if (!hasText) return;
    lyrics.lines.forEach((l) => {
      const el = document.createElement('div');
      el.className = 'ln' + (l.text ? '' : ' gap');
      el.textContent = l.text || '· · ·';
      if (l.t != null) el.addEventListener('click', () => seek(Math.max(0, l.t - S.offset)));
      lyrInner.appendChild(el);
    });
    lyrInner.style.transition = 'none';
    tickPlayback();
    requestAnimationFrame(() => { lyrInner.style.transition = ''; });
  }

  function drawLyrics(pos) {
    if (lyrBox.classList.contains('hidden') || !lyrInner.children.length) return;
    const h = lyrBox.clientHeight;
    if (!h) return;
    if (lyrics.kind === 'plain') {
      const frac = state.duration && pos != null ? pos / state.duration : 0;
      const travel = Math.max(0, lyrInner.scrollHeight - h * 0.55);
      lyrInner.style.transform = `translateY(${h * 0.22 - travel * frac}px)`;
      return;
    }
    const t = (pos || 0) + S.offset;
    let idx = -1;
    for (let i = 0; i < lyrics.lines.length && lyrics.lines[i].t <= t; i++) idx = i;
    if (idx === activeLine) return;
    activeLine = idx;
    const kids = lyrInner.children;
    for (let i = 0; i < kids.length; i++) {
      const d = Math.abs(i - idx);
      kids[i].classList.toggle('active', d === 0);
      kids[i].classList.toggle('near', d === 1);
    }
    const target = kids[Math.max(0, idx)];
    lyrInner.style.transform = `translateY(${h * 0.42 - (target.offsetTop + target.offsetHeight / 2)}px)`;
  }

  function tickPlayback() {
    if (!showPlayer) return;
    const pos = position();
    if (pos != null) {
      $('elapsed').textContent = mmss(pos);
      if (state.duration) drawBar(pos / state.duration);
    }
    drawLyrics(pos);
  }

  // ───────────── connection ─────────────
  function connect() {
    const es = new EventSource('events');
    const sync = (now) => { clockSkew = now - Date.now(); };
    es.addEventListener('state', (e) => {
      const d = JSON.parse(e.data); sync(d.now);
      d.state.art = d.state.artId ? 'art/' + d.state.artId : null;
      applyState(d.state);
    });
    es.addEventListener('lyrics', (e) => applyLyrics(JSON.parse(e.data)));
    es.addEventListener('ping', (e) => sync(JSON.parse(e.data).now));
    es.onopen = () => $('offline').classList.remove('on');
    es.onerror = () => $('offline').classList.add('on');
  }

  // ───────────── controls ─────────────
  document.querySelectorAll('.ctl').forEach((b) => b.addEventListener('click', () => {
    const c = b.dataset.cmd;
    if (c === 'toggle') { // flip immediately; the Mac's answer follows within a moment
      state.elapsed = position(); state.at = serverNow(); state.playing = !state.playing;
      document.body.classList.toggle('paused', !state.playing);
    }
    cmd({ cmd: c });
  }));
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); document.querySelector('.ctl.main').click(); }
    if (e.code === 'ArrowRight') cmd({ cmd: 'next' });
    if (e.code === 'ArrowLeft') cmd({ cmd: 'prev' });
  });

  // ───────────── keep the screen awake ─────────────
  let wakeLock = null, wakeMode = 'none';
  async function keepAwake() {
    if ('wakeLock' in navigator) {
      try {
        if (!wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
        wakeMode = 'lock';
      } catch { wakeMode = 'none'; }
    } else {
      // Plain http pages can't use the wake-lock API; a looping silent clip does the same job.
      try { await $('awake').play(); wakeMode = 'video'; } catch { wakeMode = 'none'; }
    }
    $('wakeHint').textContent = {
      lock: 'Keeping the screen awake while this page is open.',
      video: 'Keeping the screen awake with a silent looping clip. If the iPad still sleeps, set Settings → Display & Brightness → Auto-Lock to Never.',
      none: 'Tap anywhere once to keep the screen awake. For a guaranteed always-on display, set Settings → Display & Brightness → Auto-Lock to Never.',
    }[wakeMode];
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { keepAwake(); tickClock(); tickPlayback(); } });

  // ───────────── settings sheet ─────────────
  const sheet = $('sheet');
  let touchTimer = 0;
  function touched() {
    document.body.classList.add('touched');
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => document.body.classList.remove('touched'), 5000);
  }
  document.addEventListener('pointerdown', (e) => {
    touched(); keepAwake();
    if (sheet.classList.contains('open') && !sheet.contains(e.target) && e.target !== $('gear') && !$('gear').contains(e.target)) closeSheet();
    if ($('search').classList.contains('open') && !$('search').contains(e.target) && !$('searchBtn').contains(e.target)) closeSearch();
  });
  const closeSheet = () => { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); };
  $('gear').addEventListener('click', () => { sheet.classList.toggle('open'); sheet.setAttribute('aria-hidden', String(!sheet.classList.contains('open'))); });
  $('sheetClose').addEventListener('click', closeSheet);

  function paintSettings() {
    document.querySelectorAll('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', String(S[seg.dataset.key]) === b.dataset.val));
    });
    $('sourceBlock').hidden = !hasServer;
    $('spLogout').hidden = !(MODE === 'spotify' && spTokens());
    $('searchBtn').hidden = !(MODE === 'spotify' && spTokens());
    $('spInfo').textContent = MODE === 'spotify' ? 'Spotify redirect address used by this page: ' + REDIRECT : '';
    paintConnect();
    $('offVal').textContent = (S.offset > 0 ? '+' : '') + S.offset.toFixed(1) + 's';
    $('placeHint').textContent = S.place ? `Showing weather for ${S.place.name}.` : 'Type a city to show the temperature under the clock.';
    $('installHint').textContent = navigator.standalone || matchMedia('(display-mode: standalone)').matches
      ? '' : 'For true full screen: Share → Add to Home Screen, then open Glance from the Home Screen.';
  }
  document.querySelectorAll('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = b.dataset.val;
    S[seg.dataset.key] = v === 'true' ? true : v === 'false' ? false : v;
    save();
    if (seg.dataset.key === 'source') return location.reload();
    paintSettings(); tickClock(); chooseBackground();
    if (seg.dataset.key === 'unit') loadWeather();
  }));
  const nudge = (d) => { S.offset = Math.round((S.offset + d) * 10) / 10; save(); paintSettings(); activeLine = -2; tickPlayback(); };
  $('offMinus').addEventListener('click', () => nudge(-0.1));
  $('offPlus').addEventListener('click', () => nudge(0.1));

  $('placeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('placeInput').value.trim();
    $('placeInput').blur();
    if (!q) { S.place = null; weather = null; save(); paintSettings(); tickClock(); return; }
    try {
      const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(q));
      const hit = r.ok && ((await r.json()).results || [])[0];
      if (!hit) throw 0;
      S.place = { name: hit.name, lat: hit.latitude, lon: hit.longitude }; save(); paintSettings(); loadWeather();
    } catch { $('placeHint').textContent = `Couldn't find "${q}". Try a nearby larger city.`; }
  });
  async function loadWeather() {
    if (!S.place) return;
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${S.place.lat.toFixed(3)}&longitude=${S.place.lon.toFixed(3)}&current=temperature_2m,weather_code&temperature_unit=${S.unit === 'F' ? 'fahrenheit' : 'celsius'}`);
      if (r.ok) { const d = await r.json(); weather = { temp: d.current.temperature_2m, code: d.current.weather_code }; tickClock(); }
    } catch {}
  }
  setInterval(loadWeather, 900000);


  // ───────────── Spotify (no Mac needed) ─────────────
  const CLIENT_ID = (window.GLANCE || {}).spotifyClientId || '';
  const REDIRECT = location.origin + location.pathname.replace(/[^/]*$/, '');
  const SCOPES = 'user-read-playback-state user-read-currently-playing user-modify-playback-state';
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const spTokens = () => ls.get('glance.sp');
  let spTimer = 0, spNote = '';

  function paintConnect() {
    const need = MODE === 'spotify' && !spTokens();
    $('connect').hidden = !need;
    $('connectNote').hidden = !(need && spNote);
    $('connectNote').textContent = spNote;
  }

  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function spLogin() {
    if (!CLIENT_ID) { spNote = 'No Spotify Client ID is set in config.js.'; return paintConnect(); }
    if (!window.crypto || !crypto.subtle) { spNote = 'Spotify sign-in needs the https version of this page.'; return paintConnect(); }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    ls.set('glance.sp.verifier', verifier);
    location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge,
    });
  }
  async function spTokenRequest(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error_description || d.error || 'Spotify sign-in failed'); e.status = r.status; throw e; }
    const old = spTokens() || {};
    ls.set('glance.sp', { access: d.access_token, refresh: d.refresh_token || old.refresh, exp: Date.now() + d.expires_in * 1000 });
    return d.access_token;
  }
  async function spFinishLogin() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    history.replaceState(null, '', REDIRECT);
    if (q.has('error')) { spNote = 'Spotify sign-in was cancelled.'; return; }
    try {
      await spTokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, code_verifier: ls.get('glance.sp.verifier') || '' });
    } catch (e) { spNote = e.message; }
    ls.del('glance.sp.verifier');
  }
  let refreshing = null;
  async function spAccess(force) {
    const t = spTokens();
    if (!t) return null;
    if (!force && t.exp - Date.now() > 60000) return t.access;
    refreshing = refreshing || spTokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })
      .catch((e) => { if (e.status === 400 || e.status === 401) { ls.del('glance.sp'); spNote = 'Spotify signed you out. Connect again.'; paintSettings(); return null; } throw e; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  async function spApi(method, path, retried, body) {
    const token = await spAccess(retried);
    if (!token) return null;
    const headers = { Authorization: 'Bearer ' + token };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch('https://api.spotify.com/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && !retried) return spApi(method, path, true, body);
    return r;
  }

  async function spPoll() {
    clearTimeout(spTimer);
    let delay = 5000;
    try {
      if (!spTokens()) { if (state.active) applyState({ active: false }); paintConnect(); return; }
      if (document.hidden) { spTimer = setTimeout(spPoll, delay); return; }
      const t0 = Date.now();
      const r = await spApi('GET', '/me/player?additional_types=track,episode');
      const at = (t0 + Date.now()) / 2;
      if (!r) { paintConnect(); return; }
      $('offline').classList.remove('on');
      if (r.status === 429) delay = (Number(r.headers.get('Retry-After')) || 10) * 1000;
      else if (r.status === 403) { spNote = 'Spotify refused access (' + ((await r.json().catch(() => ({}))).error || {}).message + ').'; $('offline').textContent = spNote; $('offline').classList.add('on'); delay = 30000; }
      else if (r.status === 204 || !r.ok) { if (state.active) applyState({ active: false }); }
      else {
        const d = await r.json(), it = d.item;
        if (!it) { if (state.active) applyState({ active: false }); }
        else {
          const pos = (d.progress_ms || 0) / 1000;
          const next = {
            active: true, key: it.id || it.uri, title: it.name,
            artist: (it.artists || []).map((a) => a.name).join(', ') || (it.show && it.show.name) || '',
            album: (it.album && it.album.name) || '', duration: it.duration_ms / 1000,
            elapsed: pos, at, rate: 1, playing: !!d.is_playing,
            app: 'Spotify' + (d.device && d.device.name ? ' · ' + d.device.name : ''),
            art: (((it.album && it.album.images) || it.images || [])[0] || {}).url || null,
          };
          // Each poll is off by a little network delay. Unless it disagrees with our own running
          // clock by a second or more (a seek), keep ours so the lyrics don't jitter.
          if (state.active && state.key === next.key && state.playing === next.playing) {
            const mine = position();
            if (Math.abs(mine - pos) < (next.playing ? 1 : 0.4)) { next.elapsed = state.elapsed; next.at = state.at; }
          }
          const changed = next.key !== state.key;
          applyState(next);
          if (changed) { spLyrics(next); spQueue(); }
          delay = next.playing ? 3000 : 5000;
          const left = (next.duration - pos) * 1000;
          if (next.playing && left < delay + 600) delay = Math.max(700, left + 600); // catch the track change promptly
        }
      }
    } catch (e) {
      $('offline').textContent = 'No connection to Spotify…';
      $('offline').classList.add('on');
    }
    spTimer = setTimeout(spPoll, delay);
  }

  async function spQueue() {
    upNext = '';
    try {
      const r = await spApi('GET', '/me/player/queue');
      const n = r && r.ok && ((await r.json()).queue || [])[0];
      if (n) upNext = n.name + ((n.artists || [])[0] ? ' — ' + n.artists[0].name : '');
    } catch {}
    tickClock();
  }

  async function spCmd(body) {
    const call = {
      toggle: () => spApi('PUT', state.playing ? '/me/player/play' : '/me/player/pause'), // state was already flipped by the tap
      next: () => spApi('POST', '/me/player/next'),
      prev: () => spApi('POST', '/me/player/previous'),
      seek: () => spApi('PUT', '/me/player/seek?position_ms=' + Math.round(body.pos * 1000)),
    }[body.cmd];
    if (!call) return;
    try { await call(); } catch {}
    clearTimeout(spTimer); spTimer = setTimeout(spPoll, 450);
  }

  // Lyrics straight from LRCLIB (same matching rules as the Mac helper)
  const cleanTitle = (t) => t
    .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|hd|hq|4k|mv|live session)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+[-–]\s+(\d{4}\s+)?(remaster(ed)?|single version|radio edit|mono|stereo)\b.*$/i, '')
    .trim();
  function parseLrc(text) {
    const out = [];
    for (const raw of text.split('\n')) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!stamps.length) continue;
      const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
      for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: words });
    }
    out.sort((a, b) => a.t - b.t);
    return out.filter((l, i) => l.text || (i > 0 && out[i - 1].text));
  }
  async function lrclib(pathAndQuery) {
    const r = await fetch('https://lrclib.net' + pathAndQuery);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('LRCLIB ' + r.status);
    return r.json();
  }
  function pickBest(list, duration) {
    if (!Array.isArray(list)) return null;
    const score = (x) => (x.syncedLyrics ? 0 : 1000) + (x.duration ? Math.abs(x.duration - duration) : 5);
    const best = list.filter((x) => x.syncedLyrics || x.plainLyrics || x.instrumental).sort((a, b) => score(a) - score(b))[0];
    return best && (!best.duration || Math.abs(best.duration - duration) <= 12) ? best : null;
  }
  async function findLyrics(t) {
    const title = cleanTitle(t.title), artist = t.artist.split(', ')[0];
    const q = (o) => '?' + new URLSearchParams(o);
    let hit = await lrclib('/api/get' + q({ track_name: title, artist_name: artist, album_name: t.album, duration: Math.round(t.duration) }));
    if (!hit || !hit.syncedLyrics) {
      const found = pickBest(await lrclib('/api/search' + q({ track_name: title, artist_name: artist })), t.duration);
      if (found && (found.syncedLyrics || !hit)) hit = found;
    }
    if (!hit) return { kind: 'none', lines: [] };
    if (hit.syncedLyrics) return { kind: 'synced', lines: parseLrc(hit.syncedLyrics) };
    if (hit.instrumental) return { kind: 'instrumental', lines: [] };
    if (hit.plainLyrics) return { kind: 'plain', lines: hit.plainLyrics.split('\n').map((text) => ({ t: null, text: text.trim() })) };
    return { kind: 'none', lines: [] };
  }
  async function spLyrics(t) {
    const key = t.key, slot = 'glance.ly.' + key;
    let res = ls.get(slot);
    if (res && res.kind === 'none' && Date.now() - res.at > 864e5) res = null; // retry misses after a day
    if (!res) {
      applyLyrics({ key, kind: 'loading', lines: [] });
      try {
        res = await findLyrics(t);
        res.at = Date.now();
        const index = (ls.get('glance.ly.index') || []).filter((k) => k !== key);
        index.push(key);
        while (index.length > 60) ls.del('glance.ly.' + index.shift()); // keep the last 60 songs on the iPad
        ls.set('glance.ly.index', index); ls.set(slot, res);
      } catch { res = { kind: 'none', lines: [] }; }
    }
    if (state.key === key) applyLyrics({ key, kind: res.kind, lines: res.lines });
  }

  // ───────────── search & play (Spotify mode) ─────────────
  const searchBox = $('search'), searchInput = $('searchInput'), results = $('results');
  let searchTimer = 0, searchSeq = 0;
  const searchMsg = (t) => { $('searchMsg').textContent = t || ''; };
  function closeSearch() { searchBox.classList.remove('open'); searchInput.blur(); }
  $('searchBtn').addEventListener('click', () => {
    searchBox.classList.toggle('open');
    if (searchBox.classList.contains('open')) { searchMsg(''); searchInput.focus(); searchInput.select(); }
  });
  $('searchClose').addEventListener('click', closeSearch);

  // Start playback; if Spotify has no active player, wake the first available device (the iPad's Spotify app).
  async function spPlay(body) {
    try {
      let r = await spApi('PUT', '/me/player/play', false, body);
      if (r && r.status === 404) {
        const d = await spApi('GET', '/me/player/devices');
        const list = (d && d.ok && (await d.json()).devices) || [];
        const pick = list.find((x) => x.is_active) || list[0];
        if (!pick) return 'Open the Spotify app on the iPad once, then try again.';
        r = await spApi('PUT', '/me/player/play?device_id=' + encodeURIComponent(pick.id), false, body);
      }
      if (!r) return 'Spotify is not connected.';
      if (!r.ok) return ((await r.json().catch(() => ({}))).error || {}).message || 'Spotify said no (' + r.status + ').';
      clearTimeout(spTimer); spTimer = setTimeout(spPoll, 600);
      return '';
    } catch { return 'No connection to Spotify.'; }
  }

  function renderResults(tracks) {
    results.textContent = '';
    for (const t of tracks) {
      const row = document.createElement('div'); row.className = 'res';
      const img = document.createElement('img');
      const imgs = (t.album && t.album.images) || [];
      if (imgs.length) img.src = (imgs[imgs.length - 1] || imgs[0]).url;
      const text = document.createElement('div'); text.className = 'res-text';
      const name = document.createElement('div'); name.className = 'res-name'; name.textContent = t.name;
      const by = document.createElement('div'); by.className = 'res-by'; by.textContent = (t.artists || []).map((a) => a.name).join(', ');
      text.append(name, by);
      const add = document.createElement('button'); add.className = 'res-add'; add.textContent = '+'; add.setAttribute('aria-label', 'Add to queue');
      add.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await spApi('POST', '/me/player/queue?uri=' + encodeURIComponent(t.uri)).catch(() => null);
        searchMsg(r && r.ok ? `Queued “${t.name}”.` : 'Could not queue it. Start something playing first.');
        if (r && r.ok) setTimeout(spQueue, 800);
      });
      row.addEventListener('click', async () => {
        searchMsg('Starting…');
        // play it inside its album so music carries on afterwards instead of stopping after one song
        const err = await spPlay(t.album && t.album.uri ? { context_uri: t.album.uri, offset: { uri: t.uri } } : { uris: [t.uri] });
        if (err) searchMsg(err); else closeSearch();
      });
      row.append(img, text, add);
      results.appendChild(row);
    }
  }
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) { results.textContent = ''; return searchMsg(''); }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const r = await spApi('GET', '/search?type=track&limit=8&q=' + encodeURIComponent(q));
        if (seq !== searchSeq) return; // a newer search is already on its way
        if (!r || !r.ok) return searchMsg('Search failed' + (r ? ' (' + r.status + ').' : '.'));
        const items = ((await r.json()).tracks || {}).items || [];
        renderResults(items.filter(Boolean));
        searchMsg(items.length ? '' : 'Nothing found.');
      } catch { searchMsg('No connection to Spotify.'); }
    }, 350);
  });
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); searchInput.blur(); });
  $('djBtn').addEventListener('click', async () => {
    searchMsg('Asking Spotify for the DJ…');
    const err = await spPlay({ context_uri: 'spotify:playlist:37i9dQZF1EYkqdzj48dyYq' });
    if (err) searchMsg('Spotify would not start the DJ from here (' + err + ') Start it in the Spotify app instead; Glance will still show it.'); else closeSearch();
  });

  $('connect').addEventListener('click', spLogin);
  $('spLogout').addEventListener('click', () => { ls.del('glance.sp'); spNote = ''; applyState({ active: false }); paintSettings(); });

  async function start() {
    try { const r = await fetch('api/wallpapers', { cache: 'no-store' }); hasServer = r.ok && (r.headers.get('content-type') || '').includes('json'); } catch {}
    MODE = hasServer && S.source !== 'spotify' ? 'mac' : 'spotify';
    S.source = MODE;
    loadWallpapers();
    if (MODE === 'mac') { paintSettings(); return connect(); }
    await spFinishLogin();
    paintSettings(); tickClock();
    spPoll();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) spPoll(); });
  }

  // ───────────── go ─────────────
  // A few pixels of drift each minute so nothing sits on exactly the same pixels all day.
  setInterval(() => { app.style.transform = `translate(${Math.round(Math.random() * 8 - 4)}px, ${Math.round(Math.random() * 8 - 4)}px)`; }, 60000);
  setInterval(tickClock, 1000);
  setInterval(() => { refreshMode(); tickPlayback(); }, 200);
  window.addEventListener('resize', () => { activeLine = -2; tickPlayback(); });
  if (S.place) $('placeInput').value = S.place.name;
  paintSettings(); tickClock(); keepAwake(); loadWeather(); start();
  window.glance = { applyState, applyLyrics }; // handy for poking at the display from the console
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { activeLine = -2; tickPlayback(); });
})();
