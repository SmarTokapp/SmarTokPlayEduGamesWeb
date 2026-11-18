// app.js — SmarTokPlay: EduGames web app.
// Loads the live games.json catalog (same manifest the Android app uses),
// renders a responsive 2:3 card grid, localStorage favorites, category
// drawer navigation, live search, and a full-viewport iframe player.

'use strict';

/* ═══ State ═══ */
const GAMES_MANIFEST_URL = 'https://games.smartok.app/games.json';
const FAV_KEY = 'edugames-favorites';
const LANG_KEY = 'edugames-lang';
const SUPPORTED_LANGS = Object.keys(UI_DICT);

let games = [];            // full catalog
let favorites = loadFavorites();
let currentView = 'all';   // 'all' | 'favorites' | 'category:<name>'
let currentLang = detectLang();
let activeGame = null;     // game open in the player overlay

/* ═══ Language ═══ */
function detectLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED_LANGS.includes(nav) ? nav : 'en';
}

function tr(key) {
  return (UI_DICT[currentLang] && UI_DICT[currentLang][key]) || UI_DICT.en[key] || key;
}

function applyI18n() {
  const rtl = currentLang === 'ar';
  document.documentElement.lang = currentLang;
  document.documentElement.dir = rtl ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = tr(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', tr(el.dataset.i18nAria)); });
  syncPlayerFavButton();
}

function buildLangSelect() {
  const sel = document.getElementById('lang-select');
  sel.innerHTML = '';
  SUPPORTED_LANGS.forEach(code => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = LANG_NAMES[code] || code;
    sel.appendChild(opt);
  });
  sel.value = currentLang;
  sel.addEventListener('change', () => {
    currentLang = sel.value;
    localStorage.setItem(LANG_KEY, currentLang);
    applyI18n();
  });
}

/* ═══ Favorites (localStorage) ═══ */
function loadFavorites() {
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch { /* quota — non-fatal */ }
}

function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  saveFavorites();
  // Refresh star states in the grid and the player bar.
  document.querySelectorAll(`.card-star[data-game-id="${CSS.escape(id)}"]`).forEach(btn => syncStar(btn, id));
  syncPlayerFavButton();
  if (currentView === 'favorites') renderGrid();
}

function syncStar(btn, id) {
  const fav = favorites.has(id);
  btn.textContent = fav ? '★' : '☆';
  btn.classList.toggle('fav', fav);
  btn.setAttribute('aria-label', tr(fav ? 'remove_fav' : 'add_fav'));
}

function syncPlayerFavButton() {
  if (!activeGame) return;
  const btn = document.getElementById('player-fav');
  const fav = favorites.has(activeGame.id);
  btn.textContent = fav ? '★' : '☆';
  btn.classList.toggle('fav', fav);
  btn.setAttribute('aria-label', tr(fav ? 'remove_fav' : 'add_fav'));
}

/* ═══ Catalog ═══ */
async function loadCatalog() {
  try {
    const res = await fetch(`${GAMES_MANIFEST_URL}?t=${Date.now()}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      games = data.filter(g => g && g.id && g.title && g.url);
      return;
    }
  } catch (e) {
    console.warn('Live manifest unreachable, using bundled copy:', e);
  }
  // Bundled fallback — an up-to-date copy of the same manifest.
  const res = await fetch(`games.json?t=${Date.now()}`);
  games = (await res.json()).filter(g => g && g.id && g.title && g.url);
}

/* ═══ Rendering ═══ */
function visibleGames() {
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  let list = games;
  if (currentView === 'favorites') list = list.filter(g => favorites.has(g.id));
  else if (currentView.startsWith('category:')) list = list.filter(g => g.category === currentView.slice(9));
  if (!q) return list;
  return list.filter(g =>
    g.title.toLowerCase().includes(q) ||
    (g.id || '').toLowerCase().includes(q) ||
    (g.category || '').toLowerCase().includes(q)
  );
}

function renderGrid() {
  const grid = document.getElementById('games-grid');
  const empty = document.getElementById('empty-state');
  grid.innerHTML = '';
  const list = visibleGames();

  if (list.length === 0) {
    empty.style.display = 'block';
    const icon = empty.querySelector('.empty-icon');
    const title = empty.querySelector('.empty-title');
    const sub = empty.querySelector('.empty-sub');
    if (currentView === 'favorites' && !document.getElementById('search-input').value.trim()) {
      icon.textContent = '☆';
      title.textContent = tr('fav_empty_title');
      sub.textContent = tr('fav_empty_sub');
    } else {
      icon.textContent = '🔍';
      title.textContent = tr('no_results');
      sub.textContent = '';
    }
    return;
  }
  empty.style.display = 'none';

  const frag = document.createDocumentFragment();
  list.forEach(game => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `
      <div class="card-cover">
        <img src="${game.icon}" alt="${escapeHtml(game.title)}" loading="lazy" onerror="this.style.opacity='0.3'">
      </div>
      <button class="card-star" data-game-id="${escapeHtml(game.id)}">☆</button>
      <div class="card-info">
        <div class="card-title">${escapeHtml(game.title)}</div>
        <div class="card-cat">${escapeHtml(game.category || '')}</div>
      </div>`;
    const star = card.querySelector('.card-star');
    syncStar(star, game.id);
    star.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(game.id); });
    card.addEventListener('click', () => openPlayer(game));
    frag.appendChild(card);
  });
  grid.appendChild(frag);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ═══ Drawer + categories ═══ */
function buildCategories() {
  const box = document.getElementById('drawer-categories');
  box.innerHTML = '';
  [...new Set(games.map(g => g.category).filter(Boolean))].sort().forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'drawer-item';
    btn.dataset.view = `category:${cat}`;
    btn.innerHTML = `▸ <span>${escapeHtml(cat)}</span>`;
    btn.addEventListener('click', () => setView(`category:${cat}`, btn));
    box.appendChild(btn);
  });
}

function setView(view, el) {
  currentView = view;
  document.querySelectorAll('.drawer-item').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderGrid();
  closeDrawer();
  window.scrollTo({ top: 0 });
}

function openDrawer() {
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}

/* ═══ Player overlay ═══ */
function openPlayer(game) {
  activeGame = game;
  const overlay = document.getElementById('player-overlay');
  document.getElementById('player-title').textContent = game.title;
  // Games serve English UI — pass lang=en so the hosted build never
  // guesses the browser locale differently.
  const url = new URL(game.url);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('v', Date.now().toString());
  document.getElementById('player-frame').src = url.toString();
  syncPlayerFavButton();
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closePlayer() {
  const overlay = document.getElementById('player-overlay');
  document.getElementById('player-frame').src = 'about:blank';
  overlay.style.display = 'none';
  document.body.style.overflow = '';
  activeGame = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function toggleFullscreen() {
  const overlay = document.getElementById('player-overlay');
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (overlay.requestFullscreen) {
    overlay.requestFullscreen().catch(() => {});
  } else if (overlay.webkitRequestFullscreen) {
    overlay.webkitRequestFullscreen();
  }
}

/* ═══ Wiring ═══ */
function init() {
  buildLangSelect();
  applyI18n();

  document.getElementById('menu-btn').addEventListener('click', openDrawer);
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
  document.getElementById('nav-all').addEventListener('click', e => setView('all', e.currentTarget));
  document.getElementById('nav-favorites').addEventListener('click', e => setView('favorites', e.currentTarget));
  document.getElementById('brand-home').addEventListener('click', () => setView('all', document.getElementById('nav-all')));

  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  input.addEventListener('input', () => {
    clearBtn.style.display = input.value ? 'block' : 'none';
    renderGrid();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    renderGrid();
  });

  document.getElementById('player-back').addEventListener('click', closePlayer);
  document.getElementById('player-fs').addEventListener('click', toggleFullscreen);
  document.getElementById('player-fav').addEventListener('click', () => { if (activeGame) toggleFavorite(activeGame.id); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && activeGame) closePlayer(); });

  loadCatalog().then(() => {
    buildCategories();
    renderGrid();
  }).catch(err => {
    console.error('Catalog load failed:', err);
    document.getElementById('loading').textContent = 'Failed to load games.';
  });
}

document.addEventListener('DOMContentLoaded', init);
