// src/scout/overlay.js — persistent in-browser overlay for competitor scouting.
// Scraping is done via in-browser fetch() (same-origin, uses real eBay cookies)
// so eBay never sees a new Puppeteer tab hitting the sold-search URL = no CAPTCHA.

const Pipeline = require('../fill/pipeline');
const DB       = require('../shared/db');
const Vero     = require('./vero');

let opts        = { days: 14, minSold: 1 };
let notify      = () => {};
let sweepTimer  = null;
let trackedPages = new WeakSet();

// ── Overlay injected into the browser page ─────────────────────
// Scraping runs entirely in-browser via fetch() — same-origin request with
// real session cookies so eBay treats it as normal user activity (no CAPTCHA).
function buildOverlayJS(days, minSold) {
  return `
(() => {
  if (window.__zdOverlay) return;
  window.__zdOverlay = true;

  // ── UI ────────────────────────────────────────────────────────
  const box = document.createElement('div');
  box.id = '__zd_overlay';
  box.style.cssText = [
    'position:fixed','bottom:18px','right:18px','z-index:2147483647',
    'background:#0a0a0b','border:1px solid #f0a832','border-radius:8px',
    'padding:12px 14px','font-family:Space Mono,monospace','font-size:12px',
    'color:#e8e4d8','box-shadow:0 8px 30px rgba(0,0,0,.7)','min-width:240px',
    'user-select:none'
  ].join(';');
  box.innerHTML = \`
    <div style="color:#f0a832;font-weight:700;letter-spacing:.08em;margin-bottom:8px">◈ ZAYNDROP SCOUT</div>
    <div id="__zd_seller" style="margin-bottom:8px;color:#7a7870;font-size:11px">detecting seller...</div>
    <button id="__zd_pull" style="width:100%;background:#f0a832;border:none;border-radius:4px;color:#0a0a0b;font-family:inherit;font-weight:700;font-size:12px;padding:8px;cursor:pointer">⬇ PULL PRODUCTS</button>
    <div style="margin-top:6px;display:flex;gap:6px">
      <button id="__zd_refresh" style="flex:1;background:#1a1a1c;border:1px solid #333;border-radius:4px;color:#7a7870;font-family:inherit;font-size:10px;padding:4px;cursor:pointer">↻ refresh</button>
      <button id="__zd_hide"    style="flex:1;background:#1a1a1c;border:1px solid #333;border-radius:4px;color:#7a7870;font-family:inherit;font-size:10px;padding:4px;cursor:pointer">hide</button>
    </div>
    <div id="__zd_status" style="font-size:10px;color:#7a7870;margin-top:6px;line-height:1.5"></div>
  \`;
  document.documentElement.appendChild(box);

  // ── Seller detection ─────────────────────────────────────────
  function detectSeller() {
    let m;
    m = location.search.match(/[?&]_ssn=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    m = location.pathname.match(/^\\/usr\\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]);
    m = location.pathname.match(/^\\/str\\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const usrA = document.querySelector('a[href*="/usr/"]');
    if (usrA) { m = usrA.href.match(/\\/usr\\/([^/?#]+)/); if (m) return decodeURIComponent(m[1]); }
    const fbA = document.querySelector('a[href*="feedback_profile"]');
    if (fbA) { m = fbA.href.match(/feedback_profile\\/([^/?#]+)/); if (m) return decodeURIComponent(m[1]); }
    const ssnA = document.querySelector('a[href*="_ssn="]');
    if (ssnA) { m = ssnA.href.match(/[?&]_ssn=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
    const card = document.querySelector('.x-sellercard-atf__info__about-seller a, [data-testid="x-sellercard-atf"] a, .ux-seller-section__item--seller a');
    if (card) return card.textContent.trim();
    return null;
  }

  let currentSeller = null;
  function refresh() {
    currentSeller = detectSeller();
    const el  = document.getElementById('__zd_seller');
    const btn = document.getElementById('__zd_pull');
    if (!el || !btn) return;
    if (currentSeller) {
      el.innerHTML = 'seller: <b style="color:#f0a832">' + currentSeller + '</b>';
      btn.disabled = false; btn.style.opacity = '1';
    } else {
      el.textContent = 'no seller — browse to a store or listing';
      btn.disabled = true; btn.style.opacity = '0.35';
    }
  }
  refresh();

  // Re-detect on SPA route changes
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; refresh(); } }, 800);

  // ── In-browser scrape via fetch (no new tab, uses real cookies) ─
  async function scrapeSoldListings(seller) {
    const days    = ${days};
    const minSold = ${minSold};
    const url     = '/sch/i.html?_ssn=' + encodeURIComponent(seller) + '&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=240';

    const setStatus = (t) => { const el = document.getElementById('__zd_status'); if (el) el.textContent = t; };
    setStatus('⟳ fetching sold listings...');

    const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
    const doc  = new DOMParser().parseFromString(html, 'text/html');

    // CAPTCHA / bot-check detect
    if (doc.querySelector('form[action*="captcha"], #captcha, .g-recaptcha') ||
        /verify you are a human|robot check/i.test(doc.body?.innerText || '')) {
      throw new Error('eBay returned a CAPTCHA — try navigating to the seller page manually first, then pull again');
    }

    const items = [...doc.querySelectorAll('.s-item')].map(it => {
      const title = it.querySelector('.s-item__title')?.textContent?.trim() || '';
      if (!title || /shop on ebay/i.test(title)) return null;
      const price    = parseFloat((it.querySelector('.s-item__price')?.textContent || '').replace(/[$,]/g, '')) || 0;
      const link     = it.querySelector('a.s-item__link')?.href || '';
      const itemId   = (link.match(/\\/itm\\/(\\d+)/) || [])[1] || '';
      const soldDate = (it.textContent.match(/Sold\\s+([A-Z][a-z]{2} \\d{1,2}, \\d{4})/) || [])[1] || '';
      return { title, price, itemId, soldDate };
    }).filter(Boolean);

    if (items.length === 0) {
      // Might be a store slug, not a username — signal main process to resolve
      return { raw: 0, products: [], needsResolve: true };
    }

    setStatus('⟳ grouping ' + items.length + ' sold listings...');
    const cutoff = Date.now() - days * 86400000;
    const groups = {};
    for (const it of items) {
      const key = it.title.toLowerCase().slice(0, 60);
      if (!groups[key]) groups[key] = { title: it.title, ebayPrice: it.price, itemId: it.itemId, soldTotal: 0, soldWindow: 0, lastSold: '' };
      const g = groups[key];
      g.soldTotal++;
      if (it.soldDate) {
        const t = new Date(it.soldDate).getTime();
        if (!isNaN(t)) {
          if (t >= cutoff) g.soldWindow++;
          if (!g.lastSold || t > new Date(g.lastSold).getTime()) g.lastSold = it.soldDate;
        }
      }
    }

    const products = Object.values(groups).filter(g => g.soldWindow >= minSold);
    return { raw: items.length, products, needsResolve: false };
  }

  // ── Pull button ───────────────────────────────────────────────
  document.getElementById('__zd_pull').addEventListener('click', async () => {
    if (!currentSeller) return;
    const pullBtn  = document.getElementById('__zd_pull');
    const statusEl = document.getElementById('__zd_status');
    pullBtn.disabled = true; pullBtn.textContent = '⟳ pulling...';
    try {
      const result = await scrapeSoldListings(currentSeller);
      // Hand scraped products to main process for VeRO filter + DB save
      const msg = await window.__zdSave(currentSeller, JSON.stringify(result));
      statusEl.textContent = msg;
    } catch (e) {
      statusEl.textContent = '✕ ' + e.message;
    }
    pullBtn.textContent = '⬇ PULL PRODUCTS';
    pullBtn.disabled = false;
  });

  document.getElementById('__zd_refresh').addEventListener('click', refresh);

  let hidden = false;
  document.getElementById('__zd_hide').addEventListener('click', () => {
    hidden = !hidden;
    [...box.querySelectorAll(':scope > *:not(#__zd_hide)')].forEach(el => el.style.display = hidden ? 'none' : '');
    document.getElementById('__zd_hide').textContent = hidden ? 'show' : 'hide';
  });
})();
`;
}

// ── Main process: receive scraped data, apply VeRO, save ───────
async function handleSave(seller, resultJson, resolveUsername) {
  const result = JSON.parse(resultJson);

  if (result.needsResolve) {
    // Store slug — resolve to real username and retry via a lightweight fetch in Node
    const username = await resolveUsername(seller);
    if (username && username.toLowerCase() !== seller.toLowerCase()) {
      return `⚠ "${seller}" is a store name — re-pull as: ${username}`;
    }
    return `✕ No sold listings found for "${seller}"`;
  }

  const withMeta = result.products.map(p => ({
    ...p,
    seller,
    source: `competitor:${seller}`,
    pulled_at: new Date().toISOString(),
  }));

  const { kept, removed } = Vero.filter(withMeta);
  DB.saveCompetitorProducts(seller, kept);
  notify(seller, { products: kept, raw: result.raw });

  if (!kept.length) {
    return `⚠ ${result.raw} sold found, 0 passed filters (${removed.length} VeRO removed, or min-sold threshold too high)`;
  }
  return `✓ ${kept.length} products saved — ${result.raw} sold scanned, ${removed.length} VeRO removed`;
}

// ── Inject overlay into a Puppeteer page ───────────────────────
async function bindPage(page, resolveUsername) {
  if (trackedPages.has(page)) return;
  trackedPages.add(page);
  try {
    await page.exposeFunction('__zdSave', (seller, resultJson) =>
      handleSave(seller, resultJson, resolveUsername)
    );
  } catch (_) { /* already bound */ }
}

async function injectOverlay(page) {
  try {
    const url = page.url();
    if (!url || !url.includes('ebay.com')) return;
    const present = await page.evaluate(() => !!window.__zdOverlay).catch(() => false);
    if (present) return;
    await page.evaluate(buildOverlayJS(opts.days, opts.minSold));
  } catch (_) {}
}

async function watchPage(page, resolveUsername) {
  await bindPage(page, resolveUsername);
  page.on('load',             () => injectOverlay(page));
  page.on('domcontentloaded', () => injectOverlay(page));
  await injectOverlay(page);
}

// ── Public API ─────────────────────────────────────────────────
const Overlay = {
  async start(options = {}, onPull = () => {}) {
    opts   = { days: options.days || 14, minSold: options.minSold || 1 };
    notify = onPull;

    const Radar   = require('./radar');
    const browser = await Pipeline.getBrowser();
    const resolve = (slug) => Radar.resolveUsername(slug);

    const pages = await browser.pages();
    for (const p of pages) await watchPage(p, resolve);

    if (!pages.some(p => p.url().includes('ebay.com'))) {
      const p = pages[0] || await browser.newPage();
      await p.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    browser.on('targetcreated', async (target) => {
      const p = await target.page().catch(() => null);
      if (p) await watchPage(p, resolve);
    });

    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(async () => {
      try {
        for (const p of await browser.pages()) await injectOverlay(p);
      } catch (_) {}
    }, 3000);

    return { success: true };
  },

  setParams(options) {
    opts = { days: options.days ?? opts.days, minSold: options.minSold ?? opts.minSold };
  },

  stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    trackedPages = new WeakSet();
    return { success: true };
  },
};

module.exports = Overlay;
