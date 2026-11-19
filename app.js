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
let activeTab = 'all';     // bottom bar: 'all' | 'popular' | 'recent'
let currentLang = detectLang();
let activeGame = null;     // game open in the player overlay

/* ═══ Auth / session state (same contract as the Android app) ═══ */
const API_BASE = 'https://smartok-backend.onrender.com';
const TOKEN_KEY = 'userToken';
const USER_KEY = 'userData';
let user = null;                  // signed-in SmarTok user, or null (guest)
let serverFavorites = new Set();  // favorites stored on the account

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
  updateAuthUI();
  renderProfileCard();
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

/* ─── Session helpers (mirrors SmarTokPlayEduGames/src/api.ts) ─── */
/* ═══ Recently played / local play stats ═══ */
const RECENT_KEY = 'edugames-recent';
const COUNTS_KEY = 'edugames-play-counts';
const RECENT_LIMIT = 30;
let recentIds = loadRecentIds();
let playCounts = loadPlayCounts();

function loadRecentIds() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

function loadPlayCounts() {
  try {
    const obj = JSON.parse(localStorage.getItem(COUNTS_KEY) || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

// Records a game open: id moves to the front of the recent list (deduped,
// capped at 30) and its play counter increments. Best-effort writes.
function recordGamePlay(id) {
  recentIds = [id, ...recentIds.filter(x => x !== id)].slice(0, RECENT_LIMIT);
  playCounts[id] = (playCounts[id] || 0) + 1;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds));
    localStorage.setItem(COUNTS_KEY, JSON.stringify(playCounts));
  } catch { /* quota — stats are non-critical */ }
}

function getToken() { return localStorage.getItem(TOKEN_KEY); }

function saveSession(token, userData) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(userData));
  } catch { /* quota — non-fatal */ }
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function getCachedUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}

// fetch() with the Bearer token attached — same header the native app sends.
function authFetch(endpoint, options = {}) {
  const token = getToken();
  return fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
}

/* ─── Cloud favorites sync ─── */
// Pulls the account's favorite list from the backend; null when logged out.
async function fetchServerFavorites() {
  try {
    const res = await authFetch('/api/games/favorites');
    const data = await res.json().catch(() => ({}));
    if (!data.success) return new Set();
    return new Set((data.favorites || []).map(f => String(f.game_id)));
  } catch {
    return null; // offline — caller keeps the local set
  }
}

// After login: merge device-local stars into the account set, then adopt
// the union so nothing the guest starred is lost.
async function mergeFavoritesOnLogin() {
  const remote = await fetchServerFavorites();
  if (remote === null) return; // offline — retry on next launch
  serverFavorites = remote;
  const missing = [...favorites].filter(id => !remote.has(id));
  favorites = new Set([...favorites, ...remote]);
  serverFavorites = new Set(favorites);
  saveFavorites(); // keep the device cache in sync too
  // Push any guest-only stars up to the account.
  for (const id of missing) {
    try {
      await authFetch('/api/games/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: id }),
      });
    } catch { /* offline — next login retries */ }
  }
}

async function toggleFavorite(id) {
  const wasFav = favorites.has(id);
  if (wasFav) favorites.delete(id); else favorites.add(id);
  saveFavorites();
  // Refresh star states in the grid and the player bar.
  document.querySelectorAll(`.card-star[data-game-id="${CSS.escape(id)}"]`).forEach(btn => syncStar(btn, id));
  syncPlayerFavButton();
  if (currentView === 'favorites') renderGrid();

  // Signed-in users persist the toggle to their SmarTok account;
  // a failed call rolls the optimistic update back.
  if (user && getToken()) {
    try {
      const res = await authFetch('/api/games/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) throw new Error('toggle failed');
      if (data.favorited) serverFavorites.add(id); else serverFavorites.delete(id);
    } catch {
      if (wasFav) favorites.add(id); else favorites.delete(id);
      saveFavorites();
      document.querySelectorAll(`.card-star[data-game-id="${CSS.escape(id)}"]`).forEach(btn => syncStar(btn, id));
      syncPlayerFavButton();
      if (currentView === 'favorites') renderGrid();
      toast(tr('auth.errNetwork'));
    }
  }
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
    const res = await fetch(`${GAMES_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      games = shuffleArray(data.filter(g => g && g.id && g.title && g.url));
      return;
    }
  } catch (e) {
    console.warn('Live manifest unreachable, using bundled copy:', e);
  }
  // Bundled fallback — an up-to-date copy of the same manifest.
  const res = await fetch(`games.json?t=${Date.now()}`, { cache: 'no-store' });
  games = shuffleArray((await res.json()).filter(g => g && g.id && g.title && g.url));
}

/* ═══ Rendering ═══ */
// Unbiased Fisher-Yates shuffle — copies the input so the catalog array
// is replaced, not mutated in place.
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Re-shuffle the catalog and redraw. Only invoked by the resume/Home
// triggers — never by search input, category clicks, or star toggles —
// so the shuffled order stays stable while the user browses.
function reshuffleGames() {
  if (!games.length) return;
  games = shuffleArray(games);
  renderGrid();
}

function visibleGames() {
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  let list;
  // Bottom tab picks the source list first.
  if (activeTab === 'recent') {
    const byId = new Map(games.map(g => [g.id, g]));
    list = recentIds.map(id => byId.get(id)).filter(Boolean);
  } else if (activeTab === 'popular') {
    // Deterministic ranking: local play counts dominate, manifest order
    // breaks ties — flagship titles always rank cleanly, never shuffled.
    const order = new Map(games.map((g, i) => [g.id, i]));
    list = [...games].sort((a, b) =>
      (playCounts[b.id] || 0) - (playCounts[a.id] || 0) ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } else {
    list = games;
  }
  // Drawer view (favorites / category) then search narrow it further.
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
    if (activeTab === 'recent' && !document.getElementById('search-input').value.trim()) {
      icon.textContent = '🕒';
      title.textContent = tr('tab_recent_empty');
      sub.textContent = '';
    } else if (currentView === 'favorites' && !document.getElementById('search-input').value.trim()) {
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

// Bottom tab bar: All re-tap reshuffles; Popular/Recent swap the source
// list but keep the active drawer view + search filter intact.
function setTab(tab, btn) {
  if (tab === 'all' && activeTab === 'all') {
    if (games.length) games = shuffleArray(games);
    renderGrid();
    window.scrollTo({ top: 0 });
    return;
  }
  activeTab = tab;
  document.querySelectorAll('.btab').forEach(b => b.classList.toggle('active', b === btn));
  renderGrid();
  window.scrollTo({ top: 0 });
}

function setView(view, el) {
  // Returning to Home/All Games always deals a fresh random order and
  // drops the bottom bar back to All.
  if (view === 'all') {
    activeTab = 'all';
    document.querySelectorAll('.btab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'all'));
    if (games.length) games = shuffleArray(games);
  }
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
  recordGamePlay(game.id);
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
  // Returning to the catalog from the player deals a fresh order.
  reshuffleGames();
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

/* ═══ Profile card, auth, legal & modals ═══ */

// In-app legal documents — same content the Android app's LegalScreen shows.
const LEGAL_CONTENT = {
  privacy: {
    titleKey: 'drawer.privacyPolicy',
    sections: [
      ['1. Information We Collect', 'SmarTok Play: EduGames collects your account information (name, email) when you register with a SmarTok account, plus your list of favorite games. Gameplay inside the in-app browser is hosted on games.smartok.app and does not collect personal data.'],
      ['2. How We Use Information', 'Your data is used only to authenticate your session, keep your favorites synchronized across devices, and operate the service. We do not sell personal information to third parties.'],
      ['3. Data Sharing', 'We do not share your personal data with third parties except the infrastructure providers needed to run the service (hosting, authentication). Legal requests are honored where required by law.'],
      ['4. Data Retention & Deletion', 'You may delete your account at any time from the drawer menu ("Delete Account"). Deletion permanently removes your account, favorites, and personal data from our servers and cannot be undone.'],
      ['5. Children', 'The games in this app are educational. Accounts require a verified email address. Parents may contact us to request deletion of a child\'s account data.'],
      ['6. Contact', 'For privacy questions, contact the SmarTok team through the official support channels listed on smartok.app.'],
    ],
  },
  terms: {
    titleKey: 'drawer.terms',
    sections: [
      ['1. Acceptance of Terms', 'By using SmarTok Play: EduGames you agree to these Terms of Service. If you do not agree, do not use the app.'],
      ['2. Accounts', 'You are responsible for keeping your login credentials confidential and for all activity under your account. Accounts created in the main SmarTok app can be used here directly.'],
      ['3. Acceptable Use', 'You agree not to misuse the service: no reverse-engineering, no scraping, no unlawful activity, and no interference with the operation of the platform.'],
      ['4. Content', 'The HTML5 games are provided "as is" for educational entertainment. All game content belongs to its respective owners within the SmarTok ecosystem.'],
      ['5. Termination', 'We may suspend or terminate accounts that violate these terms. You may end these terms at any time by deleting your account from the drawer menu.'],
      ['6. Limitation of Liability', 'To the maximum extent permitted by law, SmarTok is not liable for indirect, incidental, or consequential damages arising from the use of this app.'],
    ],
  },
};

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// Renders the pinned bottom profile card for guest vs signed-in states.
function renderProfileCard() {
  const card = document.getElementById('profile-card');
  if (user) {
    const avatar = user.avatar_url ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || 'U')}&background=ff4c68&color=fff&size=128`;
    card.innerHTML = `
      <img class="profile-avatar" src="${escapeHtml(avatar)}" alt="" onerror="this.style.display='none'">
      <div class="profile-text">
        <div class="profile-name">${escapeHtml(user.name || '')}</div>
        <div class="profile-sub">${escapeHtml(tr('drawer.signedInAs').replace('{name}', user.email || ''))}</div>
      </div>`;
  } else {
    card.innerHTML = `
      <div class="profile-guest-avatar">👤</div>
      <div class="profile-text">
        <div class="profile-name">${escapeHtml(tr('profile.guest'))}</div>
        <div class="profile-sub">${escapeHtml(tr('profile.syncSub'))}</div>
      </div>
      <button class="profile-signin" id="profile-signin-btn">${escapeHtml(tr('auth.signInSmarTok'))}</button>`;
    document.getElementById('profile-signin-btn').addEventListener('click', () => { closeDrawer(); openAuthModal(); });
  }
}

// Syncs drawer auth item + delete-account visibility with the session.
function updateAuthUI() {
  const loggedIn = !!user;
  document.getElementById('nav-auth-label').textContent = tr(loggedIn ? 'drawer.signOut' : 'drawer.logIn');
  document.getElementById('nav-auth-icon').textContent = loggedIn ? '←' : '→';
  document.getElementById('nav-delete').style.display = loggedIn ? 'flex' : 'none';
}

/* ─── Auth modal: sign in / create account / email verification ─── */
// Mirrors the Android app's three modes: login | signup | verify (OTP).
let authMode = 'login';
let pendingEmail = ''; // email awaiting OTP verification
// Same password policy as the Android AuthScreen.
const PASSWORD_REGEX = /^(?![!?])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{7,40}$/;

async function authPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

function showAuthError(text) {
  const el = document.getElementById('auth-error');
  document.getElementById('auth-info').style.display = 'none';
  el.textContent = text;
  el.style.display = 'block';
}
function showAuthInfo(key) {
  const el = document.getElementById('auth-info');
  document.getElementById('auth-error').style.display = 'none';
  el.textContent = tr(key);
  el.style.display = 'block';
}

// Switches the modal between login / signup / verify and updates every
// label, placeholder and section — always with a clean error/info state.
function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth-info').style.display = 'none';
  document.getElementById('auth-tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('auth-tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-tabs').style.display = mode === 'verify' ? 'none' : 'flex';
  document.getElementById('auth-fields').style.display = mode === 'verify' ? 'none' : 'block';
  document.getElementById('auth-verify').style.display = mode === 'verify' ? 'block' : 'none';

  const tKey = mode === 'verify' ? 'auth.verifyTitle' : mode === 'signup' ? 'auth.joinUs' : 'auth.welcome';
  const sKey = mode === 'verify' ? 'auth.infoOtpSent' : mode === 'signup' ? 'auth.signupSub' : 'auth.loginSub';
  const title = document.getElementById('auth-title');
  const sub = document.getElementById('auth-sub');
  title.dataset.i18n = tKey; title.textContent = tr(tKey);
  sub.dataset.i18n = sKey; sub.textContent = tr(sKey);

  document.getElementById('auth-name').style.display = mode === 'signup' ? 'block' : 'none';
  const pw = document.getElementById('auth-password');
  pw.dataset.i18nPh = mode === 'signup' ? 'auth.passwordHint' : 'auth.password';
  pw.placeholder = tr(pw.dataset.i18nPh);
  pw.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  const submit = document.getElementById('auth-submit');
  submit.dataset.i18n = mode === 'signup' ? 'auth.signUp' : 'auth.login';
  submit.textContent = tr(submit.dataset.i18n);
}

// Fresh state every open — same entry point used by drawer + profile card.
function openAuthModal() {
  setAuthMode('login');
  ['auth-name', 'auth-email', 'auth-password', 'auth-otp'].forEach(id => {
    document.getElementById(id).value = '';
  });
  openModal('auth-modal');
}

async function onAuthSuccess(data) {
  saveSession(data.token, data.user);
  user = data.user;
  closeModal('auth-modal');
  updateAuthUI();
  renderProfileCard();
  toast(tr('drawer.signedInAs').replace('{name}', user.email || user.name || ''));
  await mergeFavoritesOnLogin();
  renderGrid();
}

async function submitAuth() {
  const email = document.getElementById('auth-email').value.trim().toLowerCase();
  const password = document.getElementById('auth-password').value;
  const btn = document.getElementById('auth-submit');
  showAuthError('');
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth-info').style.display = 'none';

  if (authMode === 'signup') {
    const name = document.getElementById('auth-name').value.trim();
    if (!name || !email || !password) return showAuthError(tr('auth.errAllFields'));
    if (!PASSWORD_REGEX.test(password)) return showAuthError(tr('auth.errPassword'));
  } else if (!email || !password) {
    return showAuthError(tr('auth.errEmailPassword'));
  }

  btn.disabled = true;
  btn.textContent = tr('common.loading');
  try {
    if (authMode === 'login') {
      const { ok, data } = await authPost('/api/auth/login', { email, password });
      if (ok && data.token) {
        await onAuthSuccess(data);
      } else if (data.requiresVerification) {
        // Unverified account — the backend already sent a fresh OTP.
        pendingEmail = data.email || email;
        setAuthMode('verify');
        showAuthInfo('auth.infoOtpSent');
      } else {
        showAuthError(data.error || tr('auth.errLogin'));
      }
    } else {
      const name = document.getElementById('auth-name').value.trim();
      const { ok, data } = await authPost('/api/auth/signup', { name, email, password });
      if (ok) {
        // Account created — backend emailed an OTP, move to verify mode.
        pendingEmail = data.email || email;
        setAuthMode('verify');
        showAuthInfo('auth.infoAccountCreated');
      } else {
        showAuthError(data.error || tr('auth.errSignup'));
      }
    }
  } catch {
    showAuthError(tr('auth.errNetwork'));
  }
  btn.disabled = false;
  btn.textContent = tr(authMode === 'signup' ? 'auth.signUp' : 'auth.login');
}

async function handleVerify() {
  const otp = document.getElementById('auth-otp').value.trim();
  const btn = document.getElementById('auth-verify-submit');
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth-info').style.display = 'none';
  if (!otp) return showAuthError(tr('auth.errOtp'));
  btn.disabled = true;
  btn.textContent = tr('common.loading');
  try {
    const { ok, data } = await authPost('/api/auth/verify-email', { email: pendingEmail, otp });
    if (ok && data.success && data.token) {
      await onAuthSuccess(data);
    } else {
      showAuthError(data.error || tr('auth.errInvalidCode'));
    }
  } catch {
    showAuthError(tr('auth.errNetwork'));
  }
  btn.disabled = false;
  btn.textContent = tr('auth.verifySubmit');
}

async function handleResend() {
  document.getElementById('auth-error').style.display = 'none';
  try {
    const { ok } = await authPost('/api/auth/resend-verification', { email: pendingEmail });
    if (ok) showAuthInfo('auth.infoResent');
    else showAuthError(tr('auth.errResend'));
  } catch {
    showAuthError(tr('auth.errNetwork'));
  }
}

/* ─── Log out / delete account ─── */
async function doLogout() {
  clearSession();
  user = null;
  serverFavorites = new Set();
  favorites = loadFavorites(); // back to the device-local guest list
  updateAuthUI();
  renderProfileCard();
  renderGrid();
}

async function confirmDeleteAccount() {
  const btn = document.getElementById('delete-confirm');
  btn.disabled = true;
  try {
    const res = await authFetch('/api/users/account/delete', { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (data.success) {
      closeModal('delete-modal');
      await doLogout();
      toast(tr('drawer.deleted'));
    } else {
      toast(data.message || tr('drawer.deleteFail'));
    }
  } catch {
    toast(tr('drawer.deleteFail'));
  }
  btn.disabled = false;
}

/* ─── Language + legal modals ─── */
function buildLangModal() {
  const list = document.getElementById('lang-list');
  list.innerHTML = '';
  SUPPORTED_LANGS.forEach(code => {
    const btn = document.createElement('button');
    btn.className = 'lang-option' + (code === currentLang ? ' active' : '');
    btn.innerHTML = `<span>${escapeHtml(LANG_NAMES[code] || code)}</span>${code === currentLang ? '<span>✓</span>' : ''}`;
    btn.addEventListener('click', () => {
      currentLang = code;
      localStorage.setItem(LANG_KEY, code);
      document.getElementById('lang-select').value = code;
      applyI18n();
      buildLangModal();
      closeModal('lang-modal');
    });
    list.appendChild(btn);
  });
}

function openLegal(doc) {
  const c = LEGAL_CONTENT[doc] || LEGAL_CONTENT.privacy;
  document.getElementById('legal-title').textContent = tr(c.titleKey);
  document.getElementById('legal-body').innerHTML = c.sections
    .map(([h, b]) => `<h3>${escapeHtml(h)}</h3><p>${escapeHtml(b)}</p>`).join('');
  openModal('legal-modal');
}

/* ═══ Wiring ═══ */
function init() {
  // Expose the sticky header's exact height so .search-sticky pins flush below it.
  const topbar = document.querySelector('.topbar');
  const setHeaderHeight = () =>
    document.documentElement.style.setProperty('--header-h', `${topbar ? topbar.offsetHeight : 0}px`);
  setHeaderHeight();
  window.addEventListener('resize', setHeaderHeight);

  buildLangSelect();
  applyI18n();

  document.getElementById('menu-btn').addEventListener('click', openDrawer);
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
  document.getElementById('nav-all').addEventListener('click', e => setView('all', e.currentTarget));
  document.getElementById('nav-favorites').addEventListener('click', e => setView('favorites', e.currentTarget));
  document.getElementById('brand-home').addEventListener('click', () => setView('all', document.getElementById('nav-all')));

  // Drawer: language modal, collapsible categories, legal docs, account.
  document.getElementById('nav-language').addEventListener('click', () => {
    buildLangModal();
    closeDrawer();
    openModal('lang-modal');
  });
  const catToggle = document.getElementById('categories-toggle');
  const catBox = document.getElementById('drawer-categories');
  catToggle.addEventListener('click', () => {
    const collapsed = catBox.classList.toggle('collapsed');
    catToggle.querySelector('.drawer-ico').textContent = collapsed ? '▸' : '▾';
  });
  document.getElementById('nav-privacy').addEventListener('click', () => { closeDrawer(); openLegal('privacy'); });
  document.getElementById('nav-terms').addEventListener('click', () => { closeDrawer(); openLegal('terms'); });
  document.getElementById('nav-delete').addEventListener('click', () => { closeDrawer(); openModal('delete-modal'); });
  document.getElementById('nav-auth').addEventListener('click', () => {
    closeDrawer();
    if (user) doLogout(); else openAuthModal();
  });

  // Modals: backdrop click + Esc close everything.
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; });
  });

  // Sign-in modal wiring.
  document.getElementById('auth-submit').addEventListener('click', submitAuth);
  document.getElementById('auth-tab-login').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));
  document.getElementById('auth-verify-submit').addEventListener('click', handleVerify);
  document.getElementById('auth-resend').addEventListener('click', handleResend);
  document.getElementById('auth-back-login').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('auth-guest').addEventListener('click', () => closeModal('auth-modal'));
  ['auth-name', 'auth-email', 'auth-password'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); }));
  document.getElementById('auth-otp').addEventListener('keydown', e => { if (e.key === 'Enter') handleVerify(); });
  document.getElementById('delete-cancel').addEventListener('click', () => closeModal('delete-modal'));
  document.getElementById('delete-confirm').addEventListener('click', confirmDeleteAccount);
  document.getElementById('legal-close').addEventListener('click', () => closeModal('legal-modal'));

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

  document.querySelectorAll('.btab').forEach(b =>
  b.addEventListener('click', () => setTab(b.dataset.tab, b)));
document.getElementById('player-back').addEventListener('click', closePlayer);
  document.getElementById('player-fs').addEventListener('click', toggleFullscreen);
  document.getElementById('player-fav').addEventListener('click', () => { if (activeGame) toggleFavorite(activeGame.id); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (activeGame) { closePlayer(); return; }
    document.querySelectorAll('.modal-overlay').forEach(ov => { ov.style.display = 'none'; });
  });

  // Fresh order when the tab becomes visible again or is restored from
  // the bfcache after navigating away and back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reshuffleGames();
  });
  window.addEventListener('pageshow', e => {
    if (e.persisted) reshuffleGames();
  });

  // Session bootstrap: restore a saved SmarTok session, validate the
  // token against /api/users/me, then pull the account favorites.
  (async () => {
    if (!getToken()) { updateAuthUI(); renderProfileCard(); return; }
    user = getCachedUser();
    updateAuthUI();
    renderProfileCard();
    try {
      const res = await authFetch('/api/users/me');
      const data = await res.json().catch(() => ({}));
      if (data.success && data.user) {
        user = data.user;
        saveSession(getToken(), data.user);
      } else if (res.status === 401 || res.status === 403) {
        await doLogout();
        return;
      }
    } catch { /* offline — keep the cached profile */ }
    updateAuthUI();
    renderProfileCard();
    if (user) { await mergeFavoritesOnLogin(); renderGrid(); }
  })();

  loadCatalog().then(() => {
    buildCategories();
    renderGrid();
  }).catch(err => {
    console.error('Catalog load failed:', err);
    document.getElementById('loading').textContent = 'Failed to load games.';
  });
}

document.addEventListener('DOMContentLoaded', init);
