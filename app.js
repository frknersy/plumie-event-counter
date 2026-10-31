/**
 * Event register — a point-of-sale screen that runs offline on an iPad, independent of the panel.
 *
 * The product list comes from data.js (built by scripts/event-counter-export.ts).
 * Sales, prices, local products and events live only on this device, in
 * IndexedDB; nothing is sent anywhere. The menu has a full backup / restore
 * so it is not lost.
 *
 * A sale is one record: lines are stored with the unit price at that moment,
 * so later price changes do not alter past sales. A wrong sale is deleted;
 * older versions voided it instead, so revenue and counts still skip voided sales.
 */

import { qrSvg } from "./qr.js";

const DATA = window.PLUMIE_DATA ?? { generatedAt: null, families: [], components: [] };
const LOCAL_FAMILY = "__local";
const PAYMENTS = ["Nakit", "IBAN"];
const LONG_PRESS_MS = 450;
const LOCAL_IMAGE_SIZE = 360;
/** 2: categories added. 1 is still read (no categories; they are rebuilt from families on open). */
const BACKUP_FORMAT = 2;
/** Sort options; dir: direction when first picked, labels: [ascending, descending]. */
const SORT_MODES = [
  { key: "custom", label: "Özel sıra", icon: "move" },
  { key: "sold", label: "Satış sayısı", icon: "trending", dir: "desc", labels: ["En az", "En çok"] },
  { key: "name", label: "İsim", icon: "type", dir: "asc", labels: ["A → Z", "Z → A"] },
  { key: "category", label: "Kategori", icon: "layers", dir: "asc", labels: ["Baştan", "Sondan"] },
  { key: "price", label: "Fiyat", icon: "tag", dir: "asc", labels: ["Ucuz", "Pahalı"] },
];

// --- IndexedDB -------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("plumie-event-counter", 3);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
        db.createObjectStore("locals", { keyPath: "code" });
        db.createObjectStore("kv", { keyPath: "key" });
      }
      if (event.oldVersion < 2) {
        // Version 1 counted taps; the register keeps sales. The counter was never
        // used before the switch, so there is nothing to migrate.
        if (db.objectStoreNames.contains("taps")) db.deleteObjectStore("taps");
        db.createObjectStore("sales", { keyPath: "id", autoIncrement: true }).createIndex("eventId", "eventId");
        // key: "k:<category id>" category price, "c:<code>" product-specific price.
        // (Version 2's "f:<family>" family prices move to categories on open.)
        db.createObjectStore("prices", { keyPath: "key" });
      }
      if (event.oldVersion < 3) {
        // { id, name, order, family }: family is the panel family the category was
        // built from; new products of that family land here.
        db.createObjectStore("categories", { keyPath: "id", autoIncrement: true });
      }
    };
    // An upgrade waits while an old version is open in another tab; say what to
    // do instead of showing a blank screen. Opening resumes once that tab closes.
    request.onblocked = () =>
      showBanner("Uygulamanın eski sürümü başka bir sekmede ya da pencerede açık. Onu kapatınca burası açılacak.");
    request.onsuccess = () => {
      const db = request.result;
      // When a newer version opens, release the database and reload so the upgrade is not blocked.
      db.onversionchange = () => {
        db.close();
        location.reload();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function showBanner(text) {
  const banner = document.getElementById("banner");
  banner.textContent = text;
  banner.hidden = false;
}

// Never leave a blank screen if startup fails. Only this app's own errors are
// shown: "Script error." comes from other origins (Safari's share sheet,
// browser extensions) and says nothing about the app.
let started = false;
window.addEventListener("error", (e) => {
  if (!e.filename?.startsWith(location.origin)) return;
  showBanner(started ? `Beklenmeyen bir hata oldu: ${e.message}. Sayfayı yenile.` : `Uygulama açılamadı: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  if (!started) showBanner(`Uygulama açılamadı: ${e.reason?.message ?? e.reason}`);
});

const db = await openDb();
document.getElementById("banner").hidden = true;
const STORES = ["events", "sales", "prices", "categories", "locals", "kv"];

/** Resolves once the transaction completes (is on disk), with the request's result. */
function run(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const idb = {
  get: (store, key) => run(store, "readonly", (s) => s.get(key)),
  all: (store) => run(store, "readonly", (s) => s.getAll()),
  byIndex: (store, index, key) => run(store, "readonly", (s) => s.index(index).getAll(key)),
  add: (store, value) => run(store, "readwrite", (s) => s.add(value)),
  put: (store, value) => run(store, "readwrite", (s) => s.put(value)),
  del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
};

const kv = {
  get: async (key, fallback) => (await idb.get("kv", key))?.value ?? fallback,
  set: (key, value) => idb.put("kv", { key, value }),
};

// --- State -----------------------------------------------------------------

const state = {
  event: null,
  /** This event's sales (voided included), oldest first. */
  sales: [],
  /** code → units sold (from sales that are not voided). */
  sold: new Map(),
  /** key → price (see the prices store). */
  prices: new Map(),
  /** code → quantity; the cart lives in memory only. */
  cart: new Map(),
  locals: [],
  hidden: new Set(),
  showHidden: false,
  /** Whether revenue and totals are shown; at the stand the screen faces customers. */
  showMoney: localStorage.getItem("showMoney") !== "0",
  /** Ordered categories: { id, name, order, family }. */
  categories: [],
  /**
   * code → category id or null (uncategorized). Only products moved by hand
   * are here; the rest fall into their family's category (categoryIdOf).
   */
  assign: {},
  /** code → name given on the iPad (panel products only; local products keep the name in their record). */
  names: {},
  /** code → photo given on the iPad (data: URL) or "" (removed); panel products only. */
  images: {},
  /** Tiered price campaigns, in priority order (see promosOf). */
  campaigns: [],
  /** "all", "none" (uncategorized) or a category id. */
  tab: "all",
  query: "",
  /** Select mode: a tap marks the product instead of adding it to the cart (bulk move). */
  selecting: false,
  selected: new Set(),
  /** Grid order; "custom" = category order + the order set by hand within a category. */
  sort: readSort(),
  /** code → position set by hand within its category (kv "order"). */
  order: {},
  /** Reorder mode: cards are dragged, no selling. */
  reordering: false,
  /** { name, iban, bank } shown on the IBAN screen (kv "iban"); only on this device and in its backups. */
  iban: null,
  /** The right panel's tab: "cart", "sales" or "summary". */
  panel: "cart",
  salesFilter: "all",
  summaryAll: false,
};

function readSort() {
  try {
    const saved = JSON.parse(localStorage.getItem("sort"));
    if (SORT_MODES.some((m) => m.key === saved?.mode) && ["asc", "desc"].includes(saved.dir)) return saved;
  } catch {
    // Missing or corrupt: use the default.
  }
  return { mode: "custom", dir: "asc" };
}

/** code → { item, el, priceEl, soldEl, cartEl, checkEl } */
const cards = new Map();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** One of the line icons in index.html. */
const icon = (name) => `<svg class="ic"><use href="#i-${name}" /></svg>`;

/** Category colors: readable in all three themes (light, dark, burgundy). */
const PALETTE = ["#e0569b", "#1d9e75", "#7f77dd", "#d85a30", "#378add", "#ba7517", "#639922", "#c2417a", "#0f8a8a", "#8a8780"];
const colorOf = (category) => category?.color ?? PALETTE[(state.categories.indexOf(category) + PALETTE.length) % PALETTE.length];
/** "#rrggbb" → translucent tint (card background, cart thumbnail). */
function tint(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
const trLower = (s) => s.toLocaleLowerCase("tr");
const moneyFmt = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money = (n) => moneyFmt.format(n);
const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "45", "45,5", "45.50" → number; null when empty or invalid. */
function parseAmount(text) {
  const n = Number(String(text).trim().replace(",", "."));
  return String(text).trim() !== "" && Number.isFinite(n) ? n : null;
}

/** Round to cents so floating point leftovers (0.1 + 0.2) never reach totals. */
const round2 = (n) => Math.round(n * 100) / 100;

/** For panel products, a name or photo given on the iPad overrides the panel's (state.names, state.images). */
function allItems() {
  return [
    ...DATA.components.map((c) => ({
      ...c,
      name: state.names[c.code] ?? c.name,
      panelName: c.name,
      // "" = photo removed (the card shows the name).
      img: Object.hasOwn(state.images, c.code) ? state.images[c.code] || null : c.img,
      panelImg: c.img,
      local: false,
    })),
    ...state.locals.map((l) => ({ code: l.code, name: l.name, family: LOCAL_FAMILY, img: l.img, local: true })),
  ];
}

// --- Categories --------------------------------------------------------------

/** The category it was moved to, else the one built from its family, else null. */
function categoryIdOf(item) {
  if (Object.hasOwn(state.assign, item.code)) {
    const id = state.assign[item.code];
    return state.categories.some((c) => c.id === id) ? id : null;
  }
  return state.categories.find((c) => c.family === item.family)?.id ?? null;
}

const categoryById = (id) => state.categories.find((c) => c.id === id);
const sameName = (a, b) => trLower(a.trim()) === trLower(b.trim());

/**
 * On first open, builds categories from the panel families and moves version
 * 2's family prices onto them. Runs once: even if every category is deleted
 * later, they are not rebuilt.
 */
async function seedCategories() {
  if (await kv.get("categoriesSeeded", false)) return;
  const families = [
    ...DATA.families,
    ...(state.locals.length ? [{ key: LOCAL_FAMILY, label: "Eklediklerim" }] : []),
  ];
  for (const [order, family] of families.entries()) {
    const category = { name: family.label, order, family: family.key, color: PALETTE[order % PALETTE.length] };
    category.id = await idb.add("categories", category);
    const old = state.prices.get(`f:${family.key}`);
    if (old != null) {
      await idb.put("prices", { key: `k:${category.id}`, price: old });
      await idb.del("prices", `f:${family.key}`);
    }
  }
  await kv.set("categoriesSeeded", true);
}

/** kv entries that belong to the default setup (see scripts/event-counter-export.ts). */
const SETUP_KV_KEYS = ["assign", "names", "images", "campaigns", "order", "hidden"];

/**
 * Writes the default setup from data.js: categories, prices, local products,
 * campaigns, name/photo overrides, order, hidden products. It replaces the
 * current setup; events and sales are left as they are.
 */
function applyDefaults(defaults) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["categories", "prices", "locals", "kv"], "readwrite");
    for (const store of ["categories", "prices", "locals"]) {
      const s = tx.objectStore(store);
      s.clear();
      for (const row of defaults[store]) s.put(row);
    }
    const kvStore = tx.objectStore("kv");
    for (const key of SETUP_KV_KEYS) kvStore.delete(key);
    for (const entry of defaults.kv) kvStore.put(entry);
    kvStore.put({ key: "categoriesSeeded", value: true });
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function defaultsSheet() {
  const d = DATA.defaults;
  const campaigns = d.kv.find((e) => e.key === "campaigns")?.value ?? [];
  const sheet = openSheet(`
    <h2>Varsayılan ayarları yükle</h2>
    <p class="hint">${dateTimeFmt.format(new Date(d.savedAt))} tarihli ayarlar: ${d.categories.length} kategori, ${d.prices.length} fiyat, ${campaigns.length} kampanya, ${d.locals.length} elle eklenen ürün; ürün adları, fotoğraflar ve sıra.</p>
    <p class="hint" style="color:var(--danger)">Bu cihazdaki kategoriler, fiyatlar, kampanyalar ve elle eklenen ürünler bunlarla değiştirilecek. Etkinlikler ve satışlar korunur.</p>
    <div class="row"><button id="vCancel">Vazgeç</button><button class="primary" id="vGo">Yükle</button></div>`);
  sheet.querySelector("#vCancel").addEventListener("click", closeSheet);
  sheet.querySelector("#vGo").addEventListener("click", async () => {
    await applyDefaults(d);
    location.reload();
  });
}

async function loadCategories() {
  state.categories = (await idb.all("categories")).sort((a, b) => a.order - b.order);
  state.prices = new Map((await idb.all("prices")).map((p) => [p.key, p.price]));
  state.assign = await kv.get("assign", {});
  state.names = await kv.get("names", {});
  state.order = await kv.get("order", {});
  state.images = await kv.get("images", {});
  state.campaigns = await kv.get("campaigns", []);
}

async function moveItems(codes, categoryId) {
  // If the target category was ordered by hand, moved products go to its end;
  // otherwise their order entry is dropped and panel sales place them.
  const ordered = [...cards.values()]
    .filter((c) => categoryIdOf(c.item) === categoryId && !codes.includes(c.item.code))
    .map((c) => state.order[c.item.code])
    .filter((n) => n != null);
  let last = Math.max(-1, ...ordered);
  for (const code of codes) {
    state.assign[code] = categoryId;
    if (ordered.length) state.order[code] = ++last;
    else delete state.order[code];
  }
  await kv.set("assign", state.assign);
  await kv.set("order", state.order);
  for (const code of codes) renderCard(code);
  renderCart();
}

async function addCategory(name) {
  // The first unused color; round-robin once all are used.
  const used = new Set(state.categories.map(colorOf));
  const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[state.categories.length % PALETTE.length];
  const category = { name: name.trim(), order: Math.max(-1, ...state.categories.map((c) => c.order)) + 1, family: null, color };
  category.id = await idb.add("categories", category);
  state.categories.push(category);
  return category;
}

/** Moves the category's products to the target (or null: uncategorized) and deletes it. */
async function deleteCategory(category, targetId) {
  const codes = [...cards.values()].filter((c) => categoryIdOf(c.item) === category.id).map((c) => c.item.code);
  await moveItems(codes, targetId);
  await idb.del("categories", category.id);
  await setPrice(`k:${category.id}`, null);
  state.categories = state.categories.filter((c) => c.id !== category.id);
}

function countIn(categoryId) {
  let n = 0;
  for (const { item } of cards.values()) {
    if ((state.showHidden || !state.hidden.has(item.code)) && categoryIdOf(item) === categoryId) n++;
  }
  return n;
}

/** Payment type as a pill with the same color and icon as its pay button. */
const payTag = (payment) =>
  payment === "Nakit"
    ? `<span class="pay-pill cash">${icon("cash")}Nakit</span>`
    : `<span class="pay-pill bank">${icon("bank")}${esc(payment)}</span>`;

/** The card's lowest campaign tier as a badge: "2 al ₺180". */
function campaignLabel(item) {
  const tier = campaignOf(item)?.tiers[0];
  return tier ? `${tier.qty} al ${money(tier.price)}` : "";
}

// --- Prices ------------------------------------------------------------------

/** The product-specific price, else the category price, else null. */
function priceOf(item) {
  const own = state.prices.get(`c:${item.code}`);
  if (own != null) return { price: own, own: true };
  const cat = state.prices.get(`k:${categoryIdOf(item)}`);
  return cat != null ? { price: cat, own: false } : { price: null, own: false };
}

async function setPrice(key, price) {
  if (price == null) {
    state.prices.delete(key);
    await idb.del("prices", key);
  } else {
    state.prices.set(key, price);
    await idb.put("prices", { key, price });
  }
  for (const code of cards.keys()) renderCard(code);
  renderCart();
  if (state.sort.mode === "price") applySort();
}

// --- Sales -------------------------------------------------------------------

const saleSubtotal = (sale) => round2(sale.lines.reduce((sum, l) => sum + l.qty * l.unit, 0));
/** Campaign discount; sales from before campaigns have no promos. */
const salePromo = (sale) => round2((sale.promos ?? []).reduce((sum, p) => sum + p.amount, 0));
const saleTotal = (sale) => round2(saleSubtotal(sale) - salePromo(sale) - sale.discount);

/** The first active campaign the product falls into (list order is priority). */
function campaignOf(item) {
  const cat = categoryIdOf(item);
  return state.campaigns.find((c) => c.active && c.categoryIds.includes(cat)) ?? null;
}

/**
 * Tiered pricing: campaign products count mixed ("2 for 180" also applies to
 * two different stickers). Units are sorted from expensive to cheap and the
 * cheapest total is searched: each step takes either one unit at its own price
 * or a tier (the next N units at the tier price). Tiers absorb the most
 * expensive units and the cheap ones are left at unit price — in the customer's favor. 4 = 3 + 1.
 *
 * No discount unless it beats the regular total (a campaign never raises the price).
 */
function bestPrice(units, tiers) {
  const n = units.length;
  const best = new Array(n + 1).fill(Infinity);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    best[i] = units[i] + best[i + 1];
    for (const tier of tiers) {
      if (i + tier.qty <= n) best[i] = Math.min(best[i], tier.price + best[i + tier.qty]);
    }
  }
  return round2(best[0]);
}

/** Campaigns applied to the cart lines: [{ id, name, amount }], only those that discount. */
function promosOf(lines) {
  const groups = new Map();
  for (const line of lines) {
    const campaign = campaignOf(cards.get(line.code).item);
    if (!campaign) continue;
    const units = groups.get(campaign) ?? [];
    for (let k = 0; k < line.qty; k++) units.push(line.unit);
    groups.set(campaign, units);
  }
  const promos = [];
  for (const [campaign, units] of groups) {
    units.sort((a, b) => b - a);
    const regular = round2(units.reduce((sum, u) => sum + u, 0));
    const amount = round2(regular - bestPrice(units, campaign.tiers));
    if (amount > 0) promos.push({ id: campaign.id, name: campaign.name, amount });
  }
  return promos;
}
const liveSales = (sales) => sales.filter((s) => !s.voided);

function soldOf(sales) {
  const sold = new Map();
  for (const sale of liveSales(sales)) {
    for (const line of sale.lines) sold.set(line.code, (sold.get(line.code) ?? 0) + line.qty);
  }
  return sold;
}

function cartLines() {
  return [...state.cart].map(([code, qty]) => {
    const { item } = cards.get(code);
    return { code, name: item.name, qty, unit: priceOf(item).price };
  });
}

async function checkout(payment) {
  const lines = cartLines();
  if (lines.length === 0) return;
  // Before any await: iOS plays sound only straight from the tap.
  if (soundOn("sale")) playRegister();
  const sale = {
    eventId: state.event.id,
    // After a deletion the count no longer matches the numbers; continue from the highest.
    no: Math.max(0, ...state.sales.map((s) => s.no)) + 1,
    at: new Date().toISOString(),
    lines,
    // Campaigns are stored as they were at sale time; later edits do not change the sale.
    promos: promosOf(lines),
    // Manual discounts were removed; the field stays so old sales keep theirs.
    discount: 0,
    payment,
    voided: false,
  };
  sale.id = await idb.add("sales", sale);
  state.sales.push(sale);
  state.cart.clear();
  setCartOpen(false);
  afterSalesChange();
  showSaleDone(sale);
  showToast(`Satış #${sale.no} · ${money(saleTotal(sale))} · ${payment}`, () => deleteSale(sale, true));
}

async function deleteSale(sale, fromUndo) {
  await idb.del("sales", sale.id);
  state.sales = state.sales.filter((s) => s !== sale);
  afterSalesChange();
  showToast(fromUndo ? `Satış #${sale.no} geri alındı` : `Satış #${sale.no} silindi`);
}

function afterSalesChange() {
  state.sold = soldOf(state.sales);
  for (const code of cards.keys()) renderCard(code);
  renderCart();
  renderHeader();
  if (state.sort.mode === "sold") applySort();
  renderPanel();
}

/** An event's summary: revenue, payment types, products. */
function summarize(sales) {
  const live = liveSales(sales);
  const byPayment = new Map(PAYMENTS.map((p) => [p, 0]));
  const products = new Map();
  let revenue = 0;
  let items = 0;
  let discount = 0;
  let promo = 0;
  for (const sale of live) {
    const total = saleTotal(sale);
    revenue += total;
    discount += sale.discount;
    promo += salePromo(sale);
    byPayment.set(sale.payment, (byPayment.get(sale.payment) ?? 0) + total);
    for (const line of sale.lines) {
      items += line.qty;
      const row = products.get(line.code) ?? { code: line.code, name: line.name, qty: 0, amount: 0 };
      row.qty += line.qty;
      row.amount += line.qty * line.unit;
      products.set(line.code, row);
    }
  }
  return {
    count: live.length,
    voided: sales.length - live.length,
    revenue: round2(revenue),
    items,
    discount: round2(discount),
    promo: round2(promo),
    byPayment,
    products: [...products.values()].sort((a, b) => b.amount - a.amount || b.qty - a.qty),
  };
}

// --- Events ----------------------------------------------------------------

async function startEvent(name) {
  const event = { name, startedAt: new Date().toISOString() };
  event.id = await idb.add("events", event);
  await kv.set("currentEvent", event.id);
  return event;
}

/** Deletes an event with its sales. Deleting the current one starts a fresh event. */
async function deleteEvent(event) {
  for (const sale of await salesOf(event.id)) await idb.del("sales", sale.id);
  await idb.del("events", event.id);
  if (event.id !== state.event.id) return;
  state.event = await startEvent(`Etkinlik ${dateFmt.format(new Date())}`);
  state.sales = [];
  state.cart.clear();
  afterSalesChange();
}

async function salesOf(eventId) {
  return (await idb.byIndex("sales", "eventId", eventId)).sort((a, b) => a.no - b.no);
}

async function loadEvent() {
  const id = await kv.get("currentEvent", null);
  state.event = (id != null && (await idb.get("events", id))) || (await startEvent(`Etkinlik ${dateFmt.format(new Date())}`));
  state.sales = await salesOf(state.event.id);
  state.sold = soldOf(state.sales);
}

// --- Rendering ---------------------------------------------------------------

function renderHeader() {
  const { revenue, count } = summarize(state.sales);
  $("eventName").textContent = state.event.name;
  $("revenue").textContent = money(revenue);
  $("revenueWrap").hidden = !state.showMoney;
  $("saleCount").textContent = count;
  $("salesCount").textContent = count || "";
}

/** Empty categories keep their tab (products get moved into new ones); uncategorized only when non-empty. */
function renderTabs() {
  const visible = [...cards.values()].filter(({ item }) => state.showHidden || !state.hidden.has(item.code)).length;
  const loose = countIn(null);
  const tabs = [
    ["all", "Tümü", visible],
    ...state.categories.map((c) => [c.id, c.name, countIn(c.id)]),
    ...(loose ? [["none", "Kategorisiz", loose]] : []),
  ];
  if (!tabs.some(([k]) => k === state.tab)) state.tab = "all";
  const dot = (k) => (k === "all" ? "" : `<span class="dot" style="background:${colorOf(k === "none" ? null : categoryById(k))}"></span>`);
  $("tabs").innerHTML =
    tabs
      .map(([k, label, n]) => `<button class="tab ${k === state.tab ? "on" : ""}" data-tab="${k}">${dot(k)}${esc(label)}<span class="n">${n}</span></button>`)
      .join("") + `<button class="tab edit" id="editCats">${icon("pencil")}Kategoriler</button>`;
  centerActiveTab();
  updateTabFades();
}

/**
 * Keeps the selected tab in the middle of the row so its neighbours are visible.
 * The target is clamped to the scrollable range: asking for more left the row
 * stranded mid-way on the iPad, with empty space on the left.
 */
function centerActiveTab(smooth = false) {
  const tabs = $("tabs");
  const on = tabs.querySelector(".tab.on");
  if (!on) return;
  const box = tabs.getBoundingClientRect();
  const tab = on.getBoundingClientRect();
  const target = tabs.scrollLeft + tab.left - box.left - (box.width - tab.width) / 2;
  const left = Math.max(0, Math.min(target, tabs.scrollWidth - tabs.clientWidth));
  tabs.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
}

/**
 * Fades the edge of the tab row where more tabs are scrolled out of view. The
 * fades are overlays on the wrapper: a mask on the scrolling row itself made
 * iPad Safari paint the row half-empty.
 */
function updateTabFades() {
  const tabs = $("tabs");
  const wrap = tabs.parentElement;
  wrap.classList.toggle("more-left", tabs.scrollLeft > 4);
  wrap.classList.toggle("more-right", tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 4);
}

/** Builds the cards once; afterwards only prices and badges update (images are never redrawn). */
function buildGrid() {
  cards.clear();
  const grid = $("grid");
  grid.textContent = "";
  for (const [index, item] of allItems().entries()) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.code = item.code;
    const face = document.createElement("div");
    face.className = "face";
    // A card without an image gets its category color in renderCard.
    if (item.img) face.style.backgroundImage = `url("${item.img}")`;
    else face.textContent = item.name;
    face.insertAdjacentHTML("beforeend", `<span class="stripe"></span>`);
    el.append(face);
    el.insertAdjacentHTML(
      "beforeend",
      `<div class="name">${item.img ? esc(item.name) : `<span class="code">${item.local ? "Elle eklendi" : esc(item.code)}</span>`}</div>` +
        `<div class="prow"><span class="price"></span><span class="chip" hidden></span></div>` +
        (item.local ? `<span class="tag">Yerel</span>` : "") +
        `<span class="sold" title="Bu etkinlikte satılan"></span><span class="incart" hidden></span><span class="check" hidden>${icon("check")}</span><span class="grip">${icon("grip")}</span>`,
    );
    grid.append(el);
    cards.set(item.code, {
      item,
      index,
      el,
      faceEl: face,
      stripeEl: face.querySelector(".stripe"),
      priceEl: el.querySelector(".price"),
      chipEl: el.querySelector(".chip"),
      soldEl: el.querySelector(".sold"),
      cartEl: el.querySelector(".incart"),
      checkEl: el.querySelector(".check"),
    });
  }
  for (const code of cards.keys()) renderCard(code);
  applyFilter();
}

function renderCard(code) {
  const card = cards.get(code);
  if (!card) return;
  const { price, own } = priceOf(card.item);
  card.priceEl.className = price == null ? "price none" : "price";
  card.priceEl.innerHTML = price == null ? "Fiyat yok" : `${money(price)}${own ? "<small>özel</small>" : ""}`;
  const label = campaignLabel(card.item);
  card.chipEl.hidden = !label;
  card.chipEl.textContent = label;
  const color = colorOf(categoryById(categoryIdOf(card.item)));
  card.stripeEl.style.background = color;
  if (!card.item.img) {
    card.faceEl.style.backgroundColor = tint(color, 0.18);
    card.faceEl.style.color = color;
  }
  card.soldEl.textContent = state.sold.get(code) ?? 0;
  const inCart = state.cart.get(code) ?? 0;
  card.cartEl.hidden = inCart === 0 || state.selecting;
  card.cartEl.textContent = inCart;
  const selected = state.selected.has(code);
  card.checkEl.hidden = !state.selecting;
  card.checkEl.firstElementChild.style.visibility = selected ? "visible" : "hidden";
  card.el.classList.toggle("selected", selected);
}

function applyFilter() {
  const q = trLower(state.query.trim());
  let visible = 0;
  for (const { item, el } of cards.values()) {
    const hidden = state.hidden.has(item.code);
    const cat = categoryIdOf(item);
    const show =
      (state.showHidden || !hidden) &&
      (q || state.tab === "all" || (state.tab === "none" ? cat === null : cat === state.tab)) &&
      (!q || trLower(item.name).includes(q) || trLower(item.code).includes(q));
    el.hidden = !show;
    el.classList.toggle("is-hidden", hidden);
    if (show) visible++;
  }
  applySort();
  $("empty").hidden = visible > 0;
  $("empty").textContent =
    typeof state.tab === "number" && !q ? 'Bu kategoride ürün yok. "Seç" ile ürünleri buraya taşıyabilirsin.' : "Eşleşen ürün yok";
}

const collator = new Intl.Collator("tr", { numeric: true });

/**
 * Cards never move in the DOM; CSS order arranges them so images are not
 * redrawn. Ties fall back to the custom order so the list looks the same on
 * every open. Products without a price are always last, in either direction.
 */
function applySort() {
  const { mode, dir } = state.sort;
  const sign = dir === "desc" ? -1 : 1;
  const catIndex = (item) => {
    const i = state.categories.findIndex((c) => c.id === categoryIdOf(item));
    return i === -1 ? state.categories.length : i;
  };
  // Products not ordered by hand go from best to least selling in the panel (data.js sold).
  const custom = (a, b) =>
    catIndex(a.item) - catIndex(b.item) ||
    (state.order[a.item.code] ?? Infinity) - (state.order[b.item.code] ?? Infinity) ||
    (b.item.sold ?? 0) - (a.item.sold ?? 0) ||
    a.index - b.index;
  const compare = {
    custom: () => 0,
    sold: (a, b) => sign * ((state.sold.get(a.item.code) ?? 0) - (state.sold.get(b.item.code) ?? 0)),
    name: (a, b) => sign * collator.compare(a.item.name, b.item.name),
    category: (a, b) => sign * (catIndex(a.item) - catIndex(b.item)),
    price: (a, b) => {
      const pa = priceOf(a.item).price;
      const pb = priceOf(b.item).price;
      if (pa == null || pb == null) return (pa == null) - (pb == null);
      return sign * (pa - pb);
    },
  }[mode];
  [...cards.values()]
    .sort((a, b) => compare(a, b) || custom(a, b))
    .forEach((card, i) => (card.el.style.order = i));
  renderSortButton();
}

function renderSortButton() {
  const { mode, dir } = state.sort;
  const m = SORT_MODES.find((x) => x.key === mode);
  $("sortBtn").classList.toggle("active", mode !== "custom");
  $("sortBtn").innerHTML = `${icon("sort")}<span class="lbl">${m.label}${m.labels ? ` · ${m.labels[dir === "asc" ? 0 : 1]}` : ""}</span>`;
}

function setSort(mode, dir) {
  state.sort = { mode, dir };
  localStorage.setItem("sort", JSON.stringify(state.sort));
  applySort();
}

/** Sort menu: tapping the selected option again flips the direction. */
function sortMenu() {
  const { mode, dir } = state.sort;
  const canEdit = mode === "custom" && typeof state.tab === "number";
  const pop = openPopover(
    $("sortBtn"),
    `<div class="pop-title">Sırala</div>
    ${SORT_MODES.map((m) => {
      const on = m.key === mode;
      const arrow = on && m.labels ? `<span class="dir">${icon(dir === "asc" ? "arrow-up" : "arrow-down")}${m.labels[dir === "asc" ? 0 : 1]}</span>` : "";
      return `<button class="opt ${on ? "on" : ""}" data-mode="${m.key}">${icon(m.icon)}${m.label}${arrow}</button>`;
    }).join("")}
    <div class="pop-sep"></div>
    <button class="opt" data-reorder ${canEdit ? "" : "disabled"}>${icon("grip")}Sırayı düzenle</button>
    <div class="pop-hint">${
      mode !== "custom"
        ? 'Özel sırayı düzenlemek için "Özel sıra"yı seç.'
        : `Özel sırada elle dizilmemiş ürünler paneldeki toplam satışa göre (çoktan aza) durur. ${
            canEdit ? "Bu kategorideki kartları sürükleyerek sırala." : "Sıralamak için bir kategori sekmesi seç."
          }`
    }</div>`,
  );
  pop.addEventListener("click", (e) => {
    const option = e.target.closest("[data-mode]");
    if (option) {
      const m = SORT_MODES.find((x) => x.key === option.dataset.mode);
      if (m.key === mode && m.labels) setSort(mode, dir === "asc" ? "desc" : "asc");
      else setSort(m.key, m.dir ?? "asc");
      sortMenu();
      return;
    }
    if (e.target.closest("[data-reorder]") && canEdit) {
      closeSheet();
      setReordering(true);
    }
  });
}

/** Clears the search; on a phone the search field folds back behind its icon. */
function clearSearch() {
  $("search").value = "";
  state.query = "";
  $("searchClear").hidden = true;
  document.querySelector("header").classList.remove("searching");
  applyFilter();
}

function setReordering(on) {
  state.reordering = on;
  if (on) {
    setSelecting(false);
    clearSearch();
    $("reorderText").textContent = `${categoryById(state.tab)?.name ?? ""} · kartları sürükleyerek sırala`;
  }
  document.body.classList.toggle("reordering", on);
  $("reorderBar").hidden = !on;
}

function renderSelectBar() {
  $("selectBtn").classList.toggle("on", state.selecting);
  $("selectBar").hidden = !state.selecting;
  $("selectCount").textContent = state.selected.size ? `${state.selected.size} ürün seçildi` : "Ürünlere dokunarak seç";
  $("moveBtn").disabled = state.selected.size === 0;
}

/** Phone only: the floating bar under the grid that opens the right panel as a sheet. */
let cartBarCount = 0;
function renderCartBar(lines, total) {
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const bar = $("cartBar");
  bar.classList.toggle("empty", count === 0);
  bar.innerHTML = count
    ? `${icon("bag")}<span>${count} ürün · <b>${money(total)}</b></span><span class="go">Öde ${icon("arrow-up")}</span>`
    : `${icon("bag")}<span>Ürüne dokun, sepete eklensin</span>`;
  // A sale or clearing the cart closes the sheet; it stays open on the sales tabs.
  if (cartBarCount && !count && state.panel === "cart") setCartOpen(false);
  cartBarCount = count;
}

function setCartOpen(open) {
  document.body.classList.toggle("cart-open", open);
}

function setSelecting(on) {
  state.selecting = on;
  document.body.classList.toggle("selecting", on);
  state.selected.clear();
  for (const code of cards.keys()) renderCard(code);
  renderSelectBar();
}

function renderCart() {
  const lines = cartLines();
  const subtotal = round2(lines.reduce((sum, l) => sum + l.qty * l.unit, 0));
  const promos = promosOf(lines);
  const base = round2(subtotal - promos.reduce((sum, p) => sum + p.amount, 0));
  const promoRows = promos.map((p) => `<div class="promo">${icon("discount")}<span>${esc(p.name)}</span><b>−${money(p.amount)}</b></div>`).join("");
  /** A cart line's thumbnail: the product image, else its initial in the category color. */
  const thumb = (code) => {
    const { item } = cards.get(code);
    if (item.img) return `<div class="thumb" style="background-image:url(&quot;${item.img}&quot;)"></div>`;
    const color = colorOf(categoryById(categoryIdOf(item)));
    return `<div class="thumb" style="background:${tint(color, 0.18)};color:${color}">${esc(item.name.slice(0, 1).toLocaleUpperCase("tr"))}</div>`;
  };
  $("lines").innerHTML = (lines.length
    ? lines
        .map(
          (l) => `<div class="line" data-line="${esc(l.code)}">
            ${thumb(l.code)}
            <div class="info"><div>${esc(l.name)}</div><div>${money(l.unit)}</div></div>
            <div class="stepper">
              <button data-minus="${esc(l.code)}" aria-label="Azalt">−</button><span>${l.qty}</span><button data-plus="${esc(l.code)}" aria-label="Artır">+</button>
            </div>
            <div class="amount">${money(l.qty * l.unit)}</div>
          </div>`,
        )
        .join("")
    : `<div class="cart-empty">${icon("bag")}Ürüne dokun, sepete eklensin</div>`) + promoRows;
  const total = base;
  $("cartTotal").textContent = money(total);
  $("cartCount").textContent = lines.reduce((sum, l) => sum + l.qty, 0) || "";
  for (const button of document.querySelectorAll("[data-pay]")) button.disabled = lines.length === 0;
  for (const el of document.querySelectorAll("[data-pay-amount]")) el.textContent = lines.length ? money(total) : "";
  $("clearCart").disabled = lines.length === 0;
  $("change").hidden = lines.length === 0;
  renderCartBar(lines, total);
  if (!lines.length) $("received").value = "";
  renderChange(total);
}

/** Change due: shows the difference when the cash received is typed; never stored with the sale. */
function renderChange(total) {
  const received = parseAmount($("received").value);
  const out = $("changeOut");
  if (received == null || received <= 0) out.innerHTML = "";
  else if (received >= total) out.innerHTML = `Para üstü <b>${money(round2(received - total))}</b>`;
  else out.innerHTML = `<span class="short">${money(round2(total - received))} eksik</span>`;
}

function refreshAll() {
  renderHeader();
  renderTabs();
  for (const code of cards.keys()) renderCard(code);
  renderCart();
  applyFilter();
  renderPanel();
}

// --- Touch -----------------------------------------------------------------

function addToCart(code) {
  const card = cards.get(code);
  if (!card) return;
  if (priceOf(card.item).price == null) {
    priceForm(card.item, { thenAdd: true });
    return;
  }
  if (state.panel !== "cart") setPanel("cart");
  state.cart.set(code, (state.cart.get(code) ?? 0) + 1);
  if (soundOn("add")) playBeep();
  renderCard(code);
  renderCart();
  card.el.classList.remove("hit");
  void card.el.offsetWidth;
  card.el.classList.add("hit");
  card.cartEl.classList.add("pop");
  setTimeout(() => card.cartEl.classList.remove("pop"), 150);
  const plus = document.createElement("span");
  plus.className = "plus-one";
  plus.textContent = "+1";
  plus.addEventListener("animationend", () => plus.remove());
  card.el.append(plus);
  flyToCart(card);
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** The product's photo flies into the cart; where it lands the line flashes and the total bumps. */
function flyToCart(card) {
  const phone = getComputedStyle($("cartBar")).display !== "none";
  const lines = $("lines");
  const lineOf = () => lines.querySelector(`[data-line="${CSS.escape(card.item.code)}"]`);
  const land = () => {
    lineOf()?.animate([{ background: cssVar("--success-bg") }, { background: "transparent" }], { duration: 700, easing: "ease-out" });
    if (phone) {
      $("cartBar").animate(
        [{ transform: "none" }, { transform: "translateY(-7px)", offset: 0.35 }, { transform: "translateY(1px)", offset: 0.7 }, { transform: "none" }],
        { duration: 350, easing: "ease-out" },
      );
    } else {
      $("cartTotal").animate([{ transform: "none" }, { transform: "scale(1.18)", color: cssVar("--success"), offset: 0.4 }, { transform: "none" }], {
        duration: 320,
        easing: "ease-out",
      });
    }
  };
  if (reducedMotion.matches) {
    land();
    return;
  }

  let to;
  if (phone) {
    const bar = $("cartBar").getBoundingClientRect();
    to = { x: bar.left + 28, y: bar.top + bar.height / 2 };
  } else {
    // Bring the line into view inside the cart, then aim at its thumbnail.
    const line = lineOf();
    if (line) {
      const box = lines.getBoundingClientRect();
      const r = line.getBoundingClientRect();
      if (r.bottom > box.bottom) lines.scrollTop += r.bottom - box.bottom;
      else if (r.top < box.top) lines.scrollTop -= box.top - r.top;
    }
    const target = (line?.querySelector(".thumb") ?? document.querySelector('[data-panel="cart"] .ic')).getBoundingClientRect();
    to = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  }
  const from = card.faceEl.getBoundingClientRect();
  const fly = document.createElement("div");
  fly.className = "fly";
  if (card.item.img) fly.style.backgroundImage = `url("${card.item.img}")`;
  else {
    fly.style.backgroundColor = card.faceEl.style.backgroundColor;
    fly.style.color = card.faceEl.style.color;
    fly.textContent = card.item.name.slice(0, 1).toLocaleUpperCase("tr");
  }
  fly.style.left = `${from.left + from.width / 2 - 24}px`;
  fly.style.top = `${from.top + from.height / 2 - 24}px`;
  document.body.append(fly);
  const dx = to.x - (from.left + from.width / 2);
  const dy = to.y - (from.top + from.height / 2);
  fly.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0.5 }], {
    duration: 450,
    easing: "cubic-bezier(0.5, -0.3, 0.7, 1)",
  }).onfinish = () => {
    fly.remove();
    land();
  };
}

/** A confirmation card for a moment after a sale, in the payment's color; a tap or 1.4 s closes it. */
function showSaleDone(sale) {
  document.querySelector(".sale-ok")?.remove();
  const cash = sale.payment === "Nakit";
  const color = cash ? "var(--cash)" : "var(--bank)";
  const el = document.createElement("div");
  el.className = "sale-ok";
  el.innerHTML = `<div class="sale-card">
      <div class="sale-ring" style="background:${color};--ring:${color}">${icon("check")}</div>
      <b>${money(saleTotal(sale))}</b>
      <span>${icon(cash ? "cash" : "bank")}${esc(sale.payment)} · Satış #${sale.no}</span>
    </div>`;
  document.body.append(el);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener("click", close);
  setTimeout(close, 1400);
  if (cash && !reducedMotion.matches) coinBurst();
}

/** Coins burst from the middle of the screen and fall away. */
function coinBurst() {
  const x = innerWidth / 2 - 10;
  const y = innerHeight / 2 - 10;
  for (let i = 0; i < 12; i++) {
    const coin = document.createElement("div");
    coin.className = "coin";
    coin.style.left = `${x}px`;
    coin.style.top = `${y}px`;
    document.body.append(coin);
    const angle = Math.random() * Math.PI * 2;
    const dist = 110 + Math.random() * 100;
    const cx = Math.cos(angle) * dist;
    const cy = Math.sin(angle) * dist;
    coin.animate(
      [
        { transform: "translate(0, 0) scale(0.6)", opacity: 1 },
        { transform: `translate(${cx}px, ${cy - 40}px) scale(1)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${cx}px, ${cy + 60}px) scale(0.9)`, opacity: 0 },
      ],
      { duration: 900, easing: "cubic-bezier(0.2, 0.8, 0.4, 1)" },
    ).onfinish = () => coin.remove();
  }
}

// --- IBAN screen -------------------------------------------------------------

/** What the cart costs after campaigns. */
function cartTotal() {
  const lines = cartLines();
  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.unit, 0);
  return round2(subtotal - promosOf(lines).reduce((sum, p) => sum + p.amount, 0));
}

const groupIban = (iban) => iban.replace(/(.{4})/g, "$1 ").trim();

/** Checks a Turkish IBAN (TR + 24 digits, mod-97 check digits); returns it without spaces, or an error. */
function parseIban(text) {
  const iban = text.replace(/\s+/g, "").toUpperCase();
  if (!/^TR\d{24}$/.test(iban)) return { error: "IBAN TR ile başlamalı ve 26 karakter olmalı" };
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => c.charCodeAt(0) - 55);
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1 ? { iban } : { error: "Bu IBAN geçerli görünmüyor, rakamları kontrol et" };
}

/** TR Karekod field: two-digit ID, two-digit length, value. */
const karekodField = (id, value) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/** CRC-16/CCITT-FALSE over the UTF-8 bytes, as four hex digits (EMV, used by TR Karekod). */
function crc16(text) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * FAST TR Karekod for a person-to-person transfer, per TCMB's "FAST – TR
 * Karekod Teknik İlke ve Kuralları Rehberi" (May 2024, table 3): bank apps
 * scan it and fill in the IBAN, the recipient and the amount. With an amount
 * it is a dynamic code with its own reference and time; without one, static.
 *
 * Field 02 is the producer: banks use their EFT code, which is the bank code
 * in the IBAN (digits 5–9) without its leading zero, so the code carries the
 * recipient's own bank.
 */
function trKarekod({ iban, name }, amount) {
  const recipient = name.toLocaleUpperCase("tr").slice(0, 26);
  const template = karekodField("01", iban) + karekodField("07", recipient) + karekodField("10", "03");
  let payload = karekodField("75", "10") + karekodField("01", amount ? "12" : "11") + karekodField("02", iban.slice(5, 9));
  if (amount) {
    const now = new Date();
    const two = (n) => String(n).padStart(2, "0");
    const stamp = `${two(now.getFullYear() % 100)}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    payload += karekodField("03", `PLM${now.getTime().toString(36).toUpperCase()}`.slice(0, 12)) + karekodField("06", stamp);
    payload += karekodField("54", String(Math.round(amount * 100)).padStart(12, "0"));
  }
  payload += `${karekodField("61", template)}6304`;
  return payload + crc16(payload);
}

/** Recipient and IBAN for the IBAN screen; kept on this device only (and in backups), never in the published defaults. */
function ibanForm({ thenShow = false } = {}) {
  const saved = state.iban ?? { name: "", iban: "", bank: "" };
  const sheet = openSheet(`
    <h2>IBAN bilgileri</h2>
    <p class="hint">Karekod ekranı müşteriye tutarı, alıcıyı ve IBAN'ı gösterir; banka uygulaması karekodu okutunca bunlar kendiliğinden dolar. Alıcı adı hesabın sahibiyle aynı olmalı.</p>
    <label for="ibName">Alıcı adı</label>
    <input type="text" id="ibName" value="${esc(saved.name)}" autocomplete="off" />
    <label for="ibIban">IBAN</label>
    <input type="text" id="ibIban" value="${esc(groupIban(saved.iban))}" placeholder="TR00 0000 0000 0000 0000 0000 00" autocomplete="off" autocapitalize="characters" spellcheck="false" />
    <label for="ibBank">Banka (isteğe bağlı)</label>
    <input type="text" id="ibBank" value="${esc(saved.bank ?? "")}" autocomplete="off" />
    <div class="error" id="ibErr"></div>
    <div class="row">${state.iban ? `<button class="danger" id="ibDel" style="margin-right:auto">${icon("trash")}Sil</button>` : ""}<button id="ibCancel">Vazgeç</button><button class="primary" id="ibSave">Kaydet</button></div>`);
  const error = sheet.querySelector("#ibErr");
  for (const input of sheet.querySelectorAll("input")) input.addEventListener("input", () => (error.textContent = ""));
  sheet.querySelector("#ibCancel").addEventListener("click", closeSheet);
  sheet.querySelector("#ibDel")?.addEventListener("click", async () => {
    state.iban = null;
    await kv.set("iban", null);
    closeSheet();
    showToast("IBAN bilgileri silindi");
  });
  sheet.querySelector("#ibSave").addEventListener("click", async () => {
    const name = sheet.querySelector("#ibName").value.trim();
    const parsed = parseIban(sheet.querySelector("#ibIban").value);
    if (!name) {
      error.textContent = "Alıcı adını gir";
      return;
    }
    if (parsed.error) {
      error.textContent = parsed.error;
      return;
    }
    state.iban = { name, iban: parsed.iban, bank: sheet.querySelector("#ibBank").value.trim() };
    await kv.set("iban", state.iban);
    closeSheet();
    if (thenShow) ibanScreen();
    else showToast("IBAN bilgileri kaydedildi");
  });
  sheet.querySelector(saved.name ? "#ibIban" : "#ibName").focus();
}

/**
 * Full-screen page for the customer: the cart total, recipient and IBAN, and a
 * TR Karekod for bank apps, on Plumie pink whatever the theme. It
 * only shows information; the sale is still recorded with the IBAN button.
 */
function ibanScreen() {
  if (!state.iban) {
    ibanForm({ thenShow: true });
    return;
  }
  const { name, iban, bank } = state.iban;
  const total = cartTotal();
  const words = name.split(/\s+/).filter(Boolean);
  const initials = (words[0][0] + (words.length > 1 ? words.at(-1)[0] : "")).toLocaleUpperCase("tr");
  const el = document.createElement("div");
  el.className = "iban-screen";
  el.innerHTML = `
    <div class="is-top"><b class="is-brand">Plumie</b><span>IBAN ile ödeme</span><button class="is-close">${icon("x")}Kapat</button></div>
    <div class="is-main">
      <div class="is-qr">${qrSvg(trKarekod(state.iban, total))}<span class="is-fast">${icon("bolt")}FAST · TR Karekod</span></div>
      <div class="is-info">
        ${total ? `<div><div class="is-lab">Ödenecek tutar</div><div class="is-amount">${money(total)}</div></div>` : ""}
        <div class="is-who"><span class="is-avatar">${esc(initials)}</span><div><div class="is-name">${esc(name)}</div>${bank ? `<div class="is-bank">${esc(bank)}</div>` : ""}</div></div>
        <div><div class="is-lab">IBAN</div><div class="is-iban">${groupIban(iban)}</div></div>
        <button class="is-copy">${icon("copy")}<span>IBAN'ı kopyala</span></button>
        <div class="is-steps"><span><b>1</b>Banka uygulamanı aç</span><span><b>2</b>Karekod ile öde</span><span><b>3</b>Onayla</span></div>
      </div>
    </div>`;
  const close = () => {
    el.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  el.querySelector(".is-close").addEventListener("click", close);
  el.querySelector(".is-copy").addEventListener("click", async (e) => {
    const label = e.currentTarget.querySelector("span");
    try {
      await navigator.clipboard.writeText(iban);
      label.textContent = "Kopyalandı";
    } catch {
      label.textContent = "Kopyalanamadı";
    }
  });
  document.body.append(el);
}

// --- Sound -----------------------------------------------------------------

/** Per-device settings: the register sound on a sale (on by default) and a scanner beep per product (off). */
const SOUNDS = { sale: ["saleSound", true], add: ["addSound", false] };

function soundOn(kind) {
  const [key, fallback] = SOUNDS[kind];
  const saved = localStorage.getItem(key);
  return saved === null ? fallback : saved === "1";
}

/**
 * Sounds are synthesized with Web Audio, so there are no audio files to cache.
 * iOS starts audio only from a tap, so the context is created (or resumed
 * after the app was in the background) inside the tap that plays the sound.
 */
let audio = null;
function audioOut() {
  if (!audio) {
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) return null;
    audio = new Context();
    // Layers overlap; the compressor keeps their sum from clipping.
    audio.out = audio.createDynamicsCompressor();
    audio.out.connect(audio.destination);
  }
  if (audio.state !== "running") audio.resume();
  return audio;
}

/** A gain that rises to `peak` at `at` and fades out exponentially over `decay` seconds. */
function envelope(ctx, at, peak, decay, attack) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  gain.connect(ctx.out);
  return gain;
}

/** Filtered white noise: clicks, thuds and the drawer sliding. Returns the filter so it can sweep. */
function burst(ctx, at, { type, freq, q = 1, peak, decay, attack = 0.002 }) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * (attack + decay + 0.02)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  source.connect(filter).connect(envelope(ctx, at, peak, decay, attack));
  source.start(at);
  return filter;
}

/** A decaying sine, optionally gliding down to `to`: bell partials, thumps, coins. */
function tone(ctx, at, { freq, to, peak, decay, attack = 0.002 }) {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(freq, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, at + decay);
  osc.connect(envelope(ctx, at, peak, decay, attack));
  osc.start(at);
  osc.stop(at + attack + decay + 0.05);
}

/**
 * The sale sound is a recording (sale.m4a, trimmed mono AAC). It is decoded
 * once at startup in an offline context, since a live one may only start from
 * a tap; the buffer then plays in the live context.
 */
let saleRecording = null;
fetch("sale.m4a")
  .then((response) => response.arrayBuffer())
  .then((data) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(data))
  .then((buffer) => (saleRecording = buffer))
  .catch(() => {
    // The synthesized till below plays instead.
  });

/** The sale sound: the recording, or until it is decoded a synthesized till (key clunk, drawer ratchet, bell, drawer stop, coins). */
function playRegister() {
  const ctx = audioOut();
  if (!ctx) return;
  if (saleRecording) {
    const source = ctx.createBufferSource();
    source.buffer = saleRecording;
    source.connect(ctx.destination);
    source.start();
    return;
  }
  const t = ctx.currentTime + 0.01;
  burst(ctx, t, { type: "lowpass", freq: 1800, peak: 0.5, decay: 0.03 });
  tone(ctx, t, { freq: 150, to: 60, peak: 0.45, decay: 0.07 });
  for (let i = 0; i < 6; i++) burst(ctx, t + 0.03 + i * 0.017, { type: "bandpass", freq: 3200, q: 3, peak: 0.35 - i * 0.04, decay: 0.008 });
  // Bell: inharmonic partials, each doubled a few Hz apart for the shimmer.
  const bell = t + 0.07;
  burst(ctx, bell, { type: "highpass", freq: 5000, peak: 0.22, decay: 0.012 });
  for (const [ratio, peak, decay] of [[1, 0.26, 1.3], [2, 0.11, 0.9], [2.76, 0.12, 0.7], [4.07, 0.05, 0.4], [5.4, 0.035, 0.3]]) {
    tone(ctx, bell, { freq: 1760 * ratio, peak, decay });
    tone(ctx, bell, { freq: 1760 * ratio + 5, peak: peak * 0.6, decay });
  }
  const slide = burst(ctx, t + 0.1, { type: "bandpass", freq: 900, q: 1.2, peak: 0.16, decay: 0.22, attack: 0.08 });
  slide.frequency.exponentialRampToValueAtTime(300, t + 0.4);
  const stop = t + 0.38;
  tone(ctx, stop, { freq: 110, to: 45, peak: 0.55, decay: 0.14 });
  burst(ctx, stop, { type: "lowpass", freq: 700, peak: 0.4, decay: 0.06 });
  for (let i = 0; i < 9; i++) {
    tone(ctx, stop + 0.01 + Math.random() * 0.22, { freq: 4200 + Math.random() * 3800, peak: 0.03 + Math.random() * 0.04, decay: 0.05 + Math.random() * 0.08 });
  }
}

/** A barcode scanner beep: a short flat tone. */
function playBeep() {
  const ctx = audioOut();
  if (!ctx) return;
  const t = ctx.currentTime + 0.005;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = 2400;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 4000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.09, t + 0.004);
  gain.gain.setValueAtTime(0.09, t + 0.075);
  gain.gain.linearRampToValueAtTime(0, t + 0.09);
  osc.connect(filter).connect(gain).connect(ctx.out);
  osc.start(t);
  osc.stop(t + 0.1);
}

function changeQty(code, delta) {
  const qty = (state.cart.get(code) ?? 0) + delta;
  if (qty > 0) state.cart.set(code, qty);
  else state.cart.delete(code);
  renderCard(code);
  renderCart();
}

let toastTimer = null;
function showToast(text, undo) {
  clearTimeout(toastTimer);
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = undo ? "toast" : "toast solo";
  toast.innerHTML = `${icon("check-circle")}<span>${esc(text)}</span>${undo ? `<button>Geri al</button>` : ""}`;
  toast.querySelector("button")?.addEventListener("click", () => {
    toast.remove();
    undo();
  });
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), undo ? 5000 : 2500);
}

{
  const grid = $("grid");
  let timer = null;
  let longFired = false;
  let start = null;
  grid.addEventListener("pointerdown", (e) => {
    const card = e.target.closest(".card");
    longFired = false;
    if (!card || state.selecting || state.reordering) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      longFired = true;
      cardMenu(card.dataset.code);
    }, LONG_PRESS_MS);
  });
  grid.addEventListener("pointermove", (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearTimeout(timer);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    grid.addEventListener(type, () => clearTimeout(timer));
  }
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card || longFired || state.reordering) return;
    if (state.selecting) {
      const code = card.dataset.code;
      if (state.selected.has(code)) state.selected.delete(code);
      else state.selected.add(code);
      renderCard(code);
      renderSelectBar();
      return;
    }
    addToCart(card.dataset.code);
  });
  grid.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** Mouse drag scrolls the tab row on a Mac; touch scrolls it natively. */
let tabDraggedAt = 0;
{
  const tabs = $("tabs");
  let drag = null;
  tabs.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") drag = { x: e.clientX, left: tabs.scrollLeft, moved: false };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 5) {
      drag.moved = true;
      tabs.classList.add("dragging");
    }
    if (drag.moved) tabs.scrollLeft = drag.left - dx;
  });
  window.addEventListener("pointerup", () => {
    if (drag?.moved) tabDraggedAt = Date.now();
    drag = null;
    tabs.classList.remove("dragging");
  });
  // A vertical mouse wheel over the tabs scrolls them sideways.
  tabs.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        tabs.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );
  tabs.addEventListener("scroll", updateTabFades, { passive: true });
  window.addEventListener("resize", updateTabFades);
}

$("lines").addEventListener("click", (e) => {
  const plus = e.target.closest("[data-plus]");
  const minus = e.target.closest("[data-minus]");
  if (plus) changeQty(plus.dataset.plus, 1);
  if (minus) changeQty(minus.dataset.minus, -1);
});
$("received").addEventListener("input", renderCart);
$("clearCart").addEventListener("click", () => {
  state.cart.clear();
  for (const code of cards.keys()) renderCard(code);
  renderCart();
});
for (const button of document.querySelectorAll("[data-pay]")) {
  button.addEventListener("click", () => checkout(button.dataset.pay));
}
$("selectBtn").addEventListener("click", () => setSelecting(!state.selecting));
$("sortBtn").addEventListener("click", sortMenu);
$("reorderDone").addEventListener("click", () => {
  setReordering(false);
  showToast("Sıra kaydedildi");
});
$("selectDone").addEventListener("click", () => setSelecting(false));
$("selectTab").addEventListener("click", () => {
  for (const { item, el } of cards.values()) if (!el.hidden) state.selected.add(item.code);
  for (const code of cards.keys()) renderCard(code);
  renderSelectBar();
});
$("moveBtn").addEventListener("click", () => {
  if (state.selected.size) moveSheet([...state.selected]);
});

// --- Sheets ----------------------------------------------------------------

function openSheet(html) {
  $("layer").innerHTML = `<div class="scrim"><div class="sheet">${html}</div></div>`;
  const scrim = $("layer").firstElementChild;
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) closeSheet();
  });
  return scrim.firstElementChild;
}

function closeSheet() {
  $("layer").innerHTML = "";
}

/** A small menu under a button; closes on an outside tap. */
function openPopover(anchor, html) {
  const r = anchor.getBoundingClientRect();
  $("layer").innerHTML = `<div class="pop-scrim"><div class="popover" style="top:${r.bottom + 6}px;right:${Math.max(8, innerWidth - r.right)}px">${html}</div></div>`;
  const scrim = $("layer").firstElementChild;
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) closeSheet();
  });
  return scrim.firstElementChild;
}

/**
 * Reorder: a card is dragged, a ghost copy follows the finger, and the card
 * takes the place of the one under it (CSS order). On release, the visible
 * order is stored as the category's custom order. Near an edge the list scrolls.
 */
{
  const grid = $("grid");
  const main = grid.closest("main");
  let drag = null;
  const visibleCards = () => [...cards.values()].filter((c) => !c.el.hidden).sort((a, b) => a.el.style.order - b.el.style.order);

  grid.addEventListener("pointerdown", (e) => {
    if (!state.reordering) return;
    const el = e.target.closest(".card");
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add("ghost");
    Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    document.body.append(ghost);
    el.classList.add("dragging");
    drag = { el, ghost, dx: e.clientX - rect.left, dy: e.clientY - rect.top, list: visibleCards() };
    try {
      grid.setPointerCapture(e.pointerId);
    } catch {
      // Without capture, dragging still works over the grid.
    }
  });

  grid.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    const box = main.getBoundingClientRect();
    if (e.clientY > box.bottom - 70) main.scrollBy(0, 12);
    else if (e.clientY < box.top + 70) main.scrollBy(0, -12);
    const over = drag.list.find(({ el }) => {
      if (el === drag.el) return false;
      const r = el.getBoundingClientRect();
      return e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
    });
    if (!over) return;
    const from = drag.list.findIndex((c) => c.el === drag.el);
    const to = drag.list.indexOf(over);
    const [moved] = drag.list.splice(from, 1);
    drag.list.splice(to, 0, moved);
    const base = Math.min(...drag.list.map((c) => Number(c.el.style.order)));
    drag.list.forEach((c, i) => (c.el.style.order = base + i));
  });

  const end = async () => {
    if (!drag) return;
    const { list, ghost, el } = drag;
    drag = null;
    ghost.remove();
    el.classList.remove("dragging");
    list.forEach((c, i) => (state.order[c.item.code] = i));
    await kv.set("order", state.order);
    applySort();
  };
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", end);
}

function cardMenu(code) {
  itemEditor(cards.get(code).item);
}

/** Product-specific price; also opens when a product without a price is tapped (thenAdd). */
function priceForm(item, { thenAdd }) {
  const current = state.prices.get(`c:${item.code}`);
  const catPrice = state.prices.get(`k:${categoryIdOf(item)}`);
  const sheet = openSheet(`
    <h2>${esc(item.name)}</h2>
    <p class="hint">${thenAdd ? "Bu ürünün fiyatı yok. Bir kez gir, sonra hep bu fiyatla eklenir." : "Yalnızca bu ürün için geçerli."}
      ${catPrice != null ? ` Kategori fiyatı: ${money(catPrice)}.` : ` Aynı fiyat bütün kategoriye uyuyorsa "✎ Kategoriler"den kategori fiyatı gir.`}</p>
    <input inputmode="decimal" id="pValue" placeholder="45" value="${current ?? ""}" />
    <div class="error" id="pErr"></div>
    <div class="row"><button id="pCancel">Vazgeç</button><button class="primary" id="pSave">${thenAdd ? "Kaydet ve sepete ekle" : "Kaydet"}</button></div>`);
  const input = sheet.querySelector("#pValue");
  input.addEventListener("input", () => (sheet.querySelector("#pErr").textContent = ""));
  sheet.querySelector("#pCancel").addEventListener("click", closeSheet);
  sheet.querySelector("#pSave").addEventListener("click", async () => {
    const price = parseAmount(input.value);
    if (price == null || price <= 0) {
      sheet.querySelector("#pErr").textContent = "Geçerli bir fiyat gir";
      return;
    }
    await setPrice(`c:${item.code}`, round2(price));
    closeSheet();
    if (thenAdd) addToCart(item.code);
  });
  input.focus();
}

/** Add, rename, price, reorder, delete categories; products with their own price below. */
function categoriesSheet() {
  const overrides = [...state.prices]
    .filter(([key]) => key.startsWith("c:"))
    .map(([key, price]) => ({ key, price, item: cards.get(key.slice(2))?.item }))
    .filter((o) => o.item);
  const last = state.categories.length - 1;
  const sheet = openSheet(`
    <div class="head"><h2>Kategoriler</h2><button id="cClose">Bitti</button></div>
    <p class="hint">Ada dokunup değiştir. Fiyat o kategorideki bütün ürünlere uygulanır; boş bırakılırsa ilk satışta sorulur. Ürünleri taşımak için üstteki "Seç"i kullan.</p>
    <div class="cats">${state.categories
      .map(
        (c, i) => `<div class="cat-row" data-id="${c.id}">
          <button class="swatch" data-color aria-label="Renk" style="background:${colorOf(c)}"></button>
          <input type="text" data-name value="${esc(c.name)}" />
          <input inputmode="decimal" data-price placeholder="fiyat" value="${state.prices.get(`k:${c.id}`) ?? ""}" />
          <span class="sub">${countIn(c.id)} ürün</span>
          <button data-up aria-label="Yukarı" ${i === 0 ? "disabled" : ""}>↑</button>
          <button data-down aria-label="Aşağı" ${i === last ? "disabled" : ""}>↓</button>
          <button data-del class="danger" aria-label="Sil">Sil</button>
        </div>`,
      )
      .join("")}</div>
    <div class="cat-new"><input type="text" id="cNew" placeholder="Yeni kategori adı" /><button id="cAdd">+ Ekle</button></div>
    <div class="error" id="cErr"></div>
    ${overrides.length ? `<h3>Özel fiyatlı ürünler</h3><ul class="list">${overrides
      .map((o) => `<li><span>${esc(o.item.name)}</span><span><b>${money(o.price)}</b> <button data-unset="${esc(o.key)}">Kaldır</button></span></li>`)
      .join("")}</ul>` : ""}`);
  sheet.classList.add("wide");
  const err = sheet.querySelector("#cErr");
  const rowCategory = (el) => categoryById(Number(el.closest(".cat-row").dataset.id));
  sheet.querySelector("#cClose").addEventListener("click", () => {
    closeSheet();
    refreshAll();
  });
  for (const input of sheet.querySelectorAll("[data-name]")) {
    input.addEventListener("change", async () => {
      const category = rowCategory(input);
      const name = input.value.trim();
      if (!name || state.categories.some((c) => c !== category && sameName(c.name, name))) {
        err.textContent = name ? "Bu adla bir kategori var" : "Kategori adı boş olamaz";
        input.value = category.name;
        return;
      }
      err.textContent = "";
      category.name = name;
      await idb.put("categories", category);
      renderTabs();
    });
  }
  for (const input of sheet.querySelectorAll("[data-price]")) {
    input.addEventListener("change", async () => {
      const price = parseAmount(input.value);
      if (input.value.trim() !== "" && (price == null || price <= 0)) {
        err.textContent = "Geçerli bir fiyat gir ya da boş bırak";
        return;
      }
      err.textContent = "";
      await setPrice(`k:${rowCategory(input).id}`, price == null ? null : round2(price));
    });
  }
  for (const button of sheet.querySelectorAll("[data-up], [data-down]")) {
    button.addEventListener("click", async () => {
      const i = state.categories.indexOf(rowCategory(button));
      const j = button.hasAttribute("data-up") ? i - 1 : i + 1;
      const [a, b] = [state.categories[i], state.categories[j]];
      [a.order, b.order] = [b.order, a.order];
      await idb.put("categories", a);
      await idb.put("categories", b);
      state.categories.sort((x, y) => x.order - y.order);
      renderTabs();
      categoriesSheet();
    });
  }
  for (const button of sheet.querySelectorAll("[data-del]")) {
    button.addEventListener("click", () => deleteCategorySheet(rowCategory(button)));
  }
  // Color: tapping the swatch opens a palette under the row.
  for (const button of sheet.querySelectorAll("[data-color]")) {
    button.addEventListener("click", () => {
      const row = button.closest(".cat-row");
      const open = row.querySelector(".palette");
      for (const p of sheet.querySelectorAll(".palette")) p.remove();
      if (open) return;
      const category = rowCategory(button);
      row.insertAdjacentHTML(
        "beforeend",
        `<div class="palette">${PALETTE.map((c) => `<button data-pick="${c}" class="${colorOf(category) === c ? "on" : ""}" style="background:${c}" aria-label="Renk"></button>`).join("")}</div>`,
      );
      row.querySelector(".palette").addEventListener("click", async (e) => {
        const pick = e.target.closest("[data-pick]")?.dataset.pick;
        if (!pick) return;
        category.color = pick;
        await idb.put("categories", category);
        button.style.background = pick;
        row.querySelector(".palette").remove();
        for (const code of cards.keys()) renderCard(code);
        renderTabs();
        renderCart();
      });
    });
  }
  for (const button of sheet.querySelectorAll("[data-unset]")) {
    button.addEventListener("click", async () => {
      await setPrice(button.dataset.unset, null);
      categoriesSheet();
    });
  }
  const newInput = sheet.querySelector("#cNew");
  newInput.addEventListener("input", () => (err.textContent = ""));
  sheet.querySelector("#cAdd").addEventListener("click", async () => {
    const name = newInput.value.trim();
    if (!name) {
      err.textContent = "Bir ad gir";
      return;
    }
    if (state.categories.some((c) => sameName(c.name, name))) {
      err.textContent = "Bu adla bir kategori var";
      return;
    }
    await addCategory(name);
    renderTabs();
    categoriesSheet();
  });
}

function deleteCategorySheet(category) {
  const n = countIn(category.id);
  const others = state.categories.filter((c) => c !== category);
  const sheet = openSheet(`
    <h2>"${esc(category.name)}" silinsin mi?</h2>
    <p class="hint">${n ? `İçindeki ${n} ürün nereye gitsin?` : "Kategori boş."} Ürünler ve geçmiş satışlar silinmez.</p>
    ${n ? `<select id="dTarget">${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}<option value="">Kategorisiz</option></select>` : ""}
    <div class="row"><button id="dCancel">Vazgeç</button><button class="danger" id="dGo">Kategoriyi sil</button></div>`);
  sheet.querySelector("#dCancel").addEventListener("click", categoriesSheet);
  sheet.querySelector("#dGo").addEventListener("click", async () => {
    const target = sheet.querySelector("#dTarget")?.value;
    await deleteCategory(category, target ? Number(target) : null);
    showToast(`"${category.name}" silindi`);
    refreshAll();
    categoriesSheet();
  });
}

/** Moves the selected products to a category; a new category can be created here too. */
function moveSheet(codes) {
  const sheet = openSheet(`
    <h2>${codes.length === 1 ? esc(cards.get(codes[0]).item.name) : `${codes.length} ürünü taşı`}</h2>
    <p class="hint">Hedef kategoriyi seç. Fiyat yeni kategorinin fiyatı olur (özel fiyatı olanlar hariç).</p>
    <div class="stack">${state.categories
      .map(
        (c) => `<button data-to="${c.id}"><span style="display:flex;align-items:center;gap:8px"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${colorOf(c)}"></span>${esc(c.name)}</span><span class="sub">${countIn(c.id)} ürün${state.prices.get(`k:${c.id}`) != null ? ` · ${money(state.prices.get(`k:${c.id}`))}` : ""}</span></button>`,
      )
      .join("")}</div>
    <div class="cat-new"><input type="text" id="mNew" placeholder="Yeni kategori oluştur ve taşı" /><button id="mAdd">Oluştur</button></div>
    <div class="error" id="mErr"></div>
    <div class="row"><button id="mCancel">Vazgeç</button></div>`);
  const go = async (category) => {
    await moveItems(codes, category.id);
    setSelecting(false);
    state.tab = category.id;
    closeSheet();
    refreshAll();
    showToast(`${codes.length} ürün "${category.name}" kategorisine taşındı`);
  };
  for (const button of sheet.querySelectorAll("[data-to]")) {
    button.addEventListener("click", () => go(categoryById(Number(button.dataset.to))));
  }
  const input = sheet.querySelector("#mNew");
  input.addEventListener("input", () => (sheet.querySelector("#mErr").textContent = ""));
  sheet.querySelector("#mAdd").addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) {
      sheet.querySelector("#mErr").textContent = "Bir ad gir";
      return;
    }
    const existing = state.categories.find((c) => sameName(c.name, name));
    go(existing ?? (await addCategory(name)));
  });
  sheet.querySelector("#mCancel").addEventListener("click", closeSheet);
}

/** Shrinks a photo to a JPEG data: URL so full-size camera photos are never stored. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, LOCAL_IMAGE_SIZE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Fotoğraf açılamadı"));
    };
    img.src = url;
  });
}

/**
 * Every setting of a product in one sheet: name, category, price, photo, hide.
 * For a panel product the name and photo change only on this iPad and can be
 * reset to the panel's; a local product is updated in its own record and can be deleted.
 * With existing null, a new product is created.
 */
function itemEditor(existing) {
  const isNew = !existing;
  const isPanel = Boolean(existing && !existing.local);
  const code = existing?.code ?? `LOCAL-${Date.now()}`;
  let img = existing?.img ?? null;
  const currentCat = existing
    ? categoryIdOf(existing)
    : typeof state.tab === "number"
      ? state.tab
      : (state.categories[0]?.id ?? null);
  const sheet = openSheet(`
    <h2>${isNew ? "Yeni ürün" : esc(existing.name)}</h2>
    ${isNew ? "" : `<p class="hint">${esc(existing.local ? "Elle eklendi" : code)} · bu etkinlikte ${state.sold.get(code) ?? 0} adet satıldı${existing.local ? "" : ` · panelde toplam ${existing.sold ?? 0}`}</p>`}
    <label for="eName">Ad</label>
    <input type="text" id="eName" placeholder="Kurbağa prens" value="${esc(existing?.name ?? "")}" />
    ${isPanel ? `<p class="meta" style="margin-top:6px">Paneldeki adı: ${esc(existing.panelName)} · <button class="link" id="eNameReset">Panel adına dön</button></p>` : ""}
    <label for="eCat">Kategori</label>
    <select id="eCat">${state.categories
      .map((c) => `<option value="${c.id}" ${c.id === currentCat ? "selected" : ""}>${esc(c.name)}</option>`)
      .join("")}<option value="" ${currentCat == null ? "selected" : ""}>Kategorisiz</option></select>
    <label for="ePrice">Fiyat</label>
    <input inputmode="decimal" id="ePrice" value="${state.prices.get(`c:${code}`) ?? ""}" />
    <p class="meta" id="ePriceHint" style="margin-top:6px"></p>
    <label>Fotoğraf</label>
    <div class="photo">
      <div class="preview" id="ePrev"></div>
      <div class="stack" style="flex:1">
        <button id="ePick">Fotoğraf çek veya seç</button>
        <button id="eClear">Fotoğrafı kaldır</button>
        ${isPanel ? `<button id="eImgReset">Panel fotoğrafına dön</button>` : ""}
      </div>
      <input type="file" id="eFile" accept="image/*" hidden />
    </div>
    ${isNew ? "" : `<label class="check-row" style="margin-top:12px !important"><input type="checkbox" id="eHide" ${state.hidden.has(code) ? "checked" : ""} /> Ekrandan gizle</label>`}
    <div class="error" id="eErr"></div>
    <div class="row">
      ${existing?.local ? `<button class="danger" id="eDelete" style="margin-right:auto">Ürünü sil</button>` : ""}
      <button id="eCancel">Vazgeç</button>
      <button class="primary" id="eSave">${isNew ? "Ekle" : "Kaydet"}</button>
    </div>`);
  const $s = (sel) => sheet.querySelector(sel);
  const err = $s("#eErr");
  const nameInput = $s("#eName");
  const catSelect = $s("#eCat");

  const showImg = () => {
    $s("#ePrev").style.backgroundImage = img ? `url("${img}")` : "";
    $s("#ePrev").textContent = img ? "" : "Yok";
    $s("#eClear").hidden = !img;
    if (isPanel) $s("#eImgReset").hidden = img === existing.panelImg;
  };
  const showPriceHint = () => {
    const catPrice = state.prices.get(`k:${catSelect.value}`);
    $s("#ePrice").placeholder = catPrice != null ? `Kategori fiyatı ${money(catPrice)}` : "Fiyat yok";
    $s("#ePriceHint").textContent =
      catPrice != null
        ? "Boş bırakılırsa kategori fiyatından satılır."
        : "Kategorinin fiyatı yok; buraya yazmazsan ilk satışta sorulur.";
  };
  const showNameReset = () => {
    if (isPanel) $s("#eNameReset").parentElement.hidden = nameInput.value.trim() === existing.panelName;
  };
  showImg();
  showPriceHint();
  showNameReset();

  sheet.addEventListener("input", () => (err.textContent = ""));
  nameInput.addEventListener("input", showNameReset);
  catSelect.addEventListener("change", showPriceHint);
  $s("#eNameReset")?.addEventListener("click", () => {
    nameInput.value = existing.panelName;
    showNameReset();
  });
  $s("#ePick").addEventListener("click", () => $s("#eFile").click());
  $s("#eClear").addEventListener("click", () => {
    img = null;
    showImg();
  });
  $s("#eImgReset")?.addEventListener("click", () => {
    img = existing.panelImg;
    showImg();
  });
  $s("#eFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      img = await shrinkImage(file);
      showImg();
    } catch (error) {
      err.textContent = error.message;
    }
  });
  $s("#eCancel").addEventListener("click", closeSheet);
  $s("#eDelete")?.addEventListener("click", async (e) => {
    // Two steps so it is not deleted by accident. Past sales keep its name.
    if (e.target.dataset.confirm !== "1") {
      e.target.dataset.confirm = "1";
      e.target.textContent = "Emin misin? Sil";
      return;
    }
    await idb.del("locals", code);
    state.locals = state.locals.filter((l) => l.code !== code);
    state.cart.delete(code);
    await setPrice(`c:${code}`, null);
    closeSheet();
    buildGrid();
    refreshAll();
  });

  $s("#eSave").addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const priceText = $s("#ePrice").value;
    const price = parseAmount(priceText);
    if (!name) {
      err.textContent = "Bir ad gir";
      return;
    }
    if (priceText.trim() !== "" && (price == null || price <= 0)) {
      err.textContent = "Geçerli bir fiyat gir ya da boş bırak";
      return;
    }
    const categoryId = catSelect.value ? Number(catSelect.value) : null;

    if (isPanel) {
      // Store nothing when it equals the panel value, so later panel changes show.
      if (name === existing.panelName) delete state.names[code];
      else state.names[code] = name;
      if (img === existing.panelImg) delete state.images[code];
      else state.images[code] = img ?? "";
      await kv.set("names", state.names);
      await kv.set("images", state.images);
    } else {
      const createdAt = state.locals.find((l) => l.code === code)?.createdAt ?? new Date().toISOString();
      const local = { code, name, img, createdAt };
      await idb.put("locals", local);
      state.locals = isNew ? [...state.locals, local] : state.locals.map((l) => (l.code === code ? local : l));
    }

    const hide = $s("#eHide")?.checked ?? false;
    if (hide !== state.hidden.has(code)) {
      if (hide) state.hidden.add(code);
      else state.hidden.delete(code);
      await kv.set("hidden", [...state.hidden]);
    }

    buildGrid();
    if (isNew || categoryId !== currentCat) await moveItems([code], categoryId);
    await setPrice(`c:${code}`, price == null ? null : round2(price));
    if (isNew) state.tab = categoryId ?? "none";
    closeSheet();
    refreshAll();
  });
  if (isNew) nameInput.focus();
}

const tiersText = (tiers) => tiers.map((t) => `${t.qty} tane ${money(t.price)}`).join(" · ");

async function saveCampaigns() {
  await kv.set("campaigns", state.campaigns);
  renderCart();
}

function campaignsSheet() {
  const sheet = openSheet(`
    <div class="head"><h2>Kampanyalar</h2><button id="kClose">Kapat</button></div>
    <p class="hint">Kampanyadaki kategorilerin ürünleri sepette karışık sayılır ve en uygun fiyat kendiliğinden uygulanır. Bir ürün birden çok kampanyaya giriyorsa listede üstteki geçerli.</p>
    <ul class="list">${
      state.campaigns
        .map(
          (c, i) => `<li data-id="${c.id}">
            <div style="flex:1;min-width:0">
              <div>${esc(c.name)}${c.active ? "" : ' <span class="sub">· kapalı</span>'}</div>
              <div class="sub">${esc(c.categoryIds.map((id) => categoryById(id)?.name).filter(Boolean).join(", ") || "kategori yok")} · ${tiersText(c.tiers)}</div>
            </div>
            <button data-up ${i === 0 ? "disabled" : ""} aria-label="Yukarı">↑</button>
            <button data-toggle>${c.active ? "Kapat" : "Aç"}</button>
            <button data-edit>Düzenle</button>
            <button data-del class="danger">Sil</button>
          </li>`,
        )
        .join("") || "<li>Henüz kampanya yok</li>"
    }</ul>
    <div class="row"><button class="primary" id="kNew">+ Yeni kampanya</button></div>`);
  sheet.classList.add("wide");
  const of = (el) => state.campaigns.find((c) => c.id === Number(el.closest("li").dataset.id));
  sheet.querySelector("#kClose").addEventListener("click", closeSheet);
  sheet.querySelector("#kNew").addEventListener("click", () => campaignForm(null));
  for (const b of sheet.querySelectorAll("[data-edit]")) b.addEventListener("click", () => campaignForm(of(b)));
  for (const b of sheet.querySelectorAll("[data-toggle]")) {
    b.addEventListener("click", async () => {
      const c = of(b);
      c.active = !c.active;
      await saveCampaigns();
      campaignsSheet();
    });
  }
  for (const b of sheet.querySelectorAll("[data-up]")) {
    b.addEventListener("click", async () => {
      const i = state.campaigns.indexOf(of(b));
      [state.campaigns[i - 1], state.campaigns[i]] = [state.campaigns[i], state.campaigns[i - 1]];
      await saveCampaigns();
      campaignsSheet();
    });
  }
  for (const b of sheet.querySelectorAll("[data-del]")) {
    b.addEventListener("click", async () => {
      // Two steps so it is not deleted by accident. Past sales are not affected.
      if (b.dataset.confirm !== "1") {
        b.dataset.confirm = "1";
        b.textContent = "Emin misin?";
        return;
      }
      state.campaigns = state.campaigns.filter((c) => c !== of(b));
      await saveCampaigns();
      campaignsSheet();
    });
  }
}

function campaignForm(existing) {
  const tierRow = (t) => `<div class="tier-row">
      <input inputmode="numeric" data-qty value="${t?.qty ?? ""}" placeholder="adet" /><span>tane</span>
      <input inputmode="decimal" data-tprice value="${t?.price ?? ""}" placeholder="toplam ₺" />
      <button data-rm aria-label="Kademeyi sil">×</button>
    </div>`;
  // A single unit uses the category (or own) price; a campaign defines 2 and up.
  const tiers = existing?.tiers ?? [{ qty: 2 }, { qty: 3 }];
  const sheet = openSheet(`
    <h2>${existing ? "Kampanyayı düzenle" : "Yeni kampanya"}</h2>
    <label for="kName">Ad</label>
    <input type="text" id="kName" placeholder="Sticker kampanyası" value="${esc(existing?.name ?? "")}" />
    <label>Hangi kategorilerde</label>
    <div class="checks">${state.categories
      .map((c) => `<label class="check-row"><input type="checkbox" value="${c.id}" ${existing?.categoryIds.includes(c.id) ? "checked" : ""} /> ${esc(c.name)} <span class="sub">${countIn(c.id)} ürün</span></label>`)
      .join("")}</div>
    <label>Fiyatlar</label>
    <div id="kTiers">${tiers.map(tierRow).join("")}</div>
    <button id="kAddTier" style="margin-top:8px">+ Kademe ekle</button>
    <p class="hint" style="margin-top:10px">Tek ürün kendi fiyatından satılır (kategori fiyatı ₺100 ise 1 tane ₺100). Buraya 2 ve üstünü yaz: 2 tane ₺180, 3 tane ₺250. Listede olmayan adetler en uygun kombinasyonla hesaplanır (4 tane = 3 tane + 1 tane).</p>
    <p class="hint" id="kPreview"></p>
    <div class="error" id="kErr"></div>
    <div class="row"><button id="kCancel">Vazgeç</button><button class="primary" id="kSave">Kaydet</button></div>`);
  sheet.classList.add("wide");
  const err = sheet.querySelector("#kErr");
  const box = sheet.querySelector("#kTiers");

  /** The tiers in the form; returns an error message when invalid. */
  const readTiers = () => {
    const out = [];
    for (const row of box.querySelectorAll(".tier-row")) {
      const qtyText = row.querySelector("[data-qty]").value.trim();
      const priceText = row.querySelector("[data-tprice]").value.trim();
      if (!qtyText && !priceText) continue;
      const qty = Number(qtyText);
      const price = parseAmount(priceText);
      if (!Number.isInteger(qty) || qty < 2) return "Adet 2 ya da daha büyük bir tam sayı olmalı; tek ürün fiyatı kategori fiyatından gelir";
      if (!priceText) continue; // a tier without a price is ignored
      if (price == null || price <= 0) return "Geçerli bir fiyat gir";
      if (out.some((t) => t.qty === qty)) return `${qty} tane iki kez yazılmış`;
      out.push({ qty, price: round2(price) });
    }
    return out.sort((a, b) => a.qty - b.qty);
  };

  /** What 1–5 units cost at the first selected category's price; warns when it has none. */
  const preview = () => {
    const tiers = readTiers();
    const first = sheet.querySelector(".checks input:checked");
    const single = first ? state.prices.get(`k:${first.value}`) : null;
    const out = sheet.querySelector("#kPreview");
    if (!first || !Array.isArray(tiers) || !tiers.length) out.textContent = "";
    else if (single == null) out.textContent = `"${categoryById(Number(first.value)).name}" kategorisinin fiyatı yok; tek ürün fiyatını Kategoriler'den gir.`;
    else out.textContent = `Sepette: ${[1, 2, 3, 4, 5].map((n) => `${n} tane ${money(bestPrice(new Array(n).fill(single), tiers))}`).join(" · ")}`;
  };
  preview();
  sheet.addEventListener("input", () => {
    err.textContent = "";
    preview();
  });
  box.addEventListener("click", (e) => {
    if (!e.target.closest("[data-rm]")) return;
    e.target.closest(".tier-row").remove();
    preview();
  });
  sheet.querySelector("#kAddTier").addEventListener("click", () => {
    const qtys = [...box.querySelectorAll("[data-qty]")].map((i) => Number(i.value) || 0);
    box.insertAdjacentHTML("beforeend", tierRow({ qty: Math.max(0, ...qtys) + 1 }));
  });
  sheet.querySelector("#kCancel").addEventListener("click", campaignsSheet);
  sheet.querySelector("#kSave").addEventListener("click", async () => {
    const name = sheet.querySelector("#kName").value.trim();
    const categoryIds = [...sheet.querySelectorAll(".checks input:checked")].map((i) => Number(i.value));
    const tiers = readTiers();
    if (!name) return (err.textContent = "Bir ad gir");
    if (!categoryIds.length) return (err.textContent = "En az bir kategori seç");
    if (!Array.isArray(tiers)) return (err.textContent = tiers);
    if (!tiers.length) return (err.textContent = "En az bir çoklu fiyat gir (ör. 2 tane ₺180)");
    if (existing) Object.assign(existing, { name, categoryIds, tiers });
    else state.campaigns.push({ id: Date.now(), name, categoryIds, tiers, active: true });
    await saveCampaigns();
    campaignsSheet();
  });
}

function nameForm({ title, hint, value, action, onSave }) {
  const sheet = openSheet(`
    <h2>${esc(title)}</h2>
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
    <input type="text" id="nName" placeholder="Moda Pazarı" value="${esc(value)}" />
    <div class="error" id="nErr"></div>
    <div class="row"><button id="nCancel">Vazgeç</button><button class="primary" id="nSave">${esc(action)}</button></div>`);
  const input = sheet.querySelector("#nName");
  input.addEventListener("input", () => (sheet.querySelector("#nErr").textContent = ""));
  sheet.querySelector("#nCancel").addEventListener("click", closeSheet);
  sheet.querySelector("#nSave").addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) {
      sheet.querySelector("#nErr").textContent = "Bir ad gir";
      return;
    }
    await onSave(name);
    closeSheet();
    refreshAll();
  });
  input.focus();
}

/** "Event name · date", without repeating the date when the default name already has it. */
function eventTitle(event) {
  const date = dateFmt.format(new Date(event.startedAt));
  return event.name.includes(date) ? esc(event.name) : `${esc(event.name)} · ${date}`;
}

/** A product's thumbnail by code: its image, else its initial in the category color (also for deleted products). */
function productThumb(code, name, qty = 1, size = "") {
  const item = cards.get(code)?.item;
  const badge = qty > 1 ? `<b>${qty}</b>` : "";
  if (item?.img) return `<div class="pthumb ${size}" style="background-image:url(&quot;${item.img}&quot;)">${badge}</div>`;
  const color = colorOf(item ? categoryById(categoryIdOf(item)) : null);
  return `<div class="pthumb ${size}" style="background:${tint(color, 0.18)};color:${color}">${esc((item?.name ?? name).slice(0, 1).toLocaleUpperCase("tr"))}${badge}</div>`;
}

/**
 * The right panel. Sepet, Satışlar and Özet are tabs of one panel, so the
 * current event's sales and summary open beside the products and follow each
 * sale; on a phone the panel is the view the cart bar opens.
 */
function setPanel(panel) {
  state.panel = panel;
  for (const button of $("panelTabs").children) button.classList.toggle("on", button.dataset.panel === panel);
  $("cartPane").hidden = panel !== "cart";
  $("salesPane").hidden = panel !== "sales";
  $("summaryPane").hidden = panel !== "summary";
  renderPanel();
}

function renderPanel() {
  if (state.panel === "sales") renderSales();
  if (state.panel === "summary") renderSummary();
}

/** Sales of the current event as cards; tap opens the lines, deleting takes two taps or a swipe. */
function renderSales() {
  const filter = state.salesFilter;
  const pane = $("salesPane");
  const live = liveSales(state.sales);
  const sum = summarize(state.sales);
  const matches = (s, f) => f === "all" || (f === "void" ? s.voided : !s.voided && s.payment === f);
  // Voided sales come only from older versions; their filter shows only when there are some.
  const filters = [["all", "Tümü"], ["Nakit", "Nakit"], ["IBAN", "IBAN"], ...(state.sales.some((s) => s.voided) ? [["void", "İptal"]] : [])];
  const sales = [...state.sales].reverse().filter((s) => matches(s, filter));
  const card = (s) => {
    const shown = s.lines.slice(0, 5);
    const extra = s.lines.length - shown.length;
    const promo = salePromo(s);
    return `<div class="sale-row"><button class="swipe-del" data-del-now="${s.id}">${icon("trash")}Sil</button><div class="sale ${s.voided ? "void" : ""}" data-id="${s.id}">
      <div class="sale-top">
        <span class="no">#${s.no}</span><span class="time">${timeFmt.format(new Date(s.at))}</span>${payTag(s.payment)}
        ${s.voided ? `<span class="stamp">İPTAL</span>` : ""}<span class="total">${money(saleTotal(s))}</span>
      </div>
      <div class="sale-items">
        ${shown.map((l) => productThumb(l.code, l.name, l.qty)).join("")}${extra > 0 ? `<span class="more">+${extra}</span>` : ""}
        <span class="sale-tags">${promo ? `<span class="tag-chip">−${money(promo)} kampanya</span>` : ""}${s.discount ? `<span class="tag-chip plain">−${money(s.discount)} indirim</span>` : ""}</span>
      </div>
      <div class="sale-detail">
        ${s.lines
          .map(
            (l) => `<div class="dline">${productThumb(l.code, l.name, 1, "sm")}<div class="nm"><div>${esc(l.name)}</div><div>${l.qty} × ${money(l.unit)}</div></div><span class="am">${money(l.qty * l.unit)}</span></div>`,
          )
          .join("")}
        ${(s.promos ?? []).map((p) => `<div class="dline neg"><span class="badge-ic">${icon("discount")}</span><div class="nm"><div>${esc(p.name)}</div></div><span class="am">−${money(p.amount)}</span></div>`).join("")}
        ${s.discount ? `<div class="dline neg"><span class="badge-ic plain">${icon("tag")}</span><div class="nm"><div>İndirim / pazarlık</div></div><span class="am">−${money(s.discount)}</span></div>` : ""}
        <div class="sale-actions"><button data-del="${s.id}">${icon("trash")}Satışı sil</button></div>
      </div>
    </div></div>`;
  };
  const view = document.createElement("div");
  view.innerHTML = `
    <div class="stat-strip">
      ${state.showMoney ? `<div class="stat money"><div>${icon("coins")}Ciro</div><div>${money(sum.revenue)}</div></div>` : ""}
      <div class="stat"><div>${icon("receipt")}Satış</div><div>${live.length}</div></div>
      <div class="stat"><div>${icon("bag")}Ürün</div><div>${sum.items} adet</div></div>
    </div>
    <div class="filters">${filters
      .map(([k, label]) => `<button class="${k === filter ? "on" : ""}" data-filter="${k}">${label} <span class="n">${state.sales.filter((s) => matches(s, k)).length}</span></button>`)
      .join("")}</div>
    <div class="sale-list">${sales.map(card).join("") || `<p class="hint" style="text-align:center;padding:24px 0">${state.sales.length ? "Bu filtrede satış yok" : "Henüz satış yok"}</p>`}</div>
    <p class="meta">Satışı sola kaydırarak da silebilirsin. Silinen satış geri gelmez; cirodan ve satılan adetlerden düşer.</p>`;
  const scroll = pane.scrollTop;
  pane.replaceChildren(view);
  pane.scrollTop = scroll;
  // Deleting re-renders the pane (afterSalesChange).
  const remove = (id) => deleteSale(state.sales.find((s) => s.id === id), false);

  // Swipe a sale left, as on iOS: past half the button it stays open; a long swipe deletes at once.
  const OPEN = 88;
  let swipe = null;
  let swipeEndedAt = 0;
  const shut = (row) => {
    const sale = row.querySelector(".sale");
    sale.style.transform = "";
    // The red stays behind the card until it has slid back.
    setTimeout(() => {
      if (!sale.style.transform) row.classList.remove("swiped");
    }, 200);
  };
  view.addEventListener("pointerdown", (e) => {
    const sale = e.target.closest(".sale");
    // Leave the touched row alone: its Sil button lies inside it, and closing
    // the card would slide it back over the button before the tap lands.
    const touched = e.target.closest(".sale-row");
    for (const open of view.querySelectorAll(".sale-row.swiped")) if (open !== touched) shut(open);
    if (!sale || (e.pointerType === "mouse" && e.button !== 0)) return;
    const row = sale.parentElement;
    swipe = { row, sale, x: e.clientX, y: e.clientY, base: sale.style.transform ? -OPEN : 0, dx: 0, mode: null };
  });
  view.addEventListener("pointermove", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (!swipe.mode) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        swipe = null;
        return;
      }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      swipe.mode = "swipe";
      swipe.row.classList.add("swiped");
      swipe.sale.style.transition = "none";
      try {
        swipe.sale.setPointerCapture(e.pointerId);
      } catch {
        // Without capture the swipe still tracks over the card.
      }
    }
    swipe.dx = Math.min(0, swipe.base + dx);
    swipe.sale.style.transform = swipe.dx ? `translateX(${swipe.dx}px)` : "";
  });
  view.addEventListener("pointerup", () => {
    if (!swipe) return;
    const { row, sale, mode, dx } = swipe;
    swipe = null;
    if (mode !== "swipe") return;
    swipeEndedAt = Date.now();
    sale.style.transition = "";
    if (dx < -row.offsetWidth * 0.55) {
      sale.style.transform = "translateX(-100%)";
      setTimeout(() => remove(Number(sale.dataset.id)), 180);
    } else if (dx < -OPEN / 2) sale.style.transform = `translateX(-${OPEN}px)`;
    else shut(row);
  });
  view.addEventListener("pointercancel", () => {
    if (swipe?.mode === "swipe") {
      swipe.sale.style.transition = "";
      shut(swipe.row);
    }
    swipe = null;
  });

  view.addEventListener("click", async (e) => {
    const filterBtn = e.target.closest("[data-filter]");
    if (filterBtn) {
      state.salesFilter = filterBtn.dataset.filter;
      renderSales();
      return;
    }
    const now = e.target.closest("[data-del-now]");
    if (now) return remove(Number(now.dataset.delNow));
    const delBtn = e.target.closest("[data-del]");
    if (delBtn) {
      // Two steps so a sale is not deleted by accident while scrolling.
      if (!delBtn.classList.contains("sure")) {
        delBtn.classList.add("sure");
        delBtn.innerHTML = `${icon("trash")}Emin misin? Sil`;
        return;
      }
      await remove(Number(delBtn.dataset.del));
      return;
    }
    const sale = e.target.closest(".sale");
    // The end of a swipe is not a tap; a tap on a swiped-open sale closes it.
    if (!sale || Date.now() - swipeEndedAt < 400) return;
    if (sale.style.transform) shut(sale.parentElement);
    else sale.classList.toggle("open");
  });
}

/**
 * An event's summary: revenue, payment split, categories, best sellers. Sale
 * times stay in the data (sales list, CSV). `toggleAll` shows all products or
 * the top six; `deleted` runs after the event is deleted.
 */
async function summaryView(event, showAll, { toggleAll, deleted }) {
  const sales = event.id === state.event.id ? state.sales : await salesOf(event.id);
  const sum = summarize(sales);
  const live = liveSales(sales);
  const show = state.showMoney;
  const times = live.map((s) => new Date(s.at));

  // Units per category, by each product's current category.
  const perCat = new Map();
  for (const sale of live) {
    for (const line of sale.lines) {
      const item = cards.get(line.code)?.item;
      const cat = item ? categoryById(categoryIdOf(item)) : null;
      const key = cat?.id ?? "none";
      const row = perCat.get(key) ?? { name: cat?.name ?? "Kategorisiz", color: colorOf(cat), qty: 0 };
      row.qty += line.qty;
      perCat.set(key, row);
    }
  }

  const products = show ? sum.products : [...sum.products].sort((a, b) => b.qty - a.qty);
  const shown = showAll ? products : products.slice(0, 6);
  const best = Math.max(1, ...shown.map((r) => (show ? r.amount : r.qty)));
  const cash = sum.byPayment.get("Nakit") ?? 0;
  const bank = sum.byPayment.get("IBAN") ?? 0;
  const pct = (n) => (sum.revenue ? Math.round((n / sum.revenue) * 100) : 0);
  const range = times.length ? ` · ${timeFmt.format(times[0])} – ${timeFmt.format(times.at(-1))}` : "";

  const view = document.createElement("div");
  view.innerHTML = `
    <div class="sub-title">${eventTitle(event)}${range}${sum.voided ? ` · ${sum.voided} satış iptal edildi` : ""}</div>
    <div class="hero">
      ${show
        ? `<div><div class="label">${icon("coins")}Ciro</div><div class="big">${money(sum.revenue)}</div></div>`
        : `<div><div class="label">${icon("receipt")}Satış</div><div class="big plain">${sum.count}</div></div>`}
      <div class="side">
        ${show ? `<div><b>${sum.count}</b><span>satış</span></div>` : ""}
        <div><b>${sum.items}</b><span>ürün</span></div>
        ${show ? `<div><b>${money(sum.count ? round2(sum.revenue / sum.count) : 0)}</b><span>ort. sepet</span></div>` : ""}
      </div>
    </div>
    ${show && sum.revenue ? `<div class="section"><div class="section-title">${icon("wallet")}Ödeme</div>
      <div class="split"><div style="width:${pct(cash)}%;background:var(--cash)"></div><div style="width:${pct(bank)}%;background:var(--bank)"></div></div>
      <div class="legend"><span class="cash">${icon("cash")}<b>${money(cash)}</b><em>Nakit · %${pct(cash)}</em></span><span class="bank"><em>%${pct(bank)} · IBAN</em><b>${money(bank)}</b>${icon("bank")}</span></div>
    </div>` : ""}
    ${perCat.size ? `<div class="section"><div class="section-title">${icon("layers")}Kategoriler</div>
      <div class="cat-chips">${[...perCat.values()].sort((a, b) => b.qty - a.qty).map((c) => `<span class="cat-chip"><span class="dot" style="background:${c.color}"></span>${esc(c.name)} <b>${c.qty}</b></span>`).join("")}</div>
    </div>` : ""}
    <div class="section"><div class="section-title">${icon("trophy")}Çok satanlar</div>
      <div class="ranks">${shown
        .map((r, i) => {
          const value = show ? r.amount : r.qty;
          const item = cards.get(r.code)?.item;
          const color = colorOf(item ? categoryById(categoryIdOf(item)) : null);
          return `<div class="rank"><span class="rk ${i < 3 ? "medal" : ""}">${i + 1}</span>${productThumb(r.code, r.name)}
            <div class="mid"><div>${esc(r.name)}</div><div class="track"><div style="width:${(value / best) * 100}%;background:${color}"></div></div></div>
            <div class="num"><b>${show ? money(r.amount) : `${r.qty} adet`}</b>${show ? `<span>${r.qty} adet</span>` : ""}</div></div>`;
        })
        .join("") || `<p class="hint">Henüz satış yok</p>`}</div>
      ${products.length > 6 ? `<div class="row" style="justify-content:center;margin-top:10px"><button id="yAll">${showAll ? "Daha az göster" : `Tümünü göster (${products.length})`}</button></div>` : ""}
    </div>
    ${show
      ? sum.promo || sum.discount
        ? `<div class="notes">${sum.promo ? `<span>${icon("discount")}Kampanya indirimi ${money(sum.promo)}</span>` : ""}${sum.discount ? `<span>${icon("tag")}Elle indirim ${money(sum.discount)}</span>` : ""}<span>Ürün tutarları indirim öncesi</span></div>`
        : ""
      : `<div class="notes">Ciro ve tutarlar gizli; menüden açılabilir.</div>`}
    <div class="row"><button class="danger" id="yDel" style="margin-right:auto">${icon("trash")}Etkinliği sil</button><button class="primary" id="yCsv" ${sum.count ? "" : "disabled"}>${icon("download")}CSV</button></div>`;
  view.querySelector("#yCsv").addEventListener("click", () => exportCsv(event, sales));
  view.querySelector("#yAll")?.addEventListener("click", toggleAll);
  // Two steps, like deleting a sale.
  view.querySelector("#yDel").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    if (!button.classList.contains("sure")) {
      button.classList.add("sure");
      button.innerHTML = `${icon("trash")}${sum.count ? `${sum.count} satışıyla silinsin mi?` : "Emin misin? Sil"}`;
      return;
    }
    await deleteEvent(event);
    showToast(`"${event.name}" silindi`);
    deleted();
  });
  return view;
}

/** The current event's summary in the panel. */
async function renderSummary() {
  const view = await summaryView(state.event, state.summaryAll, {
    toggleAll: () => {
      state.summaryAll = !state.summaryAll;
      renderSummary();
    },
    // Deleting the current event re-renders the panel (afterSalesChange).
    deleted: () => {},
  });
  // A sale or a tab change may have come in while the past sales loaded.
  if (state.panel === "summary") $("summaryPane").replaceChildren(view);
}

/** A summary from the event history, as a sheet. */
async function summarySheet(event, showAll = false) {
  const view = await summaryView(event, showAll, { toggleAll: () => summarySheet(event, !showAll), deleted: historySheet });
  const sheet = openSheet(`<div class="head"><h2>Özet</h2><button id="yBack">Geri</button></div>`);
  sheet.classList.add("wide");
  sheet.append(view);
  sheet.querySelector("#yBack").addEventListener("click", historySheet);
}



async function historySheet() {
  const events = (await idb.all("events")).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const rows = await Promise.all(events.map(async (ev) => ({ ev, sum: summarize(await salesOf(ev.id)) })));
  const sheet = openSheet(`
    <div class="head"><h2>Geçmiş etkinlikler</h2><button id="hClose">Kapat</button></div>
    <div class="group-box" style="margin-top:12px">${rows
      .map(
        ({ ev, sum }) => `<button class="mrow" data-id="${ev.id}">
          <span class="mbadge" style="background:var(--orange)">${icon("tent")}</span>
          <span class="tx">${esc(ev.name)}${ev.id === state.event.id ? " · şu an" : ""}<small>${dateFmt.format(new Date(ev.startedAt))} · ${sum.count} satış · ${sum.items} ürün</small></span>
          ${state.showMoney ? `<span class="val">${money(sum.revenue)}</span>` : ""}${icon("chevron")}
        </button>`,
      )
      .join("")}</div>`);
  sheet.querySelector("#hClose").addEventListener("click", closeSheet);
  for (const button of sheet.querySelectorAll("[data-id]")) {
    button.addEventListener("click", () => summarySheet(events.find((ev) => ev.id === Number(button.dataset.id))));
  }
}

const relativeFmt = new Intl.RelativeTimeFormat("tr", { numeric: "auto" });
/** "3 saat önce", "dün" … */
function ago(iso) {
  const minutes = Math.round((new Date(iso) - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return relativeFmt.format(minutes, "minute");
  if (Math.abs(minutes) < 60 * 24) return relativeFmt.format(Math.round(minutes / 60), "hour");
  return relativeFmt.format(Math.round(minutes / 1440), "day");
}

const THEMES = [
  ["system", "Sistem", ["#f9f9f7", "#0d0d0d"]],
  ["light", "Açık", ["#f9f9f7", "#fcfcfb"]],
  ["dark", "Koyu", ["#0d0d0d", "#1a1a19"]],
  ["plumie", "Plumie", ["#6b0912", "#7c1019"]],
];

/** Settings-style menu: event card, backup reminder, grouped rows, appearance. */
async function mainMenu() {
  const theme = localStorage.getItem("theme") ?? "system";
  const size = localStorage.getItem("cardSize") ?? "m";
  const lastBackup = localStorage.getItem("lastBackupAt");
  // Data lives only on this iPad: nag when sales happened since the last backup.
  const unsaved = (await idb.all("sales")).filter((s) => !lastBackup || s.at > lastBackup).length;
  const sum = summarize(state.sales);
  const activeCampaigns = state.campaigns.filter((c) => c.active).length;
  const eventCount = (await idb.all("events")).length;
  const row = (act, color, iconName, title, sub, value = "", extra = "") =>
    `<button class="mrow ${extra}" data-act="${act}"><span class="mbadge" style="background:${color}">${icon(iconName)}</span><span class="tx">${title}${sub ? `<small>${sub}</small>` : ""}</span>${value ? `<span class="val">${value}</span>` : ""}${icon("chevron")}</button>`;
  const soundRow = (kind, color, iconName, title, sub) =>
    `<div class="mrow static"><span class="mbadge" style="background:${color}">${icon(iconName)}</span><span class="tx">${title}<small>${sub}</small></span><button class="switch ${soundOn(kind) ? "on" : ""}" data-sound="${kind}" role="switch" aria-checked="${soundOn(kind)}" aria-label="${title}"></button></div>`;
  const sheet = openSheet(`
    <div class="head"><h2>Menü</h2><button data-act="close">Kapat</button></div>
    <div class="event-card">
      <span class="icon-box">${icon("tent")}</span>
      <span class="t"><b>${esc(state.event.name)}</b><span>${dateFmt.format(new Date(state.event.startedAt))} · ${sum.count} satış${state.showMoney ? ` · <span class="rev">${money(sum.revenue)}</span>` : ""}</span></span>
      <button data-act="new">${icon("calendar-plus")}Yeni etkinlik</button>
    </div>
    ${unsaved ? `<div class="backup-warn">${icon("alert")}<span>${lastBackup ? `Son yedekten sonra ${unsaved} satış yapıldı · son yedek ${ago(lastBackup)}` : `Henüz yedek alınmadı · ${unsaved} satış yalnızca bu cihazda`}</span><button data-act="backup">Yedek al</button></div>` : ""}
    <div class="group"><div class="group-title">Ürünler</div><div class="group-box">
      ${row("categories", "#7f77dd", "layers", "Kategoriler ve fiyatlar", `${state.categories.length} kategori · renk, sıra, fiyat`)}
      ${row("campaigns", "var(--cash)", "discount", "Kampanyalar", "", activeCampaigns ? `${activeCampaigns} açık` : "")}
      ${row("hidden", "#8a8780", "eye-off", state.showHidden ? "Gizlenenleri sakla" : "Gizlenen ürünler", state.showHidden ? "Gizli ürünler şu an ekranda soluk görünüyor" : "Ekranda göstermek için dokun", String(state.hidden.size))}
    </div></div>
    <div class="group"><div class="group-title">Etkinlik</div><div class="group-box">
      ${row("history", "var(--orange)", "history", "Geçmiş etkinlikler", "Her etkinliğin özeti ve CSV", String(eventCount))}
    </div></div>
    <div class="group"><div class="group-title">Ödeme</div><div class="group-box">
      ${row("iban", "var(--bank)", "qr", "IBAN bilgileri", state.iban ? `${esc(state.iban.name)} · ${groupIban(state.iban.iban).slice(-9)}` : "IBAN karekod ekranı için alıcı ve IBAN")}
    </div></div>
    <div class="group"><div class="group-title">Veri</div><div class="group-box">
      ${row("backup", "var(--bank)", "download", "Tam yedek al", "Dosyalar'a kaydet", lastBackup ? ago(lastBackup) : "hiç")}
      ${row("restore", "#378add", "upload", "Yedekten geri yükle", "Bu cihazdaki veriyi yedektekiyle değiştirir")}
      ${DATA.defaults ? row("defaults", "#5f5e5a", "refresh", "Varsayılan ayarları yükle", `${dateFmt.format(new Date(DATA.defaults.savedAt))} ayarları · satışlar korunur`) : ""}
    </div></div>
    <div class="group"><div class="group-title">Görünüm</div><div class="group-box">
      <div class="theme-pick">${THEMES.map(([k, label, [a, b]]) => `<button data-theme="${k}" class="${theme === k ? "on" : ""}"><span class="pv"><span style="background:${a}"></span><span style="background:${b}"></span></span>${label}</button>`).join("")}</div>
      <div class="size-pick">${[["s", "Küçük", "grid-s"], ["m", "Orta", "grid-m"], ["l", "Büyük", "grid-l"]].map(([k, label, ic]) => `<button data-cards="${k}" class="${size === k ? "on" : ""}">${icon(ic)}${label}</button>`).join("")}</div>
      <div class="mrow static" style="border-top:1px solid var(--border)"><span class="mbadge" style="background:var(--orange)">${icon("coins")}</span><span class="tx">Ciro ve tutarları göster<small id="moneyHint">${state.showMoney ? "Üstte ciro, özette toplamlar görünür" : "Ekran müşteriye dönükken kapalı tut"}</small></span><button class="switch ${state.showMoney ? "on" : ""}" id="moneySwitch" role="switch" aria-checked="${state.showMoney}" aria-label="Ciro ve tutarları göster"></button></div>
    </div></div>
    <div class="group"><div class="group-title">Ses</div><div class="group-box">
      ${soundRow("sale", "var(--cash)", "volume", "Satışta kasa sesi", "Nakit veya IBAN'a basınca kasa açılır")}
      ${soundRow("add", "#378add", "scan", "Ürün eklerken bip", "Her ürün sepete eklendiğinde barkod sesi")}
    </div></div>
    <div class="menu-foot"><b>Plumie</b> Yazar Kasa<br>Ürün listesi ${DATA.generatedAt ? dateTimeFmt.format(new Date(DATA.generatedAt)) : "yok"} · ${DATA.components.length + state.locals.length} ürün</div>`);
  sheet.addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    if (button.dataset.theme) {
      setTheme(button.dataset.theme);
      for (const b of sheet.querySelectorAll("[data-theme]")) b.classList.toggle("on", b === button);
      return;
    }
    if (button.dataset.cards) {
      const cardSize = button.dataset.cards;
      localStorage.setItem("cardSize", cardSize);
      if (cardSize === "m") delete document.documentElement.dataset.cards;
      else document.documentElement.dataset.cards = cardSize;
      for (const b of sheet.querySelectorAll("[data-cards]")) b.classList.toggle("on", b === button);
      return;
    }
    if (button.dataset.sound) {
      const kind = button.dataset.sound;
      const on = !soundOn(kind);
      localStorage.setItem(SOUNDS[kind][0], on ? "1" : "0");
      button.classList.toggle("on", on);
      button.setAttribute("aria-checked", on);
      // Turning one on plays it, so the volume can be checked right there.
      if (on) (kind === "sale" ? playRegister : playBeep)();
      return;
    }
    if (button.id === "moneySwitch") {
      state.showMoney = !state.showMoney;
      localStorage.setItem("showMoney", state.showMoney ? "1" : "0");
      button.classList.toggle("on", state.showMoney);
      button.setAttribute("aria-checked", state.showMoney);
      sheet.querySelector("#moneyHint").textContent = state.showMoney ? "Üstte ciro, özette toplamlar görünür" : "Ekran müşteriye dönükken kapalı tut";
      renderHeader();
      renderPanel();
      return;
    }
    const act = button.dataset.act;
    if (act === "close") closeSheet();
    if (act === "categories") categoriesSheet();
    if (act === "campaigns") campaignsSheet();
    if (act === "history") historySheet();
    if (act === "backup") backup().then((saved) => saved && closeSheet());
    if (act === "restore") restorePick();
    if (act === "iban") ibanForm();
    if (act === "defaults") defaultsSheet();
    if (act === "hidden") {
      state.showHidden = !state.showHidden;
      closeSheet();
      refreshAll();
    }
    if (act === "new") {
      nameForm({
        title: "Yeni etkinlik",
        hint: `"${state.event.name}" geçmişe kaydedilir, yeni etkinlik sıfırdan başlar. Fiyatlar aynı kalır.`,
        value: "",
        action: "Başlat",
        onSave: async (name) => {
          state.event = await startEvent(name);
          state.sales = [];
          state.sold = new Map();
          state.cart.clear();
        },
      });
    }
  });
}

function setTheme(theme) {
  localStorage.setItem("theme", theme);
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  syncThemeColor();
}

/** Match the status bar and browser chrome to the background. */
function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]').content = bg;
}

// --- Export and backup -------------------------------------------------------

/**
 * The share sheet on an iPad (save to Files), a plain download on a computer.
 * Chrome on macOS claims to support sharing but can fail silently without a
 * sheet, so sharing is used only on touch devices and any error other than
 * dismissing it falls back to a download.
 */
/** Resolves true once the file was shared or downloaded, false if the share sheet was dismissed. */
async function shareFile(file) {
  if (navigator.maxTouchPoints > 0 && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return true;
    } catch (error) {
      if (error?.name === "AbortError") return false; // share sheet dismissed
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(`${file.name} indirildi`);
  return true;
}

const slug = (s) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "etkinlik";

/**
 * One row per sale line; discounts are separate rows (negative amounts) so the
 * amount column sums to revenue. Decimal comma for Turkish Excel.
 */
function exportCsv(event, sales) {
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const num = (n) => String(round2(n)).replace(".", ",");
  const rows = [["satis_no", "tarih", "saat", "odeme", "kod", "urun", "adet", "birim_fiyat", "tutar"].join(";")];
  for (const sale of liveSales(sales)) {
    const at = new Date(sale.at);
    const head = [sale.no, at.toLocaleDateString("tr-TR"), timeFmt.format(at), cell(sale.payment)];
    for (const line of sale.lines) {
      rows.push([...head, cell(line.code), cell(line.name), line.qty, num(line.unit), num(line.qty * line.unit)].join(";"));
    }
    for (const promo of sale.promos ?? []) rows.push([...head, "", cell(`Kampanya: ${promo.name}`), "", "", num(-promo.amount)].join(";"));
    if (sale.discount) rows.push([...head, "", cell("İndirim"), "", "", num(-sale.discount)].join(";"));
  }
  // BOM so Excel reads Turkish characters correctly.
  const file = new File(["﻿" + rows.join("\n")], `${slug(event.name)}-${event.startedAt.slice(0, 10)}.csv`, { type: "text/csv" });
  shareFile(file);
}

async function backup() {
  const data = { app: "plumie-event-counter", format: BACKUP_FORMAT, exportedAt: new Date().toISOString() };
  for (const store of STORES) data[store] = await idb.all(store);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const saved = await shareFile(new File([JSON.stringify(data)], `plumie-kasa-yedek-${stamp}.json`, { type: "application/json" }));
  // The menu's backup reminder counts sales after this moment.
  if (saved) localStorage.setItem("lastBackupAt", data.exportedAt);
  return saved;
}

function restorePick() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      data = null;
    }
    // Format 1 had no categories; treat as empty, they are rebuilt from families on open.
    if (data?.format === 1) data.categories ??= [];
    if (data?.app !== "plumie-event-counter" || ![1, BACKUP_FORMAT].includes(data.format) || !STORES.every((s) => Array.isArray(data[s]))) {
      openSheet(`<h2>Yedek okunamadı</h2><p class="hint">Bu dosya bir Plumie Yazar Kasa yedeği değil ya da bozuk.</p><div class="row"><button id="rOk">Tamam</button></div>`)
        .querySelector("#rOk")
        .addEventListener("click", closeSheet);
      return;
    }
    restoreConfirm(data);
  });
  input.click();
}

function restoreConfirm(data) {
  const live = data.sales.filter((s) => !s.voided);
  const sheet = openSheet(`
    <h2>Yedekten geri yükle</h2>
    <p class="hint">${dateTimeFmt.format(new Date(data.exportedAt))} tarihli yedek: ${data.events.length} etkinlik, ${live.length} satış, ${data.categories.length} kategori, ${data.locals.length} elle eklenen ürün, ${data.prices.length} fiyat.</p>
    <p class="hint" style="color:var(--danger)">Bu cihazdaki bütün kasa verisi silinip yedektekiyle değiştirilecek.</p>
    <div class="row"><button id="rCancel">Vazgeç</button><button class="primary" id="rGo">Geri yükle</button></div>`);
  sheet.querySelector("#rCancel").addEventListener("click", closeSheet);
  sheet.querySelector("#rGo").addEventListener("click", async () => {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, "readwrite");
      for (const store of STORES) {
        const s = tx.objectStore(store);
        s.clear();
        for (const row of data[store]) s.put(row);
      }
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    location.reload();
  });
}

// --- Updates -----------------------------------------------------------------

/** When online, compares with the published version and offers an update if it differs. */
async function checkForUpdate() {
  if (!navigator.serviceWorker?.controller || !navigator.onLine) return;
  try {
    const [installed, latest] = await Promise.all([
      fetch("version.json").then((r) => r.json()),
      fetch(`version.json?fresh=${Date.now()}`, { cache: "no-store" }).then((r) => r.json()),
    ]);
    if (installed.version === latest.version) return;
    const banner = $("banner");
    banner.innerHTML = `<span>Yeni sürüm var (${latest.count} ürün). Satışlar, fiyatlar ve eklediklerin korunur.</span><button>Güncelle</button>`;
    banner.hidden = false;
    banner.querySelector("button").addEventListener("click", applyUpdate);
  } catch {
    // Offline or the site is unreachable: quietly keep the current version.
  }
}

function applyUpdate() {
  const banner = $("banner");
  banner.innerHTML = "<span>Güncelleniyor…</span>";
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => {
    if (data.ok) {
      location.reload();
      return;
    }
    // sw.js reports "stale" (deploy not fully live yet) or "network".
    const reason = data.error === "stale" ? "yayın henüz tamamlanmamış, birkaç dakika sonra tekrar dene" : "internet bağlantısını kontrol et";
    banner.innerHTML = `<span>Güncellenemedi: ${reason}. Mevcut sürüm çalışmaya devam ediyor.</span><button>Tekrar dene</button>`;
    banner.querySelector("button").addEventListener("click", applyUpdate);
  };
  navigator.serviceWorker.controller.postMessage({ type: "refresh" }, [channel.port2]);
}

// --- Startup ---------------------------------------------------------------

$("eventBtn").addEventListener("click", () =>
  nameForm({
    title: "Etkinliğin adı",
    value: state.event.name,
    action: "Kaydet",
    onSave: async (name) => {
      state.event = { ...state.event, name };
      await idb.put("events", state.event);
    },
  }),
);
$("addBtn").addEventListener("click", () => itemEditor(null));
// Phone: the header's sales button opens the panel sheet on its sales tab.
$("salesBtn").addEventListener("click", () => {
  setPanel("sales");
  setCartOpen(true);
});
$("ibanQr").addEventListener("click", ibanScreen);
$("panelTabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-panel]");
  if (tab) setPanel(tab.dataset.panel);
});
$("menuBtn").addEventListener("click", mainMenu);
$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  $("searchClear").hidden = !state.query;
  applyFilter();
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSearch();
  // "Ara" on the keyboard only hides it; the results stay.
  if (e.key === "Enter") e.target.blur();
});
$("searchClear").addEventListener("click", clearSearch);
// Phone: search hides behind an icon and covers the header row while open.
$("searchToggle").addEventListener("click", () => {
  document.querySelector("header").classList.add("searching");
  $("search").focus();
});
$("search").addEventListener("blur", () => {
  if (!state.query) document.querySelector("header").classList.remove("searching");
});
$("cartBar").addEventListener("click", () => {
  setPanel("cart");
  setCartOpen(true);
});
$("cartScrim").addEventListener("click", () => setCartOpen(false));
$("tabs").addEventListener("click", (e) => {
  if (e.target.closest("#editCats")) {
    categoriesSheet();
    return;
  }
  const tab = e.target.closest("[data-tab]");
  if (!tab || Date.now() - tabDraggedAt < 300) return;
  if (state.reordering) {
    showToast('Önce "Bitti"ye bas');
    return;
  }
  const key = tab.dataset.tab;
  state.tab = key === "all" || key === "none" ? key : Number(key);
  // Only the highlight moves; rebuilding the row mid-scroll is what upsets iPad Safari.
  for (const t of $("tabs").querySelectorAll("[data-tab]")) t.classList.toggle("on", t === tab);
  centerActiveTab(true);
  applyFilter();
});

// First open: start from the default setup if there is one, else build from panel families (seedCategories).
if (DATA.defaults && !(await kv.get("categoriesSeeded", false))) await applyDefaults(DATA.defaults);
state.locals = (await idb.all("locals")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
state.hidden = new Set(await kv.get("hidden", []));
state.iban = await kv.get("iban", null);
state.prices = new Map((await idb.all("prices")).map((p) => [p.key, p.price]));
await seedCategories();
await loadCategories();
await loadEvent();
buildGrid();
refreshAll();
renderSelectBar();
syncThemeColor();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeColor);

if (!window.PLUMIE_DATA) {
  const banner = $("banner");
  banner.innerHTML = "<span>Ürün listesi yüklenemedi (data.js yok). Elle eklediklerin yine çalışır.</span>";
  banner.hidden = false;
}

// Safari may evict data of unused sites; ask for persistent storage.
navigator.storage?.persist?.();
started = true;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(checkForUpdate, () => {});
}
