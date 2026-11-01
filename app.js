'use strict';

(() => {
  // =========================================================
  // 定数・状態
  // =========================================================
  const DB_NAME = 'tour-guide';
  const STORE = 'kv';
  const DEFAULT_PIN = '0000';
  const HERO_HYSTERESIS_M = 8;      // 最寄りスポットの入れ替わりを抑える距離差
  const RENDER_THROTTLE_MS = 1000;  // 位置更新時の再描画間隔
  const CAPTURE_SECONDS = 10;       // 現在地登録の平均化時間
  const ENC_FORMAT = 'tour-enc-v1';
  const PBKDF2_ITER = 250000;

  const state = {
    tour: null,
    visited: new Set(),
    lang: 'ja',
    pos: null,
    gpsStatus: 'off',
    gpsError: '',
    watchId: null,
    started: false,
    selectedId: null,
    routeId: null,
    customRoute: [],
    heroAutoId: null,
    heroId: null,
    editMode: false,
    dirty: false,
    placingId: null,
    projector: null,
    settings: { rate: 1.0, voiceJa: '', voiceEn: '', accLimit: 50 },
    speaking: null,
    wakeLock: null,
    lastRender: 0,
    renderTimer: null,
  };

  let speechToken = 0;

  const $ = (sel) => document.querySelector(sel);

  const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="2.5" height="14" rx="1" fill="currentColor"/><path d="M19 5v14L9 12z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="16.5" y="5" width="2.5" height="14" rx="1" fill="currentColor"/><path d="M5 5v14l10-7z" fill="currentColor"/></svg>',
    qr: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM18 18h2.5v2.5H18z" fill="currentColor" stroke="none"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };

  // =========================================================
  // 汎用
  // =========================================================
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function formatDist(d) {
    if (d === null || d === undefined) return '距離不明';
    if (d < 1000) return `約 ${Math.round(d)} m`;
    return `約 ${(d / 1000).toFixed(1)} km`;
  }

  function spotName(s) {
    return state.lang === 'en' && s.nameEn ? s.nameEn : s.name;
  }

  function spotText(s) {
    return state.lang === 'en' && s.textEn ? s.textEn : s.text;
  }

  function tourHasEnglish() {
    return !!state.tour && state.tour.spots.some((s) => s.textEn && s.textEn.trim());
  }

  function findSpot(id) {
    return state.tour ? state.tour.spots.find((s) => s.id === id) || null : null;
  }

  // ---- コース（どのスポットを、どの順番で回るか）----
  // routes が無い台本は、全スポットを番号順に回る1コースとして扱う
  const CUSTOM_ID = '__custom__';

  function activeRoute() {
    const t = state.tour;
    if (state.routeId === CUSTOM_ID) {
      const ids = state.customRoute.filter((id) => !!findSpot(id));
      if (ids.length) return { id: CUSTOM_ID, name: '自分で選んだコース', spots: ids, custom: true };
    }
    if (t.routes && t.routes.length) {
      return t.routes.find((r) => r.id === state.routeId) || t.routes[0];
    }
    return { id: '__all__', name: '全スポット', spots: t.spots.map((s) => s.id), implicit: true };
  }

  function routeSpots() {
    return activeRoute().spots.map(findSpot).filter(Boolean);
  }

  function inRoute(id) {
    return activeRoute().spots.includes(id);
  }

  // 画面に出す番号：コース内の順番（コース外のスポットは本来の番号）
  function dispNo(s) {
    const i = activeRoute().spots.indexOf(s.id);
    return i >= 0 ? i + 1 : s.no;
  }

  // 台本に保存されているコース（「自分で選んだコース」は含まない）。無ければ null
  function explicitRoute() {
    const t = state.tour;
    const r = activeRoute();
    return t.routes && t.routes.length && !r.custom ? r : null;
  }

  // コース選択に並べる候補
  function routeChoices() {
    const t = state.tour;
    const rows = t.routes.length
      ? t.routes.map((r) => ({ id: r.id, name: r.name, n: r.spots.length }))
      : [{ id: '__all__', name: '全スポット', n: t.spots.length }];
    const custom = state.customRoute.filter((id) => !!findSpot(id));
    if (custom.length) rows.push({ id: CUSTOM_ID, name: '自分で選んだコース', n: custom.length });
    return rows;
  }

  // =========================================================
  // IndexedDB（端末内保存）
  // =========================================================
  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function kvGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function kvSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveTour() {
    await kvSet('tour', state.tour);
  }

  async function saveVisited() {
    await kvSet('visited', Array.from(state.visited));
  }

  async function saveSettings() {
    await kvSet('settings', state.settings);
  }

  async function setDirty(v) {
    state.dirty = v;
    await kvSet('dirty', v);
    renderHeader();
  }

  // =========================================================
  // 台本データの正規化
  // =========================================================
  function normalizeTour(t) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.spots)) {
      throw new Error('台本ファイルの形式が正しくありません（spots がありません）');
    }
    const out = { version: 1, title: String(t.title || '見学ツアー'), map: null, spots: [] };
    if (t.map && typeof t.map.image === 'string' && t.map.image) {
      out.map = { image: t.map.image, width: num(t.map.width) || 0, height: num(t.map.height) || 0 };
    }
    const ids = new Set();
    t.spots.forEach((s, i) => {
      let id = String((s && s.id) || 'S' + String(i + 1).padStart(2, '0')).trim();
      while (ids.has(id)) id += '_';
      ids.add(id);
      out.spots.push({
        id,
        no: num(s.no) !== null ? num(s.no) : i + 1,
        name: String(s.name || 'スポット' + (i + 1)),
        nameEn: String(s.nameEn || ''),
        text: String(s.text || ''),
        textEn: String(s.textEn || ''),
        lat: num(s.lat),
        lng: num(s.lng),
        x: num(s.x),
        y: num(s.y),
        image: typeof s.image === 'string' ? s.image : '',
      });
    });
    out.spots.sort((a, b) => a.no - b.no);

    out.routes = [];
    if (Array.isArray(t.routes)) {
      const routeIds = new Set();
      t.routes.forEach((r, i) => {
        if (!r || typeof r !== 'object') return;
        let rid = String(r.id || 'R' + (i + 1)).trim();
        while (routeIds.has(rid)) rid += '_';
        routeIds.add(rid);
        const seen = new Set();
        const list = [];
        (Array.isArray(r.spots) ? r.spots : []).forEach((sid) => {
          const k = String(sid);
          if (ids.has(k) && !seen.has(k)) { seen.add(k); list.push(k); }
        });
        out.routes.push({ id: rid, name: String(r.name || 'コース' + (i + 1)), spots: list });
      });
    }
    return out;
  }

  function loadImageSize(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('構内図の画像を読み込めませんでした'));
      img.src = src;
    });
  }

  async function ensureMapSize() {
    const m = state.tour && state.tour.map;
    if (m && (!m.width || !m.height)) {
      const size = await loadImageSize(m.image);
      m.width = size.width;
      m.height = size.height;
      await saveTour();
    }
  }

  async function setTour(tour, { resetVisited = true } = {}) {
    state.tour = tour;
    await ensureMapSize();
    if (resetVisited) {
      state.visited = new Set();
      await saveVisited();
    }
    state.selectedId = null;
    state.heroAutoId = null;
    state.routeId = null;
    state.customRoute = [];
    await kvSet('routeId', null);
    await kvSet('customRoute', []);
    await saveTour();
    rebuildProjector();
    renderAll();
  }

  // =========================================================
  // 位置計算（距離・地図座標への変換）
  // =========================================================
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371008.8;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function det3(m) {
    return (
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    );
  }

  function solve3(m, b) {
    const d = det3(m);
    const res = [];
    for (let c = 0; c < 3; c++) {
      const mc = m.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)));
      res.push(det3(mc) / d);
    }
    return res;
  }

  // 緯度経度 → 地図画像の画素座標（最小二乗のアフィン変換）
  function fitAffine(points) {
    if (points.length < 3) return null;
    const n = points.length;
    const lat0 = points.reduce((a, p) => a + p.lat, 0) / n;
    const lng0 = points.reduce((a, p) => a + p.lng, 0) / n;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110540;
    const toUV = (lat, lng) => ({ u: (lng - lng0) * kx, v: (lat - lat0) * ky });

    let Suu = 0, Suv = 0, Su = 0, Svv = 0, Sv = 0;
    let Sux = 0, Svx = 0, Sx = 0, Suy = 0, Svy = 0, Sy = 0;
    points.forEach((p) => {
      const { u, v } = toUV(p.lat, p.lng);
      Suu += u * u; Suv += u * v; Su += u; Svv += v * v; Sv += v;
      Sux += u * p.x; Svx += v * p.x; Sx += p.x;
      Suy += u * p.y; Svy += v * p.y; Sy += p.y;
    });
    const M = [[Suu, Suv, Su], [Suv, Svv, Sv], [Su, Sv, n]];
    const d = det3(M);
    const scale = Math.abs(Suu * Svv * n) || 1;
    if (!Number.isFinite(d) || Math.abs(d) < scale * 1e-6) return null; // 一直線上に並んでいる等

    const [a, b, c] = solve3(M, [Sux, Svx, Sx]);
    const [dd, e, f] = solve3(M, [Suy, Svy, Sy]);
    const pxPerMeter = Math.sqrt(Math.abs(a * e - b * dd));
    if (!Number.isFinite(pxPerMeter) || pxPerMeter <= 0) return null;
    return {
      kind: 'affine',
      toXY(lat, lng) {
        const { u, v } = toUV(lat, lng);
        return { x: a * u + b * v + c, y: dd * u + e * v + f };
      },
      pxPerMeter,
    };
  }

  // 構内図が無いとき：スポットの緯度経度から簡易マップを作る
  function fitSchematic(points, W, H, pad) {
    if (!points.length) return null;
    const lat0 = points.reduce((a, p) => a + p.lat, 0) / points.length;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110540;
    const us = points.map((p) => p.lng * kx);
    const vs = points.map((p) => p.lat * ky);
    const minU = Math.min(...us), maxU = Math.max(...us);
    const minV = Math.min(...vs), maxV = Math.max(...vs);
    const spanU = Math.max(maxU - minU, 1);
    const spanV = Math.max(maxV - minV, 1);
    let s = Math.min((W - 2 * pad) / spanU, (H - 2 * pad) / spanV);
    if (points.length === 1) s = 2;
    const cu = (minU + maxU) / 2;
    const cv = (minV + maxV) / 2;
    return {
      kind: 'schematic',
      toXY(lat, lng) {
        return { x: W / 2 + (lng * kx - cu) * s, y: H / 2 - (lat * ky - cv) * s };
      },
      pxPerMeter: s,
    };
  }

  function mapSize() {
    const t = state.tour;
    if (t && t.map) return { W: t.map.width || 1600, H: t.map.height || 1000 };
    return { W: 1000, H: 700 };
  }

  function rebuildProjector() {
    const t = state.tour;
    if (!t) { state.projector = null; return; }
    if (t.map) {
      const pts = t.spots.filter((s) => s.lat !== null && s.lng !== null && s.x !== null && s.y !== null);
      state.projector = fitAffine(pts);
    } else {
      const { W, H } = mapSize();
      const pts = t.spots.filter((s) => s.lat !== null && s.lng !== null);
      state.projector = fitSchematic(pts, W, H, 90);
    }
  }

  function spotXY(s) {
    const t = state.tour;
    if (t.map && s.x !== null && s.y !== null) return { x: s.x, y: s.y };
    if (state.projector && s.lat !== null && s.lng !== null) return state.projector.toXY(s.lat, s.lng);
    return null;
  }

  function computeOrder() {
    const p = state.pos;
    const good = !!p && p.acc <= state.settings.accLimit;
    const rs = routeSpots();
    const idx = new Map(rs.map((s, i) => [s.id, i]));
    const items = rs.map((s) => ({
      s,
      d: p && s.lat !== null && s.lng !== null ? haversine(p.lat, p.lng, s.lat, s.lng) : null,
    }));
    if (good) {
      items.sort((a, b) => (a.d === null) - (b.d === null) || (a.d || 0) - (b.d || 0) || idx.get(a.s.id) - idx.get(b.s.id));
    } else {
      items.sort((a, b) => idx.get(a.s.id) - idx.get(b.s.id));
    }
    return { items, good };
  }

  function pickHero(order) {
    if (state.selectedId && findSpot(state.selectedId) && inRoute(state.selectedId)) {
      return { id: state.selectedId, reason: 'selected' };
    }
    if (order.good) {
      const nearest = order.items.find((i) => i.d !== null);
      if (nearest) {
        const cur = order.items.find((i) => i.s.id === state.heroAutoId);
        if (cur && cur.d !== null && cur.s.id !== nearest.s.id && cur.d - nearest.d < HERO_HYSTERESIS_M) {
          return { id: cur.s.id, reason: 'near' };
        }
        state.heroAutoId = nearest.s.id;
        return { id: nearest.s.id, reason: 'near' };
      }
    }
    const next = order.items.find((i) => !state.visited.has(i.s.id)) || order.items[0];
    return next ? { id: next.s.id, reason: 'next' } : null;
  }

  // =========================================================
  // 描画
  // =========================================================
  function renderAll() {
    if (!state.tour) return;
    renderHeader();
    renderMapBg();
    renderSide();
  }

  function renderHeader() {
    const t = state.tour;
    $('#tourTitle').textContent = t ? t.title : '見学ガイド';
    if (t) {
      const rs = routeSpots();
      $('#chipProgress').textContent = `見学済み ${rs.filter((s) => state.visited.has(s.id)).length} / ${rs.length}`;
      $('#btnRoute').classList.remove('hidden');
      $('#btnRoute').textContent = `コース：${activeRoute().name}`;
    } else {
      $('#chipProgress').textContent = '';
    }
    $('#btnRouteEdit').classList.toggle('hidden', !state.editMode);
    $('#chipEdit').classList.toggle('hidden', !state.editMode);
    $('#chipDirty').classList.toggle('hidden', !state.dirty);
    $('#btnLang').textContent = state.lang === 'en' ? 'English' : '日本語';
    $('#btnAddSpot').classList.toggle('hidden', !state.editMode);
    $('#btnAuto').classList.toggle('hidden', !state.selectedId);
    $('#btnEditToggle').textContent = state.editMode ? '編集モードを終了' : '編集モードにする';
    $('#btnTourSettings').classList.toggle('hidden', !state.editMode);
    renderGpsChip();
  }

  function renderGpsChip() {
    const chip = $('#chipGps');
    chip.classList.remove('gps-good', 'gps-poor', 'gps-error');
    let text = '位置情報 停止中';
    if (state.gpsStatus === 'waiting') text = '位置情報 取得中…';
    if (state.gpsStatus === 'error') { text = state.gpsError || '位置情報が使えません'; chip.classList.add('gps-error'); }
    if (state.pos && state.gpsStatus === 'ok') {
      const acc = Math.round(state.pos.acc);
      if (state.pos.acc <= state.settings.accLimit) {
        text = `GPS ±${acc} m`;
        chip.classList.add('gps-good');
      } else {
        text = `GPS 精度低 ±${acc} m（QR・タップで選択）`;
        chip.classList.add('gps-poor');
      }
    }
    $('#gpsText').textContent = text;

    const box = $('#posReadout');
    if (state.pos) {
      const p = state.pos;
      const ageSec = Math.max(0, Math.round((Date.now() - p.ts) / 1000));
      $('#posLatLng').textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
      $('#posSub').textContent = `精度 ±${Math.round(p.acc)} m ・ ${ageSec} 秒前`;
      box.classList.toggle('poor', p.acc > state.settings.accLimit);
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
  }

  function svgEl(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }

  function renderMapBg() {
    const t = state.tour;
    const svg = $('#map');
    const bg = $('#mapBg');
    const { W, H } = mapSize();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    bg.textContent = '';
    if (t.map) {
      const img = svgEl('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' });
      img.setAttribute('href', t.map.image);
      bg.appendChild(img);
    } else {
      const step = 50;
      for (let x = 0; x <= W; x += step) bg.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: H, class: 'grid-line' }));
      for (let y = 0; y <= H; y += step) bg.appendChild(svgEl('line', { x1: 0, y1: y, x2: W, y2: y, class: 'grid-line' }));
    }
    renderPins();
    renderPos();
  }

  function renderPins() {
    const t = state.tour;
    const { W } = mapSize();
    const r = Math.max(14, W / 70);
    const pins = $('#mapPins');
    const route = $('#mapRoute');
    pins.textContent = '';
    route.textContent = '';

    const rs = routeSpots();
    const placed = rs.map((s) => ({ s, p: spotXY(s) })).filter((o) => o.p);
    if (placed.length >= 2) {
      const pts = placed.map((o) => `${o.p.x.toFixed(1)},${o.p.y.toFixed(1)}`).join(' ');
      route.appendChild(svgEl('polyline', { points: pts, class: 'route', 'stroke-width': Math.max(3, r / 5) }));
    }

    placed.forEach(({ s, p }) => {
      const cls = ['pin'];
      if (state.visited.has(s.id)) cls.push('visited');
      if (s.id === state.heroId) cls.push('hero');
      const g = svgEl('g', { class: cls.join(' '), transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`, 'data-id': s.id });
      g.appendChild(svgEl('circle', { class: 'pulse', r, 'stroke-width': r / 4 }));
      g.appendChild(svgEl('circle', { class: 'pin-body', r, 'stroke-width': r / 6 }));
      const tx = svgEl('text', { 'font-size': r * 1.05 });
      tx.textContent = String(dispNo(s));
      g.appendChild(tx);
      const label = svgEl('text', { class: 'pin-label', x: 0, y: r * 2.1, 'font-size': r * 0.85, 'text-anchor': 'middle', 'stroke-width': r / 3.5 });
      label.textContent = spotName(s);
      g.appendChild(label);
      g.addEventListener('click', (ev) => {
        if (state.placingId) return;
        ev.stopPropagation();
        selectSpot(s.id);
      });
      pins.appendChild(g);
    });

    const note = $('#mapNote');
    const unplaced = rs.length - placed.length;
    const msgs = [];
    if (unplaced > 0) msgs.push(`地図に未配置のスポット ${unplaced} 件`);
    if (t.map && !state.projector) msgs.push('現在地表示には、緯度経度と地図位置の両方を持つスポットが3件以上必要です');
    note.textContent = msgs.join(' ／ ');
  }

  function renderPos() {
    const g = $('#mapPos');
    g.textContent = '';
    const p = state.pos;
    if (!p || !state.projector) return;
    const { W, H } = mapSize();
    const xy = state.projector.toXY(p.lat, p.lng);
    if (xy.x < -W * 0.5 || xy.x > W * 1.5 || xy.y < -H * 0.5 || xy.y > H * 1.5) return;
    const accR = Math.min(Math.max(p.acc * state.projector.pxPerMeter, 6), W);
    const dotR = Math.max(9, W / 110);
    g.appendChild(svgEl('circle', { class: 'pos-acc', cx: xy.x, cy: xy.y, r: accR, 'stroke-width': 2 }));
    g.appendChild(svgEl('circle', { class: 'pos-dot', cx: xy.x, cy: xy.y, r: dotR, 'stroke-width': dotR / 3 }));
  }

  function renderSide() {
    const t = state.tour;
    const order = computeOrder();
    const hero = pickHero(order);
    const prevHero = state.heroId;
    state.heroId = hero ? hero.id : null;

    // ヒーローカード
    const heroEl = $('#hero');
    if (!hero) {
      heroEl.className = 'hero empty';
      heroEl.innerHTML = state.editMode
        ? '<div class="hero-reason">スポットがありません</div><p>「＋ スポット追加」から登録してください。</p>'
        : '<div class="hero-reason">スポットがありません</div><p>メニューから台本を読み込むか、編集モードで追加してください。</p>';
    } else {
      const item = order.items.find((i) => i.s.id === hero.id);
      const s = item.s;
      const reasonText = {
        selected: '選択中のスポット',
        near: 'いちばん近いスポット',
        next: order.good || !state.pos ? '次のおすすめ' : '次のおすすめ（位置精度が低いため番号順）',
      }[hero.reason];
      const visited = state.visited.has(s.id);
      heroEl.className = 'hero';
      heroEl.innerHTML = `
        <div class="hero-reason">${esc(reasonText)}</div>
        <div class="hero-main">
          <div class="hero-no">${esc(dispNo(s))}</div>
          <div>
            <div class="hero-name">${esc(spotName(s))}</div>
            <div class="hero-meta"><span>${esc(formatDist(item.d))}</span>${visited ? '<span>見学済み</span>' : ''}</div>
          </div>
        </div>
        <button class="hero-play" type="button" id="btnHeroPlay">${ICONS.play}<span>${state.lang === 'en' ? 'Play' : '説明を再生'}</span></button>
        ${state.editMode ? `<div class="hero-sub-actions"><button class="btn small" type="button" id="btnHeroEdit">${ICONS.edit}このスポットを編集</button></div>` : ''}
      `;
      $('#btnHeroPlay').addEventListener('click', () => playSpot(s.id));
      if (state.editMode) $('#btnHeroEdit').addEventListener('click', () => openSpotEditor(s.id));
    }

    // 一覧
    $('#listTitle').textContent = order.good ? '近い順' : '番号順';
    const list = $('#spotList');
    list.innerHTML = order.items.map((i) => {
      const s = i.s;
      const cls = ['spot-item'];
      if (state.visited.has(s.id)) cls.push('visited');
      if (hero && s.id === hero.id) cls.push('is-hero');
      const sub = state.editMode
        ? `<small>${esc(s.id)}${s.lat === null ? '・緯度経度なし' : ''}${state.tour.map && s.x === null ? '・地図位置なし' : ''}</small>`
        : '';
      return `<li class="${cls.join(' ')}" data-id="${esc(s.id)}">
        <span class="spot-no">${esc(dispNo(s))}</span>
        <span class="spot-name">${esc(spotName(s))}${sub}</span>
        ${state.visited.has(s.id) ? `<span class="spot-check">${ICONS.check}</span>` : ''}
        <span class="spot-dist">${i.d !== null ? esc(formatDist(i.d)) : ''}</span>
        ${state.editMode ? `<button class="btn small spot-edit" type="button" data-edit="${esc(s.id)}">${ICONS.edit}</button>` : ''}
      </li>`;
    }).join('');

    renderHeader();
    if (prevHero !== state.heroId) renderPins();
  }

  function scheduleRender() {
    const now = Date.now();
    const wait = RENDER_THROTTLE_MS - (now - state.lastRender);
    if (wait <= 0) {
      state.lastRender = now;
      renderSide();
      renderPos();
    } else if (!state.renderTimer) {
      state.renderTimer = setTimeout(() => {
        state.renderTimer = null;
        state.lastRender = Date.now();
        renderSide();
        renderPos();
      }, wait);
    }
  }

  function selectSpot(id) {
    state.selectedId = id;
    renderSide();
    renderPins();
  }

  function clearSelection() {
    state.selectedId = null;
    renderSide();
    renderPins();
  }

  // =========================================================
  // 位置情報
  // =========================================================
  function startGps() {
    if (!('geolocation' in navigator)) {
      state.gpsStatus = 'error';
      state.gpsError = 'この端末は位置情報に対応していません';
      renderGpsChip();
      return;
    }
    if (state.watchId !== null) return;
    state.gpsStatus = 'waiting';
    renderGpsChip();
    state.watchId = navigator.geolocation.watchPosition(
      (p) => {
        state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp };
        state.gpsStatus = 'ok';
        scheduleRender();
      },
      (err) => {
        state.gpsStatus = 'error';
        state.gpsError = err.code === 1 ? '位置情報が許可されていません' : '位置情報を取得できません';
        renderGpsChip();
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
    );
  }

  // =========================================================
  // 読み上げ
  // =========================================================
  let voices = [];

  function loadVoices() {
    voices = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
    fillVoiceSelect($('#selVoiceJa'), 'ja', state.settings.voiceJa);
    fillVoiceSelect($('#selVoiceEn'), 'en', state.settings.voiceEn);
  }

  function fillVoiceSelect(sel, prefix, current) {
    const list = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(prefix));
    sel.innerHTML = `<option value="">${prefix === 'ja' ? '自動（Kyoko優先）' : '自動'}</option>` + list.map((v) =>
      `<option value="${esc(v.voiceURI)}"${v.voiceURI === current ? ' selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`
    ).join('');
  }

  function pickVoice(lang) {
    const uri = lang === 'en' ? state.settings.voiceEn : state.settings.voiceJa;
    if (uri) {
      const v = voices.find((x) => x.voiceURI === uri);
      if (v) return v;
    }
    const list = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(lang));
    if (lang === 'ja') {
      const kyoko = list.find((v) => /^kyoko/i.test(v.name));
      if (kyoko) return kyoko;
    }
    return list.find((v) => v.localService) || list[0] || null;
  }

  function splitSentences(text) {
    const out = [];
    const chars = Array.from(String(text || ''));
    let buf = '';
    const closers = '」』）)"\'”’';
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === '\n' || c === '\r') {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        continue;
      }
      buf += c;
      const isEnd = '。！？!?'.includes(c) || (c === '.' && (i + 1 >= chars.length || /\s/.test(chars[i + 1])));
      if (isEnd) {
        while (i + 1 < chars.length && closers.includes(chars[i + 1])) buf += chars[++i];
        if (buf.trim()) out.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function unlockSpeech() {
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (e) {
      // 読み上げ非対応環境では何もしない
    }
  }

  function playSpot(id, startIndex = 0) {
    const s = findSpot(id);
    if (!s) return;
    if (!('speechSynthesis' in window)) {
      toast('この端末は読み上げに対応していません');
      return;
    }
    const lang = state.lang === 'en' && s.textEn ? 'en' : 'ja';
    const sentences = splitSentences(lang === 'en' ? s.textEn : s.text);
    if (!sentences.length) {
      toast('説明文が登録されていません');
      return;
    }
    state.visited.add(s.id);
    saveVisited();
    state.speaking = { spotId: s.id, lang, sentences, index: Math.min(startIndex, sentences.length - 1), paused: false, done: false };
    openStage();
    speakCurrent();
  }

  function speakCurrent() {
    const sp = state.speaking;
    if (!sp) return;
    if (sp.index >= sp.sentences.length) {
      finishSpeaking();
      return;
    }
    const token = ++speechToken;
    sp.paused = false;
    renderStage();

    const u = new SpeechSynthesisUtterance(sp.sentences[sp.index]);
    u.lang = sp.lang === 'en' ? 'en-US' : 'ja-JP';
    const v = pickVoice(sp.lang);
    if (v) u.voice = v;
    u.rate = state.settings.rate;
    u.onend = () => {
      if (token !== speechToken || !state.speaking) return;
      state.speaking.index++;
      speakCurrent();
    };
    u.onerror = (e) => {
      if (token !== speechToken || !state.speaking) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      // 読み上げに失敗したら一時停止にして、人が「再開」できるようにする
      speechToken++;
      state.speaking.paused = true;
      renderStage();
      toast('読み上げに失敗しました。「再開」を押すか、メニューで声を選び直してください', 4500);
    };

    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      setTimeout(() => { if (token === speechToken) speechSynthesis.speak(u); }, 80);
    } else {
      speechSynthesis.speak(u);
    }
  }

  function pauseSpeaking() {
    const sp = state.speaking;
    if (!sp) return;
    speechToken++;
    speechSynthesis.cancel();
    sp.paused = true;
    renderStage();
  }

  function stopSpeaking() {
    speechToken++;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    state.speaking = null;
    closeStage();
  }

  function finishSpeaking() {
    const sp = state.speaking;
    if (!sp) return;
    sp.done = true;
    sp.index = sp.sentences.length;
    renderStage();
  }

  function openStage() {
    const s = findSpot(state.speaking.spotId);
    $('#stageNo').textContent = String(dispNo(s));
    $('#stageTitle').textContent = spotName(s);
    const bg = $('#stageBg');
    bg.style.backgroundImage = s.image ? `url("${s.image.replace(/"/g, '%22')}")` : '';
    $('#stageBody').innerHTML = state.speaking.sentences.map((t, i) => `<div class="sentence" data-i="${i}">${esc(t)}</div>`).join('');
    $('#stage').classList.remove('hidden');
  }

  function renderStage() {
    const sp = state.speaking;
    if (!sp) return;
    const stage = $('#stage');
    stage.classList.toggle('done', sp.done);
    $('#stageSub').textContent = sp.done ? (sp.lang === 'en' ? 'FINISHED' : '説明が終わりました') : sp.paused ? '一時停止中' : 'NOW EXPLAINING';
    $('#stageControls').classList.toggle('hidden', sp.done);
    $('#stageDone').classList.toggle('hidden', !sp.done);
    $('#btnPause').innerHTML = sp.paused ? `${ICONS.play}<span>再開</span>` : `${ICONS.pause}<span>一時停止</span>`;
    const nodes = document.querySelectorAll('#stageBody .sentence');
    nodes.forEach((n, i) => {
      n.classList.toggle('current', i === sp.index && !sp.done);
      n.classList.toggle('done', i < sp.index);
    });
    const cur = nodes[sp.index];
    if (cur && !sp.done) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('#stageBar').style.width = `${Math.round((Math.min(sp.index, sp.sentences.length) / sp.sentences.length) * 100)}%`;
  }

  function closeStage() {
    $('#stage').classList.add('hidden');
    $('#stage').classList.remove('done');
    state.speaking = null;
    state.selectedId = null;
    renderSide();
    renderPins();
  }

  // =========================================================
  // 画面スリープ防止
  // =========================================================
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        state.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {
      // 非対応・拒否時は何もしない
    }
  }

  // =========================================================
  // 暗号化（Web Crypto: PBKDF2 + AES-GCM）
  // =========================================================
  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(pass, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptJson(obj, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt, PBKDF2_ITER);
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
    return { format: ENC_FORMAT, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITER, salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(ct) };
  }

  async function decryptJson(env, pass) {
    const key = await deriveKey(pass, b64ToBytes(env.salt), env.iterations || PBKDF2_ITER);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.data));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // =========================================================
  // 入力ダイアログ（パスフレーズ・PIN）
  // =========================================================
  function promptSecret({ title, text, validate }) {
    return new Promise((resolve) => {
      const dlg = $('#dlgPrompt');
      const form = $('#formPrompt');
      const input = $('#promptInput');
      const err = $('#promptError');
      $('#promptTitle').textContent = title;
      $('#promptText').textContent = text || '';
      input.value = '';
      err.textContent = '';
      let busy = false;

      const cleanup = () => {
        form.removeEventListener('submit', onSubmit);
        $('#btnPromptCancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('cancel', onCancel);
      };
      const onSubmit = async (ev) => {
        ev.preventDefault();
        if (busy) return;
        busy = true;
        const v = input.value;
        try {
          const result = validate ? await validate(v) : v;
          cleanup();
          dlg.close();
          resolve(result);
        } catch (e) {
          err.textContent = e.message || '正しくありません';
          input.select();
        } finally {
          busy = false;
        }
      };
      const onCancel = (ev) => {
        if (ev) ev.preventDefault();
        cleanup();
        dlg.close();
        resolve(null);
      };
      form.addEventListener('submit', onSubmit);
      $('#btnPromptCancel').addEventListener('click', onCancel);
      dlg.addEventListener('cancel', onCancel);
      dlg.showModal();
      setTimeout(() => input.focus(), 50);
    });
  }

  async function checkPin() {
    const pin = (await kvGet('pin')) || DEFAULT_PIN;
    const ok = await promptSecret({
      title: '編集用PIN',
      text: '編集モードに入るにはPINを入力してください。',
      validate: (v) => {
        if (v !== pin) throw new Error('PINが違います');
        return true;
      },
    });
    return ok === true;
  }

  // =========================================================
  // 読み込み・書き出し
  // =========================================================
  async function importFromText(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('JSONとして読み込めませんでした');
    }
    if (obj && obj.format === ENC_FORMAT) {
      const dec = await promptSecret({
        title: '暗号化された台本',
        text: '書き出したときのパスフレーズを入力してください。',
        validate: async (v) => {
          try {
            return await decryptJson(obj, v);
          } catch (e) {
            throw new Error('パスフレーズが違うか、ファイルが壊れています');
          }
        },
      });
      if (!dec) return false;
      obj = dec;
    }
    const tour = normalizeTour(obj);
    if (state.tour && state.dirty) {
      if (!confirm('書き出していない変更があります。上書きして読み込みますか？')) return false;
    }
    await setTour(tour);
    await setDirty(false);
    return true;
  }

  async function handleImportFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const ok = await importFromText(text);
      if (ok) {
        toast(`「${state.tour.title}」を読み込みました（${state.tour.spots.length} スポット）`);
        showWelcome();
      }
    } catch (e) {
      toast(e.message || '読み込みに失敗しました', 4000);
    }
  }

  async function loadSample() {
    try {
      const res = await fetch('sample/sample-tour.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('サンプルを取得できませんでした');
      const ok = await importFromText(await res.text());
      if (ok) {
        toast('サンプルを読み込みました');
        showWelcome();
      }
    } catch (e) {
      toast(e.message || 'サンプルを読み込めませんでした', 4000);
    }
  }

  let exportFile = null;
  let exportUrl = null;

  function openExport() {
    if (!state.tour) { toast('台本が読み込まれていません'); return; }
    $('#ePass').value = '';
    $('#ePass2').value = '';
    $('#exportReady').classList.add('hidden');
    exportFile = null;
    $('#dlgExport').showModal();
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function makeExportFile(ev) {
    ev.preventDefault();
    const pass = $('#ePass').value;
    if (pass !== $('#ePass2').value) { toast('パスフレーズが一致しません'); return; }
    const btn = $('#btnExportMake');
    btn.disabled = true;
    btn.textContent = '作成中…';
    try {
      const body = pass ? await encryptJson(state.tour, pass) : state.tour;
      const json = JSON.stringify(body, null, pass ? 0 : 2);
      const name = `tour-${timestamp()}${pass ? '.enc' : ''}.json`;
      exportFile = new File([json], name, { type: 'application/json' });
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      exportUrl = URL.createObjectURL(exportFile);
      const a = $('#lnkDownload');
      a.href = exportUrl;
      a.download = name;
      $('#exportInfo').textContent = `${name}（${Math.max(1, Math.round(exportFile.size / 1024))} KB${pass ? '・暗号化済み' : ''}）を作成しました。`;
      $('#exportReady').classList.remove('hidden');
    } catch (e) {
      toast('ファイルを作成できませんでした', 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'ファイルを作成';
    }
  }

  async function shareExport() {
    if (!exportFile) return;
    if (navigator.canShare && navigator.canShare({ files: [exportFile] })) {
      try {
        await navigator.share({ files: [exportFile], title: exportFile.name });
        await setDirty(false);
        toast('書き出しました');
      } catch (e) {
        if (e.name !== 'AbortError') toast('共有できませんでした。「ダウンロード」を使ってください', 4000);
      }
    } else {
      toast('この環境では共有できません。「ダウンロード」を使ってください', 4000);
    }
  }

  // =========================================================
  // 画像の縮小
  // =========================================================
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  async function downscaleImage(file, maxSide, quality) {
    const src = await readAsDataUrl(file);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = src;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: c.toDataURL('image/jpeg', quality), width: w, height: h };
  }

  // =========================================================
  // 編集モード
  // =========================================================
  async function toggleEditMode() {
    if (state.editMode) {
      state.editMode = false;
      $('#dlgMenu').close();
      renderAll();
      if (state.dirty) toast('変更はこのiPadに保存済みです。他の端末へは「書き出す」で渡してください', 4500);
      return;
    }
    $('#dlgMenu').close();
    if (await checkPin()) {
      state.editMode = true;
      renderAll();
      toast('編集モードです。スポットの鉛筆ボタンで編集できます');
    }
  }

  let editingId = null;
  let editingPhoto = '';
  let captureWatch = null;

  // コースが設定されている台本で新しいスポットを作ったときは、いまのコースの末尾に入れる
  function addToActiveRoute(id) {
    if (activeRoute().custom) {
      if (!state.customRoute.includes(id)) {
        state.customRoute.push(id);
        kvSet('customRoute', state.customRoute);
      }
      return;
    }
    const r = explicitRoute();
    if (r && !r.spots.includes(id)) r.spots.push(id);
  }

  // ---------------------------------------------------------
  // コースの切り替え・編集
  // ---------------------------------------------------------
  async function setRoute(id, resetVisited) {
    state.routeId = id;
    await kvSet('routeId', id);
    if (resetVisited) {
      state.visited = new Set();
      await saveVisited();
    }
    state.selectedId = null;
    state.heroAutoId = null;
    renderAll();
  }

  function openRoutePick() {
    const cur = activeRoute();
    $('#routePickList').innerHTML = routeChoices().map((r) =>
      `<button class="route-opt${r.id === cur.id ? ' current' : ''}" type="button" data-route="${esc(r.id)}">` +
      `<span class="route-opt-name">${esc(r.name)}</span><span class="route-opt-count">${r.n} か所</span></button>`
    ).join('');
    $('#chkResetVisited').checked = true;
    $('#dlgRoutePick').showModal();
  }

  function openRouteEdit() {
    renderRouteEdit();
    $('#dlgRouteEdit').showModal();
  }

  function renderRouteEdit() {
    const r = explicitRoute();
    $('#routeEmpty').textContent = activeRoute().custom
      ? 'いまは「自分で選んだコース」を使っています。「＋ 新しいコース」を押すと、この順番をコースとして保存できます。'
      : 'コースはまだありません。「新しいコース」を押すと、いまの全スポットをコピーしたコースができます。';
    $('#routeEmpty').classList.toggle('hidden', !!r);
    $('#routeBody').classList.toggle('hidden', !r);
    $('#btnRouteDel').classList.toggle('hidden', !r);
    if (!r) return;
    $('#rName').value = r.name;
    $('#routeIn').innerHTML = r.spots.map((id, i) => {
      const s = findSpot(id);
      if (!s) return '';
      return `<li class="route-row">
        <span class="spot-no">${i + 1}</span>
        <span class="route-row-name">${esc(s.name)}</span>
        <button class="btn small" type="button" data-act="up" data-id="${esc(id)}"${i === 0 ? ' disabled' : ''} aria-label="上へ">↑</button>
        <button class="btn small" type="button" data-act="down" data-id="${esc(id)}"${i === r.spots.length - 1 ? ' disabled' : ''} aria-label="下へ">↓</button>
        <button class="btn small" type="button" data-act="edit" data-id="${esc(id)}">編集</button>
        <button class="btn small danger" type="button" data-act="remove" data-id="${esc(id)}">外す</button>
      </li>`;
    }).join('');
    const out = state.tour.spots.filter((s) => !r.spots.includes(s.id));
    $('#routeOut').innerHTML = out.length
      ? out.map((s) => `<li class="route-row">
        <span class="route-row-name">${esc(s.name)}</span>
        <button class="btn small" type="button" data-act="edit" data-id="${esc(s.id)}">編集</button>
        <button class="btn small" type="button" data-act="add" data-id="${esc(s.id)}">＋ 追加</button>
      </li>`).join('')
      : '<li class="muted small route-row">すべてのスポットがこのコースに入っています</li>';
  }

  async function commitRoutes() {
    await saveTour();
    await setDirty(true);
    renderRouteEdit();
    renderAll();
  }

  async function routeEditClick(ev) {
    const btn = ev.target.closest('[data-act]');
    const r = explicitRoute();
    if (!btn || !r) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const i = r.spots.indexOf(id);
    if (act === 'edit') {
      $('#dlgRouteEdit').close();
      openSpotEditor(id);
      return;
    }
    if (act === 'up' && i > 0) {
      [r.spots[i - 1], r.spots[i]] = [r.spots[i], r.spots[i - 1]];
    } else if (act === 'down' && i >= 0 && i < r.spots.length - 1) {
      [r.spots[i + 1], r.spots[i]] = [r.spots[i], r.spots[i + 1]];
    } else if (act === 'remove' && i >= 0) {
      r.spots.splice(i, 1);
    } else if (act === 'add' && i < 0) {
      r.spots.push(id);
    } else {
      return;
    }
    await commitRoutes();
  }

  async function newRoute() {
    const t = state.tour;
    const base = activeRoute();
    let n = t.routes.length + 1;
    while (t.routes.some((r) => r.id === 'R' + n)) n++;
    const r = { id: 'R' + n, name: `コース${t.routes.length + 1}`, spots: base.spots.slice() };
    t.routes.push(r);
    state.routeId = r.id;
    await kvSet('routeId', r.id);
    state.selectedId = null;
    state.heroAutoId = null;
    await commitRoutes();
    toast('「' + base.name + '」をコピーして新しいコースを作りました。名前と順番を直してください', 4000);
  }

  async function deleteRoute() {
    const r = explicitRoute();
    if (!r) return;
    if (!confirm(`コース「${r.name}」を削除しますか？（スポット自体は消えません）`)) return;
    const t = state.tour;
    t.routes = t.routes.filter((x) => x.id !== r.id);
    state.routeId = t.routes.length ? t.routes[0].id : null;
    await kvSet('routeId', state.routeId);
    state.selectedId = null;
    state.heroAutoId = null;
    await commitRoutes();
  }

  // ---------------------------------------------------------
  // 自分で選ぶ（スポットを1つずつタップして、回る順番を決める）
  // ---------------------------------------------------------
  let customDraft = [];

  function openCustom() {
    customDraft = state.customRoute.filter((id) => !!findSpot(id));
    renderCustom();
    $('#dlgRoutePick').close();
    $('#dlgCustom').showModal();
  }

  function renderCustom() {
    $('#customList').innerHTML = state.tour.spots.map((s) => {
      const i = customDraft.indexOf(s.id);
      const on = i >= 0;
      return `<li class="route-row cust-row${on ? ' on' : ''}" data-id="${esc(s.id)}">
        <span class="cust-no">${on ? i + 1 : ''}</span>
        <span class="route-row-name">${esc(s.name)}</span>
        ${on ? `<button class="btn small" type="button" data-act="up" data-id="${esc(s.id)}"${i === 0 ? ' disabled' : ''} aria-label="上へ">↑</button>
        <button class="btn small" type="button" data-act="down" data-id="${esc(s.id)}"${i === customDraft.length - 1 ? ' disabled' : ''} aria-label="下へ">↓</button>` : ''}
      </li>`;
    }).join('');
    $('#customCount').textContent = `${customDraft.length} か所を選択中`;
    $('#customError').textContent = '';
  }

  function customListClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (btn) {
      const id = btn.dataset.id;
      const i = customDraft.indexOf(id);
      if (btn.dataset.act === 'up' && i > 0) {
        [customDraft[i - 1], customDraft[i]] = [customDraft[i], customDraft[i - 1]];
      } else if (btn.dataset.act === 'down' && i >= 0 && i < customDraft.length - 1) {
        [customDraft[i + 1], customDraft[i]] = [customDraft[i], customDraft[i + 1]];
      }
      renderCustom();
      return;
    }
    const li = ev.target.closest('.cust-row');
    if (!li) return;
    const id = li.dataset.id;
    const i = customDraft.indexOf(id);
    if (i >= 0) customDraft.splice(i, 1); else customDraft.push(id);
    renderCustom();
  }

  async function startCustom() {
    if (!customDraft.length) {
      $('#customError').textContent = 'スポットを1つ以上選んでください';
      return;
    }
    state.customRoute = customDraft.slice();
    await kvSet('customRoute', state.customRoute);
    await setRoute(CUSTOM_ID, true);
    $('#dlgCustom').close();
    toast(`自分で選んだコース（${state.customRoute.length} か所）で始めます`);
  }

  async function saveCustomAsRoute() {
    if (!customDraft.length) {
      $('#customError').textContent = 'スポットを1つ以上選んでください';
      return;
    }
    // 台本の内容が変わるので、編集モードでなければPINを確認する
    if (!state.editMode && !(await checkPin())) return;
    const t = state.tour;
    const name = prompt('コース名を入力してください', `コース${t.routes.length + 1}`);
    if (!name || !name.trim()) return;
    if (t.routes.length === 0) {
      // 最初のコースを作ると「全スポット」の表示が消えるので、同じ内容のコースも残しておく
      t.routes.push({ id: 'R0', name: '全スポット', spots: t.spots.map((s) => s.id) });
    }
    let n = t.routes.length + 1;
    while (t.routes.some((r) => r.id === 'R' + n)) n++;
    const r = { id: 'R' + n, name: name.trim(), spots: customDraft.slice() };
    t.routes.push(r);
    state.customRoute = customDraft.slice();
    await kvSet('customRoute', state.customRoute);
    await saveTour();
    await setDirty(true);
    await setRoute(r.id, true);
    $('#dlgCustom').close();
    toast(`コース「${r.name}」として保存しました。他のiPadへは「書き出す」で渡してください`, 4500);
  }

  function openSpotEditor(id) {
    const isNew = id === null;
    let s;
    if (isNew) {
      const maxNo = state.tour.spots.reduce((m, x) => Math.max(m, x.no), 0);
      let n = state.tour.spots.length + 1;
      let newId = 'S' + String(n).padStart(2, '0');
      while (findSpot(newId)) { n++; newId = 'S' + String(n).padStart(2, '0'); }
      s = { id: newId, no: maxNo + 1, name: '', nameEn: '', text: '', textEn: '', lat: null, lng: null, x: null, y: null, image: '' };
    } else {
      s = findSpot(id);
      if (!s) return;
    }
    editingId = isNew ? null : s.id;
    editingPhoto = s.image || '';
    $('#spotDlgTitle').textContent = isNew ? 'スポットを追加' : 'スポットを編集';
    $('#fNo').value = s.no;
    $('#fId').value = s.id;
    $('#fName').value = s.name;
    $('#fText').value = s.text;
    $('#fNameEn').value = s.nameEn;
    $('#fTextEn').value = s.textEn;
    $('#fLat').value = s.lat !== null ? String(s.lat) : '';
    $('#fLng').value = s.lng !== null ? String(s.lng) : '';
    $('#fXY').textContent = state.tour.map
      ? (s.x !== null ? `地図上の位置：x ${Math.round(s.x)}, y ${Math.round(s.y)}` : '地図上の位置：未設定')
      : '構内図が無いため、緯度経度から自動配置します';
    $('#btnPlaceOnMap').classList.toggle('hidden', !state.tour.map);
    $('#captureStatus').textContent = '';
    $('#qrHint').textContent = `QRコードを使う場合は、中身を「TOUR:${s.id}」にして作成・掲示してください。`;
    $('#btnSpotDelete').classList.toggle('hidden', isNew);
    updatePhotoPreview();
    $('#dlgSpot').dataset.newId = isNew ? s.id : '';
    $('#dlgSpot').showModal();
  }

  function updatePhotoPreview() {
    $('#photoPreview').style.backgroundImage = editingPhoto ? `url("${editingPhoto.replace(/"/g, '%22')}")` : '';
  }

  function stopCapture() {
    if (captureWatch !== null) {
      navigator.geolocation.clearWatch(captureWatch.id);
      clearInterval(captureWatch.timer);
      captureWatch = null;
      $('#btnCapture').textContent = '現在地で登録（10秒平均）';
    }
  }

  function startCapture() {
    if (captureWatch !== null) { stopCapture(); return; }
    if (!('geolocation' in navigator)) { toast('位置情報に対応していません'); return; }
    const samples = [];
    let remain = CAPTURE_SECONDS;
    const status = $('#captureStatus');
    const btn = $('#btnCapture');
    btn.textContent = '計測を中止';
    status.textContent = `計測中… 残り ${remain} 秒`;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        samples.push({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.max(p.coords.accuracy, 1) });
        const best = Math.min(...samples.map((x) => x.acc));
        status.textContent = `計測中… 残り ${remain} 秒（${samples.length} 件、最良 ±${Math.round(best)} m）`;
      },
      (err) => {
        status.textContent = err.code === 1 ? '位置情報が許可されていません' : '位置情報を取得できません';
        stopCapture();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    );
    const timer = setInterval(() => {
      remain--;
      if (remain > 0) {
        const best = samples.length ? Math.min(...samples.map((x) => x.acc)) : null;
        status.textContent = `計測中… 残り ${remain} 秒（${samples.length} 件${best !== null ? `、最良 ±${Math.round(best)} m` : ''}）`;
        return;
      }
      stopCapture();
      if (!samples.length) {
        status.textContent = '位置を取得できませんでした。屋外や窓際で再度お試しください';
        return;
      }
      let w = 0, lat = 0, lng = 0;
      samples.forEach((x) => {
        const wi = 1 / (x.acc * x.acc);
        w += wi; lat += x.lat * wi; lng += x.lng * wi;
      });
      lat /= w; lng /= w;
      const best = Math.min(...samples.map((x) => x.acc));
      $('#fLat').value = lat.toFixed(7);
      $('#fLng').value = lng.toFixed(7);
      status.textContent = `登録しました（${samples.length} 件の平均、最良 ±${Math.round(best)} m）。保存を押すと確定します`;
    }, 1000);
    captureWatch = { id, timer };
  }

  function readSpotForm() {
    const lat = num($('#fLat').value.trim());
    const lng = num($('#fLng').value.trim());
    if ((lat === null) !== (lng === null)) throw new Error('緯度と経度は両方入力するか、両方空にしてください');
    if (lat !== null && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) throw new Error('緯度経度の値が範囲外です');
    const name = $('#fName').value.trim();
    if (!name) throw new Error('名前を入力してください');
    return {
      no: num($('#fNo').value) || 1,
      name,
      nameEn: $('#fNameEn').value.trim(),
      text: $('#fText').value.trim(),
      textEn: $('#fTextEn').value.trim(),
      lat,
      lng,
      image: editingPhoto,
    };
  }

  async function saveSpotForm(ev) {
    ev.preventDefault();
    let data;
    try {
      data = readSpotForm();
    } catch (e) {
      toast(e.message, 3500);
      return;
    }
    stopCapture();
    if (editingId) {
      Object.assign(findSpot(editingId), data);
    } else {
      const id = $('#dlgSpot').dataset.newId;
      state.tour.spots.push(Object.assign({ id, x: null, y: null }, data));
      addToActiveRoute(id);
      editingId = id;
    }
    state.tour.spots.sort((a, b) => a.no - b.no);
    await saveTour();
    await setDirty(true);
    rebuildProjector();
    $('#dlgSpot').close();
    renderAll();
    toast('保存しました');
  }

  async function deleteSpot() {
    if (!editingId) return;
    const s = findSpot(editingId);
    if (!confirm(`「${s.name}」を削除しますか？`)) return;
    state.tour.spots = state.tour.spots.filter((x) => x.id !== editingId);
    state.tour.routes.forEach((r) => { r.spots = r.spots.filter((x) => x !== editingId); });
    state.customRoute = state.customRoute.filter((x) => x !== editingId);
    await kvSet('customRoute', state.customRoute);
    state.visited.delete(editingId);
    if (state.selectedId === editingId) state.selectedId = null;
    stopCapture();
    await saveTour();
    await saveVisited();
    await setDirty(true);
    rebuildProjector();
    $('#dlgSpot').close();
    renderAll();
    toast('削除しました');
  }

  function previewSpotText() {
    const text = $('#fText').value.trim();
    if (!text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    const v = pickVoice('ja');
    if (v) u.voice = v;
    u.rate = state.settings.rate;
    speechSynthesis.speak(u);
  }

  async function beginPlaceOnMap() {
    let data;
    try {
      data = readSpotForm();
    } catch (e) {
      toast(e.message, 3500);
      return;
    }
    stopCapture();
    // 入力中の内容を先に保存してから地図で位置を指定する
    if (editingId) {
      Object.assign(findSpot(editingId), data);
    } else {
      const id = $('#dlgSpot').dataset.newId;
      state.tour.spots.push(Object.assign({ id, x: null, y: null }, data));
      addToActiveRoute(id);
      editingId = id;
    }
    state.tour.spots.sort((a, b) => a.no - b.no);
    await saveTour();
    await setDirty(true);
    $('#dlgSpot').close();
    state.placingId = editingId;
    $('#mapHintText').textContent = `「${data.name}」の位置を地図でタップしてください`;
    $('#mapHint').classList.remove('hidden');
    document.querySelector('.map-panel').classList.add('placing');
    renderAll();
  }

  function endPlacing(reopen) {
    const id = state.placingId;
    state.placingId = null;
    $('#mapHint').classList.add('hidden');
    document.querySelector('.map-panel').classList.remove('placing');
    if (reopen && id) openSpotEditor(id);
  }

  async function onMapClick(ev) {
    if (!state.placingId) return;
    const svg = $('#map');
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const p = pt.matrixTransform(ctm.inverse());
    const { W, H } = mapSize();
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) { toast('地図の範囲内をタップしてください'); return; }
    const s = findSpot(state.placingId);
    s.x = Math.round(p.x);
    s.y = Math.round(p.y);
    await saveTour();
    await setDirty(true);
    rebuildProjector();
    renderAll();
    toast('地図上の位置を設定しました');
    endPlacing(true);
  }

  // ツアー設定
  let pendingMap;

  function openTourSettings() {
    $('#dlgMenu').close();
    pendingMap = undefined;
    $('#tTitle').value = state.tour.title;
    $('#tPin').value = '';
    updateMapStatus();
    $('#dlgTour').showModal();
  }

  function updateMapStatus() {
    const m = pendingMap !== undefined ? pendingMap : state.tour.map;
    $('#mapStatus').textContent = m ? `構内図：${m.width} × ${m.height} px${pendingMap !== undefined ? '（保存で確定）' : ''}` : `構内図：なし${pendingMap !== undefined ? '（保存で確定）' : ''}`;
  }

  async function saveTourSettings(ev) {
    ev.preventDefault();
    const title = $('#tTitle').value.trim();
    if (!title) { toast('ツアー名を入力してください'); return; }
    state.tour.title = title;
    if (pendingMap !== undefined) {
      const hadMap = !!state.tour.map;
      state.tour.map = pendingMap;
      if (!pendingMap || hadMap) {
        // 構内図を外した／差し替えた場合、古い地図位置は無効になる
        if (!pendingMap || confirm('構内図を差し替えました。各スポットの地図上の位置をリセットしますか？\n（同じ縮尺・範囲の図面なら「キャンセル」でそのまま使えます）')) {
          state.tour.spots.forEach((s) => { s.x = null; s.y = null; });
        }
      }
    }
    const pin = $('#tPin').value;
    if (pin) await kvSet('pin', pin);
    await saveTour();
    await setDirty(true);
    rebuildProjector();
    $('#dlgTour').close();
    renderAll();
    toast(pin ? '保存しました（PINを変更しました）' : '保存しました');
  }

  // =========================================================
  // QR読み取り
  // =========================================================
  let qrStream = null;
  let qrActive = false;
  let qrLastMsg = 0;
  const qrCanvas = document.createElement('canvas');

  async function openQr() {
    if (typeof jsQR !== 'function') { toast('QR読み取り機能を読み込めませんでした'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('この環境ではカメラを使えません'); return; }
    const dlg = $('#dlgQr');
    $('#qrStatus').textContent = 'カメラを起動しています…';
    dlg.showModal();
    try {
      qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const video = $('#qrVideo');
      video.srcObject = qrStream;
      await video.play();
      qrActive = true;
      $('#qrStatus').textContent = 'スポットのQRコードを枠に合わせてください';
      scanLoop();
    } catch (e) {
      $('#qrStatus').textContent = 'カメラを起動できませんでした。設定でカメラの使用を許可してください。';
    }
  }

  function closeQr() {
    qrActive = false;
    if (qrStream) {
      qrStream.getTracks().forEach((t) => t.stop());
      qrStream = null;
    }
    $('#qrVideo').srcObject = null;
    if ($('#dlgQr').open) $('#dlgQr').close();
  }

  function scanLoop() {
    if (!qrActive) return;
    const video = $('#qrVideo');
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      qrCanvas.width = w;
      qrCanvas.height = h;
      const ctx = qrCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data && handleQr(code.data)) return;
    }
    setTimeout(scanLoop, 150);
  }

  function handleQr(raw) {
    const text = String(raw).trim();
    let key = text;
    const m1 = text.match(/^TOUR:(.+)$/i);
    const m2 = text.match(/[#?&]spot=([^&#]+)/i);
    if (m1) key = m1[1].trim();
    else if (m2) key = decodeURIComponent(m2[1]);
    const s = state.tour.spots.find((x) => x.id === key) || state.tour.spots.find((x) => String(x.no) === key);
    if (!s || !inRoute(s.id)) {
      const now = Date.now();
      if (now - qrLastMsg > 2000) {
        qrLastMsg = now;
        $('#qrStatus').textContent = s
          ? `「${spotName(s)}」は、いまのコースに含まれていません`
          : `このQRコードは台本に登録されていません（${text.slice(0, 40)}）`;
      }
      return false;
    }
    closeQr();
    selectSpot(s.id);
    toast(`No.${dispNo(s)}「${spotName(s)}」を選びました。再生ボタンを押してください`);
    return true;
  }

  // =========================================================
  // 画面切り替え
  // =========================================================
  function showWelcome() {
    const has = !!state.tour;
    $('#welcome').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#welcomeNoData').classList.toggle('hidden', has);
    $('#welcomeHasData').classList.toggle('hidden', !has);
    const choices = has ? routeChoices() : [];
    $('#welcomeRouteBox').classList.toggle('hidden', choices.length < 2);
    if (choices.length >= 2) {
      const cur = activeRoute().id;
      $('#selWelcomeRoute').innerHTML = choices.map((r) =>
        `<option value="${esc(r.id)}"${r.id === cur ? ' selected' : ''}>${esc(r.name)}（${r.n} か所）</option>`
      ).join('');
    }
    $('#welcomeTitle').textContent = has ? state.tour.title : '見学ガイド';
    $('#welcomeText').textContent = has
      ? `${state.tour.spots.length} スポットの台本が入っています。`
      : '台本ファイル（JSON）を読み込むか、サンプルで動作を試してください。';
  }

  function startTour() {
    unlockSpeech();
    state.started = true;
    $('#welcome').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderAll();
    startGps();
    requestWakeLock();
  }

  // =========================================================
  // イベント
  // =========================================================
  function bindEvents() {
    $('#btnQr').innerHTML = `${ICONS.qr}<span>QR</span>`;
    $('#btnMenu').innerHTML = `${ICONS.menu}<span>メニュー</span>`;
    $('#btnPrev').innerHTML = `${ICONS.prev}<span>前へ</span>`;
    $('#btnNext').innerHTML = `${ICONS.next}<span>次へ</span>`;
    $('#btnStop').innerHTML = `${ICONS.stop}<span>終了</span>`;

    // 起動画面
    $('#btnWelcomeImport').addEventListener('click', () => $('#fileImport').click());
    $('#btnWelcomeImport2').addEventListener('click', () => $('#fileImport').click());
    $('#btnWelcomeSample').addEventListener('click', loadSample);
    $('#btnStart').addEventListener('click', startTour);
    $('#fileImport').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if ($('#dlgMenu').open) $('#dlgMenu').close();
      await handleImportFile(f);
    });

    // ヘッダー
    $('#btnQr').addEventListener('click', openQr);
    $('#btnQrClose').addEventListener('click', closeQr);
    $('#dlgQr').addEventListener('cancel', (ev) => { ev.preventDefault(); closeQr(); });
    $('#btnLang').addEventListener('click', () => {
      if (state.lang === 'ja' && !tourHasEnglish()) { toast('英語の説明文が登録されていません'); return; }
      state.lang = state.lang === 'ja' ? 'en' : 'ja';
      renderAll();
    });
    $('#btnMenu').addEventListener('click', () => { loadVoices(); renderHeader(); $('#dlgMenu').showModal(); });
    $('#btnAuto').addEventListener('click', clearSelection);

    // 一覧
    $('#spotList').addEventListener('click', (ev) => {
      const editBtn = ev.target.closest('[data-edit]');
      if (editBtn) { openSpotEditor(editBtn.dataset.edit); return; }
      const li = ev.target.closest('.spot-item');
      if (li) selectSpot(li.dataset.id);
    });
    $('#btnAddSpot').addEventListener('click', () => openSpotEditor(null));

    // コース
    $('#btnRoute').addEventListener('click', openRoutePick);
    $('#btnRoutePickClose').addEventListener('click', () => $('#dlgRoutePick').close());
    $('#btnCustomOpen').addEventListener('click', openCustom);
    $('#btnCustomClose').addEventListener('click', () => $('#dlgCustom').close());
    $('#btnCustomFromCur').addEventListener('click', () => { customDraft = activeRoute().spots.slice(); renderCustom(); });
    $('#btnCustomClear').addEventListener('click', () => { customDraft = []; renderCustom(); });
    $('#customList').addEventListener('click', customListClick);
    $('#btnCustomStart').addEventListener('click', startCustom);
    $('#btnCustomSave').addEventListener('click', saveCustomAsRoute);
    $('#routePickList').addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-route]');
      if (!b) return;
      await setRoute(b.dataset.route, $('#chkResetVisited').checked);
      $('#dlgRoutePick').close();
      toast(`コース「${activeRoute().name}」に切り替えました`);
    });
    $('#selWelcomeRoute').addEventListener('change', (ev) => setRoute(ev.target.value, true));
    $('#btnRouteEdit').addEventListener('click', () => { $('#dlgMenu').close(); openRouteEdit(); });
    $('#btnRouteEditClose').addEventListener('click', () => $('#dlgRouteEdit').close());
    $('#dlgRouteEdit').addEventListener('click', routeEditClick);
    $('#btnRouteNew').addEventListener('click', newRoute);
    $('#btnRouteDel').addEventListener('click', deleteRoute);
    $('#rName').addEventListener('change', async (ev) => {
      const r = explicitRoute();
      if (!r) return;
      const v = ev.target.value.trim();
      if (!v) { ev.target.value = r.name; return; }
      r.name = v;
      await commitRoutes();
    });

    // 地図
    $('#map').addEventListener('click', onMapClick);
    $('#btnCancelPlace').addEventListener('click', () => endPlacing(true));

    // ステージ
    $('#btnPause').addEventListener('click', () => {
      if (!state.speaking) return;
      if (state.speaking.paused) speakCurrent(); else pauseSpeaking();
    });
    $('#btnPrev').addEventListener('click', () => {
      const sp = state.speaking;
      if (!sp) return;
      sp.index = Math.max(0, sp.index - 1);
      speakCurrent();
    });
    $('#btnNext').addEventListener('click', () => {
      const sp = state.speaking;
      if (!sp) return;
      sp.index++;
      speakCurrent();
    });
    $('#btnStop').addEventListener('click', stopSpeaking);
    $('#btnDoneClose').addEventListener('click', stopSpeaking);
    $('#btnReplay').addEventListener('click', () => {
      const sp = state.speaking;
      if (!sp) return;
      sp.done = false;
      sp.index = 0;
      speakCurrent();
    });
    $('#stageBody').addEventListener('click', (ev) => {
      const n = ev.target.closest('.sentence');
      const sp = state.speaking;
      if (!n || !sp) return;
      sp.done = false;
      sp.index = Number(n.dataset.i);
      speakCurrent();
    });

    // メニュー
    $('#btnImport').addEventListener('click', () => $('#fileImport').click());
    $('#btnExport').addEventListener('click', () => { $('#dlgMenu').close(); openExport(); });
    $('#btnLoadSample').addEventListener('click', async () => {
      if (!confirm('サンプルで現在の台本を置き換えます。よろしいですか？')) return;
      $('#dlgMenu').close();
      await loadSample();
    });
    $('#btnEditToggle').addEventListener('click', toggleEditMode);
    $('#btnTourSettings').addEventListener('click', openTourSettings);
    $('#inpRate').addEventListener('input', (ev) => {
      state.settings.rate = Number(ev.target.value);
      $('#rateLabel').textContent = state.settings.rate.toFixed(2);
      saveSettings();
    });
    $('#selVoiceJa').addEventListener('change', (ev) => { state.settings.voiceJa = ev.target.value; saveSettings(); });
    $('#selVoiceEn').addEventListener('change', (ev) => { state.settings.voiceEn = ev.target.value; saveSettings(); });
    $('#btnVoiceTest').addEventListener('click', () => {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      const en = state.lang === 'en';
      const u = new SpeechSynthesisUtterance(en ? 'Welcome to our factory tour.' : 'ようこそ。本日は工場見学にお越しいただき、ありがとうございます。');
      u.lang = en ? 'en-US' : 'ja-JP';
      const v = pickVoice(en ? 'en' : 'ja');
      if (v) u.voice = v;
      u.rate = state.settings.rate;
      speechSynthesis.speak(u);
    });
    $('#selAcc').addEventListener('change', (ev) => {
      state.settings.accLimit = Number(ev.target.value);
      saveSettings();
      renderAll();
    });
    $('#btnResetVisited').addEventListener('click', async () => {
      if (!confirm('見学済みの記録をリセットしますか？')) return;
      state.visited = new Set();
      await saveVisited();
      $('#dlgMenu').close();
      renderAll();
    });

    // スポット編集
    $('#formSpot').addEventListener('submit', saveSpotForm);
    $('#btnSpotCancel').addEventListener('click', () => { stopCapture(); $('#dlgSpot').close(); });
    $('#dlgSpot').addEventListener('cancel', () => stopCapture());
    $('#btnSpotDelete').addEventListener('click', deleteSpot);
    $('#btnSpotPreview').addEventListener('click', previewSpotText);
    $('#btnCapture').addEventListener('click', startCapture);
    $('#btnPlaceOnMap').addEventListener('click', beginPlaceOnMap);
    $('#btnPhoto').addEventListener('click', () => $('#filePhoto').click());
    $('#btnPhotoClear').addEventListener('click', () => { editingPhoto = ''; updatePhotoPreview(); });
    $('#filePhoto').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      try {
        const r = await downscaleImage(f, 1600, 0.82);
        editingPhoto = r.dataUrl;
        updatePhotoPreview();
      } catch (e) {
        toast(e.message, 3500);
      }
    });

    // ツアー設定
    $('#formTour').addEventListener('submit', saveTourSettings);
    $('#btnTourCancel').addEventListener('click', () => $('#dlgTour').close());
    $('#btnMapPick').addEventListener('click', () => $('#fileMap').click());
    $('#btnMapClear').addEventListener('click', () => { pendingMap = null; updateMapStatus(); });
    $('#fileMap').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      try {
        const r = await downscaleImage(f, 2400, 0.85);
        pendingMap = { image: r.dataUrl, width: r.width, height: r.height };
        updateMapStatus();
      } catch (e) {
        toast(e.message, 3500);
      }
    });

    // 書き出し
    $('#formExport').addEventListener('submit', makeExportFile);
    $('#btnExportCancel').addEventListener('click', () => $('#dlgExport').close());
    $('#btnShare').addEventListener('click', shareExport);
    $('#lnkDownload').addEventListener('click', () => { setTimeout(() => setDirty(false), 500); });

    // 復帰時
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.started) requestWakeLock();
    });

    if ('speechSynthesis' in window) {
      speechSynthesis.addEventListener('voiceschanged', loadVoices);
    }
  }

  // =========================================================
  // 起動
  // =========================================================
  async function init() {
    bindEvents();
    try {
      const [tour, visited, settings, dirty, routeId, customRoute] = await Promise.all([kvGet('tour'), kvGet('visited'), kvGet('settings'), kvGet('dirty'), kvGet('routeId'), kvGet('customRoute')]);
      if (settings) Object.assign(state.settings, settings);
      state.routeId = typeof routeId === 'string' ? routeId : null;
      state.customRoute = Array.isArray(customRoute) ? customRoute.map(String) : [];
      if (Array.isArray(visited)) state.visited = new Set(visited);
      state.dirty = !!dirty;
      if (tour) {
        state.tour = normalizeTour(tour);
        await ensureMapSize();
        rebuildProjector();
      }
    } catch (e) {
      toast('端末内のデータを読み込めませんでした', 4000);
    }
    $('#inpRate').value = String(state.settings.rate);
    $('#rateLabel').textContent = Number(state.settings.rate).toFixed(2);
    $('#selAcc').value = String(state.settings.accLimit);
    loadVoices();
    showWelcome();

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
