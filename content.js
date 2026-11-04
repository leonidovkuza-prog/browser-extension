/**
 * Deep Search — Content Script for YouTube Search
 * Filters out noise (Shorts, streams, clickbait) in search results.
 */

const STORAGE_KEY = "deepSearchSettings";

const DEFAULT_SETTINGS = {
  enabled: false,
  minDurationMinutes: 20,
  maxViews: 30000,
  hideShorts: true,
  hideStreams: true
};

const HIDDEN_CLASS = "deep-search-hidden";
const CONTAINER_ID = "deep-search-container";
const TOGGLE_ID = "deep-search-toggle";

const VIDEO_CARD_SELECTORS = [
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-rich-grid-media",
  "yt-lockup-view-model"
].join(",");

const SHORTS_ITEM_SELECTORS = [
  "ytd-reel-item-renderer",
  "ytm-shorts-lockup-view-model",
  "ytm-shorts-lockup-view-model-v2"
].join(",");

const SHORTS_SHELF_SELECTORS = [
  "ytd-reel-shelf-renderer",
  "grid-shelf-view-model"
].join(",");

const ALL_CARD_SELECTORS =
  `${VIDEO_CARD_SELECTORS}, ${SHORTS_ITEM_SELECTORS}, ${SHORTS_SHELF_SELECTORS}`;

const TOGGLE_ANCHORS = [
  "ytd-two-column-search-results-renderer #primary ytd-section-list-renderer",
  "ytd-search #primary ytd-section-list-renderer",
  "#primary ytd-section-list-renderer",
  "ytd-section-list-renderer",
  "ytd-two-column-search-results-renderer #primary",
  "ytd-search #header"
];

let settings = { ...DEFAULT_SETTINGS };
let mutationObserver = null;
let lastUrl = location.href;
let cardCache = new WeakMap();

/* ----------------------------- Settings ----------------------------- */

function loadSettings() {
  return new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.sync) {
      resolve({ ...DEFAULT_SETTINGS });
      return;
    }
    chrome.storage.sync.get(STORAGE_KEY, (data) => {
      resolve({ ...DEFAULT_SETTINGS, ...(data[STORAGE_KEY] || {}) });
    });
  });
}

function saveSettings(next) {
  settings = { ...settings, ...next };
  if (chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  }
}

function isSearchPage() {
  return location.pathname === "/results" || /[?&]search_query=/.test(location.search);
}

/* ----------------------------- Parsing ------------------------------ */

function normalizeText(v) {
  return String(v || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseLocalizedNumber(raw) {
  const cleaned = normalizeText(raw).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseViewCount(raw) {
  const text = normalizeText(raw).toLowerCase();
  if (!text) return null;
  if (/no views|нет просмотров/.test(text)) return 0;

  const m = text.match(/([\d\s.,]+)\s*(k|m|b|тыс\.?|млн\.?|млрд\.?)?/i);
  if (!m) return null;

  const base = parseLocalizedNumber(m[1]);
  if (base === null) return null;

  const suffix = (m[2] || "").toLowerCase();
  const mult = {
    k: 1e3, m: 1e6, b: 1e9,
    "тыс": 1e3, "тыс.": 1e3,
    "млн": 1e6, "млн.": 1e6,
    "млрд": 1e9, "млрд.": 1e9
  };
  return Math.round(base * (mult[suffix] || 1));
}

function parseCardData(card) {
  const cached = cardCache.get(card);
  if (cached) return cached;

  // Собираем ВСЕ возможные тексты, включая aria-label и title
  let allText = card.textContent || "";
  card.querySelectorAll('[aria-label], [title]').forEach(el => {
    allText += " " + (el.getAttribute('aria-label') || "") + " " + (el.getAttribute('title') || "");
  });
  
  const text = normalizeText(allText);
  const lines = text.split(/(?:\n|\s{2,})/); // Разбиваем на куски

  // --- 1. Детект Shorts ---
  const isShort =
    Boolean(card.querySelector('a[href*="/shorts/"]')) ||
    /(^|\s)shorts(\s|$)/i.test(text);

  // --- 2. Детект Live ---
  const isLive =
    Boolean(card.querySelector('[overlay-style="LIVE"], .badge-style-type-live-now')) ||
    /\b(live now|прямой эфир|идёт трансляция|сейчас в эфире)\b/i.test(text);

  // --- 3. Поиск просмотров ---
  let views = null;
  // Сначала ищем по ключевым словам
  const vm = text.match(/([\d\s.,]+)\s*(k|m|тыс\.?|млн\.?|млрд\.?)?\s*(?:просмотр|view)/i);
  if (vm) {
    views = parseViewCount(vm[0]);
  } else {
    // Если не нашли, ищем в метаданных (вдруг там просто "124 тыс.")
    const meta = card.querySelector("#metadata-line, yt-content-metadata-view-model, .inline-metadata-item");
    if (meta) {
      const mText = normalizeText(meta.textContent);
      const m2 = mText.match(/([\d\s.,]+)\s*(k|m|тыс\.?|млн\.?|млрд\.?)/i);
      if (m2) views = parseViewCount(m2[0]);
    }
  }

  // --- 4. Поиск длительности (2:30 или 3:54:46) ---
  let seconds = null;
  // Ищем паттерн таймкода в любом месте текста (включая aria-label)
  const timeRegex = /(?:^|\s)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\s|$)/;
  const tm = text.match(timeRegex);
  if (tm) {
    const h = tm[1] ? parseInt(tm[1], 10) : 0;
    const min = parseInt(tm[2], 10);
    const s = parseInt(tm[3], 10);
    seconds = h * 3600 + min * 60 + s;
  }

  const result = { seconds, views, isShort, isLive };

  if (seconds !== null || views !== null || isShort || isLive) {
    cardCache.set(card, result);
  }
  return result;
}

/* ---------------------------- Decision ------------------------------ */

function shouldHideCard(card) {
  const { seconds, views, isShort, isLive } = parseCardData(card);

  if (settings.hideShorts && isShort) return true;
  if (settings.hideStreams && isLive) return true;

  const minSeconds = Number(settings.minDurationMinutes) * 60;
  if (minSeconds > 0 && seconds !== null && seconds < minSeconds) return true;

  const maxViews = Number(settings.maxViews);
  if (maxViews > 0 && views !== null && views > maxViews) return true;

  return false;
}

function setHidden(el, hidden) {
  if (!el) return;
  if (el.classList.contains(HIDDEN_CLASS) === hidden) return;
  el.classList.toggle(HIDDEN_CLASS, hidden);
}

/* ------------------------- Card processing -------------------------- */

function processCard(card) {
  if (!card || card.nodeType !== 1) return;

  if (!settings.enabled || !isSearchPage()) {
    if (card.classList.contains(HIDDEN_CLASS)) card.classList.remove(HIDDEN_CLASS);
    return;
  }

  if (card.matches(SHORTS_SHELF_SELECTORS)) {
    const isShortsShelf = card.matches("ytd-reel-shelf-renderer") || Boolean(card.querySelector(SHORTS_ITEM_SELECTORS));
    if (isShortsShelf) {
      setHidden(card, settings.hideShorts);
      return;
    }
  }

  if (card.matches(SHORTS_ITEM_SELECTORS)) {
    const shelf = card.closest("grid-shelf-view-model, ytd-reel-shelf-renderer");
    if (shelf) setHidden(shelf, settings.hideShorts);
    setHidden(card, settings.hideShorts);
    return;
  }

  setHidden(card, shouldHideCard(card));
}

function restoreAll() {
  document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((el) => {
    el.classList.remove(HIDDEN_CLASS);
  });
}

function applyMode() {
  if (!isSearchPage() || !settings.enabled) {
    restoreAll();
    return;
  }
  document.querySelectorAll(ALL_CARD_SELECTORS).forEach(processCard);
}

/* ----------------------------- Toggle UI ---------------------------- */

function injectToggle() {
  if (!isSearchPage()) return;
  if (document.getElementById(CONTAINER_ID)) {
    updateToggleUi();
    return;
  }

  let host = null;
  for (const sel of TOGGLE_ANCHORS) {
    host = document.querySelector(sel);
    if (host) break;
  }
  if (!host) return;

  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  container.className = "deep-search-container";

  const button = document.createElement("button");
  button.id = TOGGLE_ID;
  button.type = "button";
  button.className = "deep-search-toggle";
  button.addEventListener("click", () => {
    saveSettings({ enabled: !settings.enabled });
    applyMode();
  });

  container.appendChild(button);
  host.insertBefore(container, host.firstChild);
  updateToggleUi();
}

function removeToggle() {
  const el = document.getElementById(CONTAINER_ID);
  if (el) el.remove();
}

function updateToggleUi() {
  const btn = document.getElementById(TOGGLE_ID);
  if (!btn) return;
  btn.classList.toggle("is-active", Boolean(settings.enabled));
  btn.textContent = settings.enabled ? "Deep Search · On" : "Deep Search";
  btn.setAttribute("aria-pressed", settings.enabled ? "true" : "false");
}

/* ----------------------------- Observer ----------------------------- */

function collectCards(node, into) {
  if (node.nodeType !== 1) return;
  if (node.matches?.(ALL_CARD_SELECTORS)) into.add(node);
  if (node.querySelectorAll) {
    node.querySelectorAll(ALL_CARD_SELECTORS).forEach((el) => into.add(el));
  }
}

function startObserver() {
  if (mutationObserver) mutationObserver.disconnect();

  mutationObserver = new MutationObserver((mutations) => {
    if (!isSearchPage()) return;
    if (!document.getElementById(CONTAINER_ID)) injectToggle();
    if (!settings.enabled) return;

    const cards = new Set();
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      for (const node of m.addedNodes) collectCards(node, cards);
    }
    for (const card of cards) processCard(card);
  });

  mutationObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });
}

/* --------------------------- SPA navigation ------------------------- */

function onSpaNavigation() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;

  cardCache = new WeakMap();
  removeToggle();
  restoreAll();

  if (!isSearchPage()) return;
  injectToggle();
  applyMode();
}

/* ------------------------------ Init -------------------------------- */

async function init() {
  settings = await loadSettings();
  injectToggle();
  startObserver();
  applyMode();

  document.addEventListener("yt-navigate-finish", onSpaNavigation);
  document.addEventListener("yt-page-data-updated", onSpaNavigation);
  window.addEventListener("popstate", onSpaNavigation);

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[STORAGE_KEY]) return;
      settings = { ...DEFAULT_SETTINGS, ...changes[STORAGE_KEY].newValue };
      injectToggle();
      applyMode();
    });
  }
}

init();
