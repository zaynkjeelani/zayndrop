// src/scout/hunt.js — Amazon product hunt (EcomSniper Product Finder port)
// Scrapes Amazon search results via the shared Puppeteer browser, applies
// price/review filters + VeRO, optionally checks eBay competition, scores 0-100.

const Pipeline = require('../fill/pipeline');
const Vero = require('./vero');

const Hunt = {
  delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  async hunt(keywords, options = {}, progress = () => {}) {
    const {
      pages = 2,              // Amazon search pages per keyword
      minPrice = 0,
      maxPrice = 999,
      minReviews = 0,
      maxReviews = 999999,
      checkEbay = false,      // per-product eBay competition lookup (slow)
      ebayCheckLimit = 15,
    } = options;

    const kws = Array.isArray(keywords) ? keywords : String(keywords).split(',').map(k => k.trim()).filter(Boolean);
    const seen = new Set();
    let all = [];

    for (const kw of kws) {
      for (let pg = 1; pg <= pages; pg++) {
        progress({ stage: 'amazon', text: `Searching "${kw}" page ${pg}/${pages}...` });
        const page = await Pipeline.newPage();
        try {
          await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(kw)}&page=${pg}`, { waitUntil: 'domcontentloaded' });
          await this.delay(2500);
          const items = await page.evaluate(() => {
            return [...document.querySelectorAll('[data-asin]')].map(card => {
              const asin = card.getAttribute('data-asin');
              if (!asin || asin.length !== 10) return null;
              const title = card.querySelector('h2')?.textContent?.trim() || '';
              if (!title) return null;
              const price = parseFloat(card.querySelector('.a-price .a-offscreen')?.textContent?.replace(/[$,]/g, '') || '0') || 0;
              const reviewsEl = [...card.querySelectorAll('span[aria-label]')].find(s => /^[\d,]+$/.test(s.textContent.trim()));
              const reviews = parseInt((reviewsEl?.textContent || '0').replace(/,/g, '')) || 0;
              const image = card.querySelector('img.s-image')?.src || '';
              const sponsored = !!card.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"]');
              const prime = !!card.querySelector('.a-icon-prime');
              return { asin, title, price, reviews, image, sponsored, prime };
            }).filter(Boolean);
          });
          for (const it of items) {
            if (seen.has(it.asin)) continue;
            seen.add(it.asin);
            it.keyword = kw;
            all.push(it);
          }
          progress({ stage: 'amazon', text: `  → ${items.length} products on page ${pg}` });
        } catch (e) {
          progress({ stage: 'amazon', text: `  ⚠ ${kw} p${pg}: ${e.message}` });
        } finally { await page.close(); }
        await this.delay(800);
      }
    }

    progress({ stage: 'filter', text: `${all.length} unique products scraped` });

    // Price/review filters
    all = all.filter(p =>
      p.price >= minPrice && p.price <= maxPrice &&
      p.reviews >= minReviews && p.reviews <= maxReviews &&
      !p.sponsored);
    progress({ stage: 'filter', text: `${all.length} after price/review filters` });

    // VeRO filter
    const { kept, removed } = Vero.filter(all);
    all = kept;
    progress({ stage: 'filter', text: `${all.length} after VeRO (${removed.length} brand-protected removed)` });

    // Optional eBay competition check on the most-reviewed products
    if (checkEbay && all.length) {
      const toCheck = [...all].sort((a, b) => b.reviews - a.reviews).slice(0, ebayCheckLimit);
      for (const p of toCheck) {
        progress({ stage: 'ebay', text: `eBay check: ${p.title.slice(0, 45)}...` });
        try {
          const eb = await this.ebayCompetition(p.title);
          p.ebayCount = eb.count;
          p.ebayLowest = eb.lowest;
        } catch (_) {}
        await this.delay(1200);
      }
    }

    // Score
    for (const p of all) p.score = this.score(p);
    all.sort((a, b) => b.score - a.score);

    progress({ stage: 'done', text: `Hunt complete — ${all.length} products` });
    return { success: true, products: all, veroRemoved: removed.length };
  },

  async ebayCompetition(title) {
    // Use the first ~8 meaningful words as the search query
    const q = title.split(/\s+/).filter(w => w.length > 2).slice(0, 8).join(' ');
    const page = await Pipeline.newPage();
    try {
      await page.goto(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_BIN=1&_sop=15`, { waitUntil: 'domcontentloaded' });
      await this.delay(2500);
      return await page.evaluate(() => {
        const countText = document.querySelector('.srp-controls__count-heading, .result-count__count-heading')?.textContent || '';
        const count = parseInt(countText.replace(/[^\d]/g, '')) || 0;
        const prices = [...document.querySelectorAll('.s-item__price')]
          .map(el => parseFloat(el.textContent.replace(/[$,]/g, '')) || 0)
          .filter(p => p > 0);
        return { count, lowest: prices.length ? Math.min(...prices) : 0 };
      });
    } finally { await page.close(); }
  },

  // 0-100 opportunity score
  score(p) {
    let s = 0;
    // Price sweet spot for dropshipping ($8–$60)
    if (p.price >= 8 && p.price <= 60) s += 30;
    else if (p.price > 0) s += 10;
    // Demand proxy: reviews
    if (p.reviews >= 1000) s += 25;
    else if (p.reviews >= 200) s += 20;
    else if (p.reviews >= 50) s += 12;
    else if (p.reviews >= 10) s += 5;
    // Prime = reliable fast fulfillment
    if (p.prime) s += 10;
    // eBay competition data (when available)
    if (p.ebayLowest !== undefined && p.ebayLowest > 0) {
      const margin = p.ebayLowest - p.price;
      if (margin > 8) s += 25;
      else if (margin > 4) s += 18;
      else if (margin > 1.5) s += 10;
      if (p.ebayCount !== undefined) {
        if (p.ebayCount < 20) s += 10;
        else if (p.ebayCount < 100) s += 5;
      }
    } else {
      s += 12; // unknown competition — neutral
    }
    return Math.min(100, s);
  }
};

module.exports = Hunt;
