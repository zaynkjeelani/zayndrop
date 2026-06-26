// src/scout/radar.js — Market Radar
// Demand detection from three signals:
//   1. Competitor stores — what other dropshippers actually sold recently (eBay sold listings)
//   2. Amazon Movers & Shakers — products with spiking sales rank
//   3. eBay sold-velocity validation + Amazon source lookup for margin
// All candidates are VeRO-filtered and scored.

const Pipeline = require('../fill/pipeline');
const Vero = require('./vero');
const dbg = require('../shared/debug-log');

const Radar = {
  delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  // ── 1. Competitor store scan ───────────────────────────────────
  // Scrapes a seller's SOLD listings (most recent first), groups by title,
  // counts recent sales = real observed demand.
  async scanCompetitor(seller, progress) {
    const page = await Pipeline.newPage();
    try {
      const url = `https://www.ebay.com/sch/i.html?_ssn=${encodeURIComponent(seller)}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=120`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.delay(3000);
      const items = await page.evaluate(() => {
        return [...document.querySelectorAll('.s-item')].map(it => {
          const title = it.querySelector('.s-item__title')?.textContent?.trim() || '';
          if (!title || /shop on ebay/i.test(title)) return null;
          const price = parseFloat((it.querySelector('.s-item__price')?.textContent || '').replace(/[$,]/g, '')) || 0;
          const soldText = (it.querySelector('.s-item__caption, .POSITIVE, .s-item__title--tag')?.textContent || '');
          const soldDate = soldText.match(/Sold\s+([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1] || '';
          return { title, price, soldDate };
        }).filter(Boolean);
      });

      // Group identical titles → sold count + recency
      const groups = {};
      const now = Date.now();
      for (const it of items) {
        const key = it.title.toLowerCase().slice(0, 60);
        if (!groups[key]) groups[key] = { title: it.title, ebayPrice: it.price, soldTotal: 0, sold7d: 0, sold30d: 0 };
        const g = groups[key];
        g.soldTotal++;
        if (it.soldDate) {
          const age = (now - new Date(it.soldDate).getTime()) / 86400000;
          if (age <= 7) g.sold7d++;
          if (age <= 30) g.sold30d++;
        }
      }
      const result = Object.values(groups).sort((a, b) => b.soldTotal - a.soldTotal);
      progress({ text: `  ${seller}: ${items.length} sold listings → ${result.length} unique products` });
      return result.map(g => ({ ...g, source: `competitor:${seller}` }));
    } finally { await page.close(); }
  },

  // ── 2. Amazon Movers & Shakers ─────────────────────────────────
  async moversShakers(category, progress) {
    const page = await Pipeline.newPage();
    try {
      const url = category
        ? `https://www.amazon.com/gp/movers-and-shakers/${category}`
        : 'https://www.amazon.com/gp/movers-and-shakers';
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.delay(3000);
      const items = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.zg-grid-general-faceout, [id^="p13n-asin-index"], .a-carousel-card')];
        return cards.map(c => {
          const link = c.querySelector('a[href*="/dp/"]');
          const asin = link?.href?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
          if (!asin) return null;
          const title = (c.querySelector('[class*="line-clamp"]')?.textContent || link?.textContent || '').trim();
          const price = parseFloat((c.querySelector('[class*="price"], .a-color-price')?.textContent || '').replace(/[$,]/g, '')) || 0;
          const jump = (c.textContent.match(/([\d,]+)%/) || [])[1] || '';
          const image = c.querySelector('img')?.src || '';
          return { asin, title, price, rankJump: jump, image };
        }).filter(Boolean);
      });
      progress({ text: `  movers-and-shakers${category ? '/' + category : ''}: ${items.length} products` });
      return items.map(i => ({ ...i, amazonPrice: i.price, source: `movers:${category || 'all'}` }));
    } finally { await page.close(); }
  },

  // ── 3a. eBay sold-velocity for a title ─────────────────────────
  async ebaySoldVelocity(title) {
    const q = title.split(/\s+/).filter(w => w.length > 2).slice(0, 8).join(' ');
    const page = await Pipeline.newPage();
    try {
      await page.goto(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60`, { waitUntil: 'domcontentloaded' });
      await this.delay(2500);
      return await page.evaluate(() => {
        const now = Date.now();
        let sold7d = 0, sold30d = 0;
        const prices = [];
        for (const it of document.querySelectorAll('.s-item')) {
          const t = it.querySelector('.s-item__title')?.textContent || '';
          if (!t || /shop on ebay/i.test(t)) continue;
          const p = parseFloat((it.querySelector('.s-item__price')?.textContent || '').replace(/[$,]/g, '')) || 0;
          if (p > 0) prices.push(p);
          const d = (it.textContent.match(/Sold\s+([A-Z][a-z]{2} \d{1,2}, \d{4})/) || [])[1];
          if (d) {
            const age = (now - new Date(d).getTime()) / 86400000;
            if (age <= 7) sold7d++;
            if (age <= 30) sold30d++;
          }
        }
        prices.sort((a, b) => a - b);
        return { sold7d, sold30d, medianPrice: prices[Math.floor(prices.length / 2)] || 0 };
      });
    } finally { await page.close(); }
  },

  // ── 3b. Find the Amazon source for an eBay title ───────────────
  async amazonLookup(title) {
    const q = title.split(/\s+/).filter(w => w.length > 2).slice(0, 8).join(' ');
    const page = await Pipeline.newPage();
    try {
      await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
      await this.delay(2500);
      return await page.evaluate(() => {
        for (const card of document.querySelectorAll('[data-asin]')) {
          const asin = card.getAttribute('data-asin');
          if (!asin || asin.length !== 10) continue;
          if (card.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"]')) continue;
          const price = parseFloat(card.querySelector('.a-price .a-offscreen')?.textContent?.replace(/[$,]/g, '') || '0') || 0;
          if (!price) continue;
          const title = card.querySelector('h2')?.textContent?.trim() || '';
          const prime = !!card.querySelector('.a-icon-prime');
          const image = card.querySelector('img.s-image')?.src || '';
          return { asin, amazonPrice: price, amazonTitle: title, prime, image };
        }
        return null;
      });
    } finally { await page.close(); }
  },

  // ── Scoring ────────────────────────────────────────────────────
  score(c) {
    let s = 0;
    // Observed demand is king
    const sold30 = c.sold30d ?? 0;
    if (sold30 >= 20) s += 35;
    else if (sold30 >= 8) s += 28;
    else if (sold30 >= 3) s += 18;
    else if ((c.soldTotal ?? 0) >= 3) s += 10;
    if (c.rankJump) s += 15; // spiking on Amazon
    // Margin
    const ebay = c.ebayPrice || c.medianPrice || 0;
    const amz = c.amazonPrice || 0;
    if (ebay && amz) {
      const margin = ebay * 0.87 - amz; // after ~13% fees
      c.margin = +margin.toFixed(2);
      if (margin > 8) s += 30;
      else if (margin > 4) s += 22;
      else if (margin > 1.5) s += 12;
      else s -= 10; // unprofitable
    } else { s += 8; }
    if (c.prime) s += 8;
    if (amz >= 8 && amz <= 60) s += 7;
    return Math.max(0, Math.min(100, s));
  },

  // ── Competitor pull with filters ───────────────────────────────
  // Scrapes a seller's sold listings; keeps products with >= minSold sales
  // within the last `days` days.
  // Resolve a store display name or /str/ slug into the real eBay username
  // (the sold-listings search only accepts usernames).
  async resolveUsername(nameOrSlug) {
    const slug = nameOrSlug.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    const page = await Pipeline.newPage();
    try {
      await page.goto(`https://www.ebay.com/str/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(2500);
      return await page.evaluate(() => {
        for (const sel of ['a[href*="_ssn="]', 'a[href*="/usr/"]', 'a[href*="feedback_profile/"]']) {
          const a = document.querySelector(sel);
          if (!a) continue;
          const m = a.href.match(/[?&]_ssn=([^&]+)/) || a.href.match(/\/usr\/([^/?#]+)/) || a.href.match(/feedback_profile\/([^/?#]+)/);
          if (m) return decodeURIComponent(m[1]);
        }
        return null;
      });
    } catch (_) { return null; }
    finally { await page.close(); }
  },

  async pullCompetitor(seller, { days = 14, minSold = 1 } = {}, progress = () => {}, _retried = false) {
    const page = await Pipeline.newPage();
    try {
      progress({ text: `Fetching sold listings for ${seller}...` });
      await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.delay(1500);

      // Resolve store slug → real eBay username via in-page fetch (same session, no CAPTCHA)
      let username = seller;
      if (!_retried) {
        const storeHtml = await page.evaluate(async (slug) => {
          try {
            const r = await fetch(`/str/${encodeURIComponent(slug)}`, { credentials: 'include' });
            return r.ok ? r.text() : '';
          } catch (_) { return ''; }
        }, seller);
        if (storeHtml) {
          const mFdbk = storeHtml.match(/feedback_profile\/([^"'\/?#\s]+)/);
          const mSsn  = storeHtml.match(/[?&]_ssn=([^"'&\s]+)/);
          const mUsr  = storeHtml.match(/\/usr\/([^"'\/?#\s]+)/);
          const found = (mFdbk && mFdbk[1]) || (mSsn && mSsn[1]) || (mUsr && mUsr[1]);
          if (found && found.toLowerCase() !== seller.toLowerCase()) {
            progress({ text: `  resolved: ${seller} → ${found}` });
            username = found;
          }
        }
      }

      // Fetch + parse in one evaluate so no large HTML string crosses the IPC boundary
      const soldUrl = `/sch/i.html?_ssn=${encodeURIComponent(username)}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=240`;
      page.setDefaultTimeout(120000);
      const items = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) return [];
          const html = await r.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          return [...doc.querySelectorAll('li[id^="item"]')].map(it => {
            const titleEl = it.querySelector('.s-card__title') || it.querySelector('[class*="title"]') || it.querySelector('a[href*="/itm/"]');
            const title = titleEl?.textContent?.trim()?.replace(/\s+/g, ' ') || '';
            if (!title || /shop on ebay/i.test(title)) return null;
            const priceEl = it.querySelector('.s-card__price') || it.querySelector('[class*="price"]');
            const price = parseFloat((priceEl?.textContent || '').replace(/[$,]/g, '')) || 0;
            const linkEl = [...it.querySelectorAll('a')].find(a => (a.getAttribute('href') || '').includes('/itm/'));
            const href = linkEl?.getAttribute('href') || '';
            const itemId = href.match(/\/itm\/(\d+)/)?.[1] || '';
            const captionText = it.querySelector('.s-card__caption')?.textContent || it.textContent;
            const soldDate = (captionText.match(/Sold\s+([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})/) || [])[1]?.replace(/\s+/g, ' ') || '';
            return { title, price, itemId, soldDate };
          }).filter(Boolean);
        } catch (_) { return []; }
      }, soldUrl).catch(() => []);
      page.setDefaultTimeout(60000);

      progress({ text: `  ${username}: ${items.length} raw items found — processing...` });

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

      const kept = Object.values(groups)
        .filter(g => g.soldWindow >= minSold)
        .sort((a, b) => b.soldWindow - a.soldWindow)
        .map(g => ({ ...g, seller, source: `competitor:${seller}`, pulled_at: new Date().toISOString() }));

      // VeRO filter
      const { kept: clean, removed } = Vero.filter(kept);
      progress({ text: `${seller}: ${items.length} sold listings → ${Object.keys(groups).length} products → ${clean.length} pass filters (${removed.length} VeRO)` });
      return { success: true, products: clean, veroRemoved: removed.length, raw: items.length };
    } catch (err) {
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  },

  // ── Keyword Hunter ─────────────────────────────────────────────
  // Reads BOTH markets per keyword: eBay sold velocity (demand) and the top
  // Amazon result (supply price) → demand/margin score per keyword.
  async keywordRadar(keywords, progress = () => {}) {
    const results = [];
    for (const kw of keywords) {
      progress({ text: `Keyword: "${kw}" — eBay demand...` });
      const r = { title: kw, source: 'keyword' };
      try {
        const v = await this.ebaySoldVelocity(kw);
        r.sold7d = v.sold7d; r.sold30d = v.sold30d; r.ebayPrice = v.medianPrice;
      } catch (e) { progress({ text: `  ⚠ eBay: ${e.message}` }); }
      await this.delay(1000);
      progress({ text: `  Amazon supply...` });
      try {
        const amz = await this.amazonLookup(kw);
        if (amz) Object.assign(r, amz);
      } catch (e) { progress({ text: `  ⚠ Amazon: ${e.message}` }); }
      r.score = this.score(r);
      results.push(r);
      progress({ text: `  → sold30d=${r.sold30d ?? '?'} ebay=$${r.ebayPrice ?? '?'} amazon=$${r.amazonPrice ?? '?'} score=${r.score}` });
      await this.delay(1200);
    }
    results.sort((a, b) => b.score - a.score);
    return { success: true, candidates: results, veroRemoved: 0 };
  },

  // Random keywords from the bundled niche files (EcomSniper Product_Ideas)
  randomNicheKeywords(count = 6) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../../assets/product_ideas');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
    const picked = [];
    while (picked.length < count && files.length) {
      const f = files.splice(Math.floor(Math.random() * files.length), 1)[0];
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
        .map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
      if (lines.length) picked.push(lines[Math.floor(Math.random() * lines.length)]);
    }
    return picked;
  },

  // ── Main radar run ─────────────────────────────────────────────
  async run({ sellers = [], categories = [], deepCheck = 12 } = {}, progress = () => {}) {
    let candidates = [];

    // 1. Competitor stores
    for (const seller of sellers) {
      progress({ text: `Scanning competitor: ${seller}...` });
      try { candidates.push(...await this.scanCompetitor(seller, progress)); }
      catch (e) { progress({ text: `  ⚠ ${seller}: ${e.message}` }); }
      await this.delay(1500);
    }

    // 2. Movers & Shakers
    for (const cat of (categories.length ? categories : [null])) {
      progress({ text: `Scanning Movers & Shakers${cat ? ': ' + cat : ''}...` });
      try { candidates.push(...await this.moversShakers(cat, progress)); }
      catch (e) { progress({ text: `  ⚠ movers ${cat}: ${e.message}` }); }
      await this.delay(1500);
    }

    progress({ text: `${candidates.length} raw candidates` });

    // VeRO filter
    const { kept, removed } = Vero.filter(candidates);
    candidates = kept;
    progress({ text: `${candidates.length} after VeRO (${removed.length} removed)` });

    // 3. Deep-check the most promising: Amazon lookup for competitor items,
    //    eBay velocity for movers items
    const compItems = candidates.filter(c => c.source.startsWith('competitor')).sort((a, b) => (b.sold30d || b.soldTotal) - (a.sold30d || a.soldTotal)).slice(0, deepCheck);
    for (const c of compItems) {
      progress({ text: `Amazon lookup: ${c.title.slice(0, 45)}...` });
      try {
        const amz = await this.amazonLookup(c.title);
        if (amz) Object.assign(c, amz);
      } catch (_) {}
      await this.delay(1200);
    }
    const moverItems = candidates.filter(c => c.source.startsWith('movers')).slice(0, deepCheck);
    for (const c of moverItems) {
      progress({ text: `eBay velocity: ${c.title.slice(0, 45)}...` });
      try {
        const v = await this.ebaySoldVelocity(c.title);
        Object.assign(c, v);
      } catch (_) {}
      await this.delay(1200);
    }

    for (const c of candidates) c.score = this.score(c);
    candidates.sort((a, b) => b.score - a.score);

    progress({ text: `Radar complete — ${candidates.length} candidates scored` });
    return { success: true, candidates, veroRemoved: removed.length };
  }
};

module.exports = Radar;
