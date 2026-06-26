// src/list/engine.js — zayndrop List: ASIN matching, pricing, posting

const Pipeline = require('../fill/pipeline');
const DB = require('../shared/db');
const path = require('path');
const { app } = require('electron');

let stopped = false;

const Engine = {
  delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  stop() { stopped = true; return { success: true }; },

  // ── Bulk ASIN matching ─────────────────────────────────────────
  // Searches Amazon for each item's title and collects the cheapest matching
  // candidates. Items go to 'review' status — the user approves the match.
  async matchAsins(itemIds, progress = () => {}, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const queue = db.getQueue().filter(q => itemIds.includes(q.id));
    let matched = 0;
    for (const item of queue) {
      progress({ text: `⌕ ${(item.title || '').slice(0, 50)}...` });
      const q = (item.title || '').split(/\s+/).filter(w => w.length > 2).slice(0, 9).join(' ');
      const page = await Pipeline.newPage();
      try {
        await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);
        const candidates = await page.evaluate(() => {
          const out = [];
          for (const card of document.querySelectorAll('[data-asin]')) {
            const asin = card.getAttribute('data-asin');
            if (!asin || asin.length !== 10) continue;
            if (card.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"]')) continue;
            const price = parseFloat(card.querySelector('.a-price .a-offscreen')?.textContent?.replace(/[$,]/g, '') || '0') || 0;
            if (!price) continue;
            const title = card.querySelector('h2')?.textContent?.trim() || '';
            const image = card.querySelector('img.s-image')?.src || '';
            const prime = !!card.querySelector('.a-icon-prime');
            out.push({ asin, price, title, image, prime });
            if (out.length >= 6) break;
          }
          return out;
        });
        if (candidates.length) {
          candidates.sort((a, b) => a.price - b.price);
          db.updateQueueItem(item.id, {
            candidates: JSON.stringify(candidates),
            suggested_asin: candidates[0].asin,
            status: 'review'
          });
          matched++;
          progress({ text: `  ✓ ${candidates.length} candidates, cheapest $${candidates[0].price.toFixed(2)}` });
        } else {
          db.updateQueueItem(item.id, { status: 'no_match' });
          progress({ text: `  ⚠ no Amazon matches found` });
        }
      } catch (e) {
        progress({ text: `  ✕ ${e.message}` });
      } finally { await page.close().catch(() => {}); }
      await this.delay(1200);
    }
    return { success: true, matched };
  },

  // ── Word overlap helper ────────────────────────────────────────
  _wordOverlap(a, b) {
    const words = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const wa = words(a), wb = words(b);
    let common = 0; for (const w of wa) if (wb.has(w)) common++;
    return common / Math.max(wa.size, wb.size, 1);
  },

  // ── Get current price from Amazon product page ─────────────────
  async _priceFromDp(asin) {
    const page = await Pipeline.newPage();
    try {
      await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded' });
      await this.delay(2000);
      return await page.evaluate(() => {
        const t = document.querySelector('#productTitle')?.textContent?.trim() || '';
        const priceEl = document.querySelector('.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox');
        const price = parseFloat(priceEl?.textContent?.replace(/[$,]/g, '') || '0') || 0;
        const prime = !!document.querySelector('#isPrimeBadge, .a-icon-prime');
        return { price, title: t, prime };
      });
    } finally { await page.close().catch(() => {}); }
  },

  // ── Amazon search: auto-pick best ASIN (no review modal) ───────
  // Checks asin_map (past fulfilled orders) first — fastest & most accurate.
  // Falls back to Amazon search if no prior purchase found.
  async _findBestAsin(title, progress) {
    // 1. Check order history (asin_map) — if we've fulfilled this product before,
    //    use that confirmed ASIN and fetch its current price from the product page.
    const asinMap = DB.getAsinMap();
    if (asinMap.length) {
      const prior = asinMap
        .filter(m => m.title && this._wordOverlap(title, m.title) > 0.45)
        .sort((a, b) => this._wordOverlap(title, b.title) - this._wordOverlap(title, a.title))[0];
      if (prior) {
        progress({ text: `  ★ found in order history: ${prior.asin} (${prior.title.slice(0, 40)})` });
        try {
          const { price, title: amzTitle, prime } = await this._priceFromDp(prior.asin);
          if (price) return { asin: prior.asin, price, title: amzTitle || prior.title, prime, fromHistory: true };
        } catch (_) {}
      }
    }

    // 2. Fall back to Amazon search
    const q = title.split(/\s+/).filter(w => w.length > 2).slice(0, 9).join(' ');
    const page = await Pipeline.newPage();
    try {
      await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
      await this.delay(2500);
      const candidates = await page.evaluate(() => {
        const out = [];
        for (const card of document.querySelectorAll('[data-asin]')) {
          const asin = card.getAttribute('data-asin');
          if (!asin || asin.length !== 10) continue;
          if (card.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"]')) continue;
          const price = parseFloat(card.querySelector('.a-price .a-offscreen')?.textContent?.replace(/[$,]/g, '') || '0') || 0;
          if (!price) continue;
          const t = card.querySelector('h2')?.textContent?.trim() || '';
          const image = card.querySelector('img.s-image')?.src || '';
          const prime = !!card.querySelector('.a-icon-prime');
          out.push({ asin, price, title: t, image, prime });
          if (out.length >= 8) break;
        }
        return out;
      });
      if (!candidates.length) return null;

      // Score: word overlap with search title + prefer Prime
      const scored = candidates
        .filter(c => this._wordOverlap(title, c.title) > 0.2)
        .map(c => ({ ...c, score: this._wordOverlap(title, c.title) + (c.prime ? 0.15 : 0) - c.price * 0.001 }))
        .sort((a, b) => b.score - a.score);

      return scored[0] || candidates.sort((a, b) => (b.prime ? 1 : 0) - (a.prime ? 1 : 0) || a.price - b.price)[0];
    } finally { await page.close().catch(() => {}); }
  },

  // ── Full auto pipeline: match → price → post ──────────────────
  async autoRun(itemIds, { markupPct = 30, autoSubmit = true } = {}, progress = () => {}, accountId = 'acc1') {
    stopped = false;
    const db = DB.forAccount(accountId);
    const Store = require('electron-store');
    const apiKey = new Store().get('anthropicKey');
    const Generate = require('./generate');
    const opts = { autoSubmit, apiKey, Generate, db };

    const queue = db.getQueue().filter(q => itemIds.includes(q.id));
    let posted = 0, failed = 0, noMatch = 0;

    for (let i = 0; i < queue.length; i += 2) {
      if (stopped) { progress({ text: '■ stopped by user' }); break; }
      const chunk = queue.slice(i, i + 2);

      await Promise.all(chunk.map(async item => {
        progress({ text: `⌕ [${(item.title || '').slice(0, 45)}] finding Amazon match...` });

        let asin = item.asin, amazonPrice = parseFloat(item.amazon_price) || 0;
        if (!asin) {
          try {
            const best = await this._findBestAsin(item.title, progress);
            if (!best) {
              db.updateQueueItem(item.id, { status: 'no_match' });
              progress({ text: `  ✕ no Amazon match found` });
              noMatch++;
              return;
            }
            asin = best.asin;
            amazonPrice = best.price;
            db.updateQueueItem(item.id, { asin, amazon_price: amazonPrice, amazon_title: best.title, status: 'ready' });
            progress({ text: `  ✓ matched → ${asin} $${amazonPrice.toFixed(2)}${best.prime ? ' ✓Prime' : ''}${best.fromHistory ? ' [from order history]' : ' [search]'}` });
          } catch (e) {
            progress({ text: `  ✕ match failed: ${e.message}` });
            noMatch++;
            return;
          }
        }

        const target = Math.ceil(amazonPrice * (1 + markupPct / 100) * 100) / 100;
        const profit = +(target * 0.87 - amazonPrice).toFixed(2);
        db.updateQueueItem(item.id, { our_price: target, estimated_profit: profit });
        progress({ text: `  $ $${amazonPrice.toFixed(2)} × ${markupPct}% → $${target.toFixed(2)} (≈$${profit} profit)` });

        const fresh = db.getQueue().find(q => q.id === item.id);
        const result = await this.postSingleItem(fresh, opts, progress);
        posted += result.posted;
        failed += result.failed;
      }));
    }

    return { success: true, posted, failed, noMatch };
  },

  // ── Bulk pricing ───────────────────────────────────────────────
  // mode 'markup':  our_price = amazon_cost × (1 + markup/100)
  // mode 'undercut': our_price = competitor_price × (1 - undercut/100)
  priceItems(itemIds, { markupPct = 30, mode = 'markup', undercutPct = 5 } = {}, progress = () => {}, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const queue = db.getQueue().filter(q => itemIds.includes(q.id));
    let priced = 0, skipped = 0;
    for (const item of queue) {
      const shortTitle = (item.title || '').slice(0, 40);

      if (mode === 'undercut') {
        const compPrice = parseFloat(item.competitor_price) || 0;
        if (!compPrice) {
          skipped++;
          progress({ text: `⚠ ${shortTitle}: no competitor price — skipped` });
          continue;
        }
        const target = Math.max(0.99, Math.floor(compPrice * (1 - undercutPct / 100) * 100) / 100);
        const amazonCost = parseFloat(item.amazon_price) || 0;
        const profit = amazonCost ? +(target * 0.87 - amazonCost).toFixed(2) : null;
        db.updateQueueItem(item.id, { our_price: target, estimated_profit: profit, status: item.asin ? 'ready' : item.status });
        priced++;
        progress({ text: `✓ ${shortTitle}: comp $${compPrice.toFixed(2)} −${undercutPct}% → $${target.toFixed(2)}${profit !== null ? ` (≈$${profit} profit)` : ''}` });
      } else {
        const cost = parseFloat(item.amazon_price) || 0;
        if (!cost) { skipped++; progress({ text: `⚠ ${shortTitle}: no Amazon price — skipped` }); continue; }
        const target = Math.ceil(cost * (1 + markupPct / 100) * 100) / 100;
        const profit = +(target * 0.87 - cost).toFixed(2);
        db.updateQueueItem(item.id, { our_price: target, estimated_profit: profit, status: item.asin ? 'ready' : item.status });
        priced++;
        progress({ text: `✓ ${shortTitle}: $${cost.toFixed(2)} ×${markupPct}% → $${target.toFixed(2)} (≈$${profit} profit after fees)` });
      }
    }
    return { success: true, priced, skipped };
  },

  // ── Amazon product scrape (images + bullets in one visit) ────────
  async fetchAmazonData(asin, progress = () => {}) {
    const fs = require('fs');
    const dir = path.join(app.getPath('temp'), 'zayndrop-imgs', asin);
    let cachedImages = [];
    if (fs.existsSync(dir)) {
      cachedImages = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).map(f => path.join(dir, f));
    }
    const page = await Pipeline.newPage();
    try {
      await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded' });
      await this.delay(2500);
      const { urls, amazonTitle, bullets, firstImageUrl, livePrice } = await page.evaluate(() => {
        const out = new Set();
        for (const m of document.body.innerHTML.matchAll(/"hiRes":"(https:[^"]+?)"/g)) out.add(m[1]);
        const landing = document.querySelector('#landingImage');
        if (landing) {
          const hi = landing.getAttribute('data-old-hires');
          if (hi) out.add(hi); else if (landing.src) out.add(landing.src);
        }
        const amazonTitle = document.querySelector('#productTitle')?.textContent?.trim() || '';
        const bullets = [...document.querySelectorAll('#feature-bullets li span')]
          .map(e => e.textContent.trim()).filter(t => t && t.length > 10);
        const firstImageUrl = [...out][0] || landing?.src || '';
        const priceEl = document.querySelector('.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox');
        const livePrice = parseFloat((priceEl?.textContent || '').replace(/[$,]/g, '')) || null;
        return { urls: [...out].slice(0, 7), amazonTitle, bullets, firstImageUrl, livePrice };
      });

      let images = cachedImages;
      if (!cachedImages.length && urls.length) {
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < urls.length; i++) {
          try {
            const res = await fetch(urls[i]);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const file = path.join(dir, `${i}.jpg`);
            fs.writeFileSync(file, buf);
            images.push(file);
          } catch (_) {}
        }
      }
      progress({ text: `  📷 ${images.length} photos, ${bullets.length} bullets scraped${livePrice ? `, Amazon $${livePrice}` : ''}` });
      return { images, amazonTitle, bullets, firstImageUrl, livePrice };
    } finally { await page.close().catch(() => {}); }
  },

  // kept for backwards compat
  async fetchAmazonImages(asin, progress = () => {}) {
    const r = await this.fetchAmazonData(asin, progress);
    return r.images;
  },

  // ── Verify a listing is live (and unique) on eBay ──────────────
  async getMyUsername() {
    const Store = require('electron-store');
    const store = new Store();
    let u = store.get('ebayUsername');
    if (u) return u;

    // Try a recently-posted item page first — seller link is always there
    const recentItem = DB.getQueue().find(q => q.ebay_item_id);
    const urls = recentItem
      ? [`https://www.ebay.com/itm/${recentItem.ebay_item_id}`, 'https://www.ebay.com/sh/ovw', 'https://www.ebay.com/myb/Summary']
      : ['https://www.ebay.com/sh/ovw', 'https://www.ebay.com/myb/Summary'];

    const page = await Pipeline.newPage();
    try {
      for (const url of urls) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);
        u = await page.evaluate(() => {
          // 1. /usr/ links (most reliable — item pages, store pages, feedback links)
          const usrLink = [...document.querySelectorAll('a[href*="/usr/"]')]
            .map(a => decodeURIComponent((a.href.match(/\/usr\/([^/?#]+)/) || [])[1] || ''))
            .find(s => s && !/^(legal|privacy|help|policy)$/i.test(s));
          if (usrLink) return usrLink;
          // 2. "Hi [username]!" in page body text
          const hiMatch = document.body.innerText.match(/\bHi\s+([\w][\w.-]{1,30})\s*[!,]/);
          if (hiMatch) return hiMatch[1];
          // 3. feedback_profile links (?item=username)
          const fbLink = [...document.querySelectorAll('a[href*="feedback_profile"]')]
            .map(a => decodeURIComponent((a.href.match(/[?&]item=([^&]+)/) || [])[1] || ''))
            .find(s => s);
          return fbLink || '';
        });
        if (u) break;
      }
      if (u) store.set('ebayUsername', u);
      return u || null;
    } finally { await page.close().catch(() => {}); }
  },

  // Scrape all active listings from Seller Hub (paginated) — returns [{id, title}]
  async _getSellerHubActive(progress = () => {}) {
    const page = await Pipeline.newPage();
    const seen = new Map(); // id → title, deduped
    try {
      let offset = 0;
      let total = Infinity;
      while (offset < total) {
        const url = `https://www.ebay.com/sh/lst/active?limit=200&offset=${offset}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);

        const { rows, pageTotal } = await page.evaluate(() => {
          // Get total count from heading e.g. "Manage active listings (380)"
          const heading = document.querySelector('h1, h2, [class*="heading"]')?.textContent || '';
          const totalMatch = heading.match(/\((\d+)\)/);
          const pageTotal = totalMatch ? parseInt(totalMatch[1]) : null;
          // Each listing has two <a href="/itm/ID"> links — one empty, one with the title.
          // Dedupe by ID, keep the one with text.
          const byId = new Map();
          for (const a of document.querySelectorAll('a[href*="/itm/"]')) {
            const id = (a.href.match(/\/itm\/(\d+)/) || [])[1];
            const text = a.textContent.trim();
            if (!id) continue;
            if (!byId.has(id) || text.length > (byId.get(id) || '').length) byId.set(id, text);
          }
          const rows = [...byId.entries()]
            .map(([id, title]) => ({ id, title }))
            .filter(r => r.title.length > 5);
          return { rows, pageTotal };
        });

        if (pageTotal && total === Infinity) total = pageTotal;
        let added = 0;
        for (const r of rows) { if (!seen.has(r.id)) { seen.set(r.id, r.title); added++; } }
        if (added === 0) break; // no new items — stop
        offset += 200;
      }
    } finally { await page.close().catch(() => {}); }
    return [...seen.entries()].map(([id, title]) => ({ id, title }));
  },

  async verifyListing(queueId, progress = () => {}, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const item = db.getQueue().find(q => q.id === queueId);
    if (!item) return { success: false, error: 'item not found' };

    // Fast path: if we have the item ID, hit the listing directly
    if (item.ebay_item_id) {
      const page = await Pipeline.newPage();
      try {
        await page.goto(`https://www.ebay.com/itm/${item.ebay_item_id}`, { waitUntil: 'domcontentloaded' });
        await this.delay(2000);
        const r = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            ended: /this listing (was |has )?ended|no longer available|item is unavailable/i.test(text),
            notFound: /not found|looks like this page is missing/i.test(text),
          };
        });
        if (r.notFound) return { success: true, state: 'not_found', detail: `item ${item.ebay_item_id} not found` };
        if (r.ended) return { success: true, state: 'ended', detail: `item ${item.ebay_item_id} has ended` };
        // Still live
        db.updateQueueItem(item.id, { verified_at: new Date().toISOString(), status: 'posted' });
        return { success: true, state: 'live', detail: `live — item ${item.ebay_item_id}` };
      } finally { await page.close().catch(() => {}); }
    }

    // No item ID — scrape Seller Hub active listings and match by title word overlap
    progress({ text: '  ⌕ scanning Seller Hub active listings...' });
    const active = await this._getSellerHubActive(progress);
    if (!active.length) return { success: false, error: 'could not load Seller Hub active listings (not logged in?)' };

    const searchTitle = item.title || '';
    const matches = active.filter(l => this._wordOverlap(searchTitle, l.title) > 0.45);

    if (!matches.length) return { success: true, state: 'not_listed', detail: `not found in ${active.length} active listings` };
    if (matches.length > 1) return { success: true, state: 'duplicate', detail: `${matches.length} similar listings: ${matches.map(m => m.id).join(', ')}` };

    // Exactly one match — live and unique
    db.updateQueueItem(item.id, { ebay_item_id: matches[0].id, verified_at: new Date().toISOString(), status: 'posted' });
    return { success: true, state: 'live', detail: `live & unique — item ${matches[0].id} (matched from ${active.length} active listings)` };
  },

  // Strip link-tooltip junk that eBay/ZIK sometimes bakes into scraped titles
  _cleanTitle(t) {
    return (t || '')
      .replace(/opens? in a new (window|tab)/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  },

  // ── Posting (Puppeteer drives eBay's prelist/sell flow) ────────
  async postSingleItem(item, { autoSubmit, apiKey, Generate, db: _db }, progress) {
    const db = _db || DB;
    try {
      const cleanItemTitle = this._cleanTitle(item.title);

      // Scrape Amazon: photos + bullets + live price in one visit
      let images = [], amazonTitle = '', bullets = [], firstImageUrl = '', livePrice = null;
      try {
        ({ images, amazonTitle, bullets, firstImageUrl, livePrice } = await this.fetchAmazonData(item.asin, progress));
        if (!images.length) progress({ text: `  ⚠ no photos found for ${item.asin}` });
      } catch (e) { progress({ text: `  ⚠ Amazon scrape failed: ${e.message}` }); }

      // Recalculate price from live Amazon cost (same 30% markup formula as priceItems)
      if (livePrice && livePrice > 0) {
        const freshPrice = Math.ceil(livePrice * 1.30 * 100) / 100;
        const freshProfit = +(freshPrice * 0.87 - livePrice).toFixed(2);
        if (freshPrice !== item.our_price) {
          progress({ text: `  💲 price updated: $${item.our_price} → $${freshPrice} (Amazon now $${livePrice})` });
          db.updateQueueItem(item.id, { our_price: freshPrice, amazon_price: livePrice, estimated_profit: freshProfit });
          item = { ...item, our_price: freshPrice };
        }
      }

      // Claude optimizes title only — description is handled by eBay's own AI button
      let generatedTitle = '';
      if (!apiKey) {
        progress({ text: '  ⚠ no Anthropic API key — skipping AI title optimization' });
      } else {
        try {
          progress({ text: `  ✦ optimizing title with Claude (bullets:${bullets.length}, amzTitle:${!!amazonTitle})...` });
          generatedTitle = await Generate.titleFromData(cleanItemTitle, amazonTitle, bullets, apiKey);
          progress({ text: `  ✓ title: "${generatedTitle.slice(0, 60)}…"` });
        } catch (e) { progress({ text: `  ⚠ AI title failed: ${e.message}` }); }
      }

      const page = await Pipeline.newPage();
      const _pageTimeout = setTimeout(() => { page.close().catch(() => {}); }, 10 * 60 * 1000);
      try {
        // eBay prelist: type the title, let eBay suggest category/catalog
        await page.goto('https://www.ebay.com/sl/prelist/suggest', { waitUntil: 'domcontentloaded' });
        await this.delay(3500);
        const input = await page.$('input[placeholder*="what you" i], input[aria-label*="Tell us" i], .se-search-box__field input, input[type="text"]');
        if (!input) throw new Error('prelist search box not found');
        await input.click();
        await input.type(cleanItemTitle.slice(0, 65), { delay: 15 });
        await this.delay(800);
        await page.keyboard.press('Enter');
        await this.delay(4000);

        // Prelist is a multi-step wizard (catalog match → condition → form) with
        // category-dependent variants. Loop: detect what's on screen, act, repeat.
        let onForm = false;
        for (let step = 0; step < 10; step++) {
          const state = await page.evaluate(() => {
            const text = document.body.innerText;
            return {
              form: /complete your listing|listing details|item specifics|photos & video/i.test(text) || location.pathname.includes('/lstng'),
              category: /provide a category for your item/i.test(text),
              withoutMatch: !!([...document.querySelectorAll('button, a')].find(e => /continue without match|create new listing/i.test((e.textContent || '').trim()))),
              condition: /select (the )?condition/i.test(text),
            };
          }).catch(() => ({}));

          if (state.form) { onForm = true; break; }

          if (state.category) {
            // "Provide a category" page — pick the first suggested path, then Done
            const picked = await page.evaluate(() => {
              const els = [...document.querySelectorAll('button, a, li, label, div[role="option"], span')]
                .filter(e => e.offsetParent !== null && / > /.test((e.textContent || '').trim()) && (e.textContent || '').length < 150);
              if (!els.length) return null;
              els[0].click();
              return els[0].textContent.trim().slice(0, 60);
            }).catch(() => null);
            progress({ text: `  category: ${picked || 'not found?'}` });
            await this.delay(1200);
            await page.evaluate(() => {
              const done = [...document.querySelectorAll('button')].find(e => /^done$/i.test((e.textContent || '').trim()));
              if (done) done.click();
            }).catch(() => {});
            await this.delay(3500);
            continue;
          }

          if (state.withoutMatch) {
            await page.evaluate(() => {
              const btn = [...document.querySelectorAll('button, a')].find(e =>
                /continue without match|create new listing/i.test((e.textContent || '').trim()));
              if (btn) btn.click();
            }).catch(() => {});
            await this.delay(3000);
            continue;
          }

          if (state.condition) {
            // Pick the "newest" condition this category offers, THEN continue.
            // Options are custom components whose text includes a description —
            // match on the FIRST LINE only, and click real radios when present.
            const picked = await page.evaluate(() => {
              const firstLine = (e) => ((e.innerText || e.textContent || '').trim().split('\n')[0] || '').trim().toLowerCase();
              const prefs = ['new', 'new with tags', 'brand new', 'new with box', 'new without tags', 'new without box', 'new other'];

              // 1. Real radio inputs (label text or aria-label)
              const radios = [...document.querySelectorAll('input[type="radio"]')];
              for (const pref of prefs) {
                const r = radios.find(r => {
                  const lbl = (r.labels?.[0]?.innerText || r.getAttribute('aria-label') || '').trim().split('\n')[0].toLowerCase();
                  return lbl === pref;
                });
                if (r) {
                  r.click();
                  r.dispatchEvent(new Event('change', { bubbles: true }));
                  (r.labels?.[0])?.click();
                  return pref + ' (radio)';
                }
              }
              // 2. Any clickable whose first line matches
              const clickables = [...document.querySelectorAll('label, [role="radio"], [role="button"], button, div, span')]
                .filter(e => e.offsetParent !== null && (e.innerText || '').length < 250);
              for (const pref of prefs) {
                const el = clickables.find(e => firstLine(e) === pref);
                if (el) { el.click(); return pref; }
              }
              return null;
            }).catch(() => null);
            await this.delay(1200);
            await page.evaluate(() => {
              const cont = [...document.querySelectorAll('button')].find(e =>
                /continue to listing|^continue$/i.test((e.textContent || '').trim()));
              if (cont) cont.click();
            }).catch(() => {});
            progress({ text: `  condition: ${picked || 'not found?'} → continue` });
            await this.delay(4000);
            continue;
          }

          await this.delay(2500);
        }
        if (!onForm) {
          // Dump for debugging — posting flow needs live iteration like checkout did
          const fs = require('fs');
          const text = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
          fs.appendFileSync(path.join(app.getPath('userData'), 'post-debug.txt'),
            `\n===== ${item.id} ${new Date().toISOString()} =====\nURL: ${page.url()}\n${text}\n`, 'utf8');
          throw new Error(`didn't reach listing form (${page.url().slice(0, 60)}) — dumped to post-debug.txt`);
        }

        // Upload the Amazon photos into eBay's photo uploader
        if (images.length) {
          try {
            const fileInput = await page.$('input[type="file"]');
            if (fileInput) {
              await fileInput.uploadFile(...images);
              progress({ text: `  📷 ${images.length} photos uploaded to draft` });
              await this.delay(5000); // give eBay time to process uploads
            } else {
              progress({ text: '  ⚠ photo upload input not found — add photos manually in the draft' });
            }
          } catch (e) { progress({ text: `  ⚠ photo upload failed: ${e.message}` }); }
        }

        // Fill price via mouse click + keyboard (React ignores .value assignment)
        const priceBox = await page.evaluate(() => {
          const inp = [...document.querySelectorAll('input')]
            .find(e => /price/i.test(e.getAttribute('aria-label') || '') || /price/i.test(e.name || ''));
          if (!inp) return null;
          inp.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = inp.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }).catch(() => null);
        if (priceBox) {
          await page.mouse.click(priceBox.x, priceBox.y);
          await this.delay(200);
          await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
          await page.keyboard.type(String(item.our_price), { delay: 30 });
          progress({ text: `  ✓ price set: $${item.our_price}` });
        } else {
          progress({ text: '  ⚠ price input not found' });
        }
        await this.delay(800);

        // Fill AI-generated title into the listing form title field
        if (generatedTitle) {
          const titleBox = await page.evaluate(() => {
            const inp = document.querySelector('input[name="title"], input[aria-label*="title" i], input[id*="title" i]');
            if (!inp) return null;
            inp.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = inp.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }).catch(() => null);
          if (titleBox) {
            await page.mouse.click(titleBox.x, titleBox.y);
            await this.delay(400);
            // eBay's title field opens an autosuggest dropdown on focus — typing
            // immediately lets the dropdown eat the first few keystrokes before
            // it settles, which is why titles were coming out cut off at the
            // start. Dismiss it and explicitly clear the field before typing.
            await page.keyboard.press('Escape').catch(() => {});
            await this.delay(200);
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await this.delay(200);
            await page.keyboard.type(generatedTitle.slice(0, 80), { delay: 25 });
            await this.delay(300);
            const typedOk = await page.evaluate(() => {
              const inp = document.querySelector('input[name="title"], input[aria-label*="title" i], input[id*="title" i]');
              return inp ? inp.value : '';
            }).catch(() => '');
            if (typedOk.length < generatedTitle.slice(0, 80).length * 0.8) {
              progress({ text: `  ⚠ title may be incomplete (got ${typedOk.length}/${generatedTitle.slice(0, 80).length} chars) — check post-debug.txt` });
            } else {
              progress({ text: `  ✓ title: ${generatedTitle.slice(0, 60)}` });
            }
          }
          await this.delay(600);
        }

        // Click eBay's built-in AI description button instead of generating ourselves
        {
          const aiBtn = await page.evaluate(() => {
            // eBay labels their AI description button variously depending on listing form version
            const candidates = [...document.querySelectorAll('button, a, span[role="button"]')].filter(el => {
              if (!el.offsetParent) return false;
              const t = (el.innerText || el.textContent || '').trim().toLowerCase();
              return /use ai|ai description|generate description|listing ai|magic listing|write with ai|ai-assisted|ai assist/i.test(t)
                || el.getAttribute('aria-label')?.toLowerCase().includes('ai');
            });
            if (!candidates.length) return null;
            candidates[0].scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = candidates[0].getBoundingClientRect();
            return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, label: candidates[0].textContent.trim().slice(0, 40) } : null;
          }).catch(() => null);

          if (aiBtn) {
            await page.mouse.click(aiBtn.x, aiBtn.y);
            progress({ text: `  ✦ clicked eBay AI description button ("${aiBtn.label}")` });
            // Wait for eBay to generate and populate the description (up to 12s)
            await this.delay(3000);
            const populated = await page.evaluate(() => {
              const rte = document.querySelector('iframe[name="se-rte-frame__summary"]');
              try { return (rte?.contentDocument?.body?.innerText?.trim()?.length || 0) > 20; } catch(_) { return false; }
            }).catch(() => false);
            if (populated) {
              progress({ text: '  ✓ eBay AI description populated' });
            } else {
              // Give it more time — eBay AI can be slow
              await this.delay(5000);
              progress({ text: '  ⚠ eBay AI description may still be loading — continuing' });
            }
          } else {
            progress({ text: '  ⚠ eBay AI description button not found — description left blank' });
          }
          await this.delay(500);
        }

        // ── Item specifics ──────────────────────────────────────
        // Dump the full form HTML so we know exactly what selectors to use
        try {
          const fs = require('fs');
          const formHtml = await page.evaluate(() => {
            // Grab the item specifics section + any Required section
            const sections = [...document.querySelectorAll('section, [data-testid], .itemspecifics, form')]
              .filter(e => /required|item specific|brand|color/i.test(e.textContent || '') && e.textContent.length < 8000);
            return sections.length
              ? sections.map(s => s.outerHTML.slice(0, 3000)).join('\n---\n')
              : document.body.innerHTML.slice(0, 5000);
          }).catch(() => '(err)');
          fs.appendFileSync(require('path').join(require('electron').app.getPath('userData'), 'post-debug.txt'),
            `\n===== ITEM SPECIFICS FORM ${new Date().toISOString()} =====\n${formHtml}\n`, 'utf8');
        } catch (_) {}

        // 1. "Apply all" — must use page.mouse.click() (eBay swallows .click())
        const applyAllBox = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('a, button')].find(e =>
            /^apply all$/i.test((e.textContent || '').trim()) && e.offsetParent !== null);
          if (!btn) return null;
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = btn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }).catch(() => null);
        if (applyAllBox) {
          await page.mouse.click(applyAllBox.x, applyAllBox.y);
          progress({ text: '  ✓ applied all suggested specifics' });
          await this.delay(2000);
        }

        // 2. Fill each empty Required attribute dropdown using eBay's real DOM structure:
        //    button.fake-menu-button__button[name="attributes.FIELD"] → open → type in
        //    input[name="search-box-attributesFIELD"] → click div.menu__item[role="menuitemradio"]
        //    Also handle "Suggested: X" links that appear below Color fields.
        // Collect empty required attribute fields — scoped to the Required fieldset only,
        // scroll each into view so getBoundingClientRect() returns in-viewport coordinates.
        const emptyFields = await page.evaluate(() => {
          const hardDefaults = { Brand: 'Unbranded', Color: 'Multicolor' };
          const results = [];
          const requiredSection = [...document.querySelectorAll('fieldset')].find(f =>
            /^required$/i.test((f.querySelector('legend')?.textContent || '').trim()));
          const scope = requiredSection || document;
          for (const btn of scope.querySelectorAll('button.fake-menu-button__button[name^="attributes."]')) {
            const fieldName = btn.getAttribute('name').replace('attributes.', '');
            const currentVal = (btn.querySelector('.btn__text')?.textContent || '').trim();
            if (currentVal) continue;
            btn.scrollIntoView({ block: 'center', behavior: 'instant' });
            // Check for a "Suggested: X" link in the same row
            let suggestedBox = null;
            const row = btn.closest('[data-testid="attribute"]') || btn.closest('.summary__attributes--field');
            if (row) {
              for (const el of row.querySelectorAll('span, div, p, a')) {
                if (!/^suggested:/i.test((el.textContent || '').trim())) continue;
                const link = el.querySelector('a') || (el.tagName === 'A' ? el : null)
                  || (el.nextElementSibling?.tagName === 'A' ? el.nextElementSibling : null)
                  || el.nextElementSibling?.querySelector?.('a');
                if (link && link.offsetParent !== null) {
                  const r = link.getBoundingClientRect();
                  if (r.width > 0) suggestedBox = { x: r.left + r.width / 2, y: r.top + r.height / 2, text: link.textContent.trim() };
                }
              }
            }
            // For fields with no hardcoded default, grab the first option text from the dropdown list
            let defaultVal = hardDefaults[fieldName] || null;
            if (!defaultVal) {
              const menuId = btn.getAttribute('aria-controls');
              const menu = menuId ? document.getElementById(menuId) : null;
              const firstOpt = (menu || btn.closest('.fake-menu-button'))
                ?.querySelector('div.menu__item[role="menuitemradio"] span');
              if (firstOpt) defaultVal = firstOpt.textContent.trim();
            }
            const r = btn.getBoundingClientRect();
            results.push({ fieldName, btnX: r.left + r.width / 2, btnY: r.top + r.height / 2, suggestedBox, defaultVal });
          }
          return results;
        }).catch(() => []);

        progress({ text: `  ⌕ found ${emptyFields.length} empty required field(s): ${emptyFields.map(f => f.fieldName).join(', ') || 'none'}` });

        for (const field of emptyFields) {
          // Scroll the button into view fresh before each interaction
          await page.evaluate((fn) => {
            const btn = document.querySelector(`button.fake-menu-button__button[name="attributes.${fn}"]`);
            if (btn) btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          }, field.fieldName).catch(() => {});
          await this.delay(400);

          // Re-read coordinates after scroll
          const coords = await page.evaluate((fn) => {
            const btn = document.querySelector(`button.fake-menu-button__button[name="attributes.${fn}"]`);
            if (!btn) return null;
            // Check suggested link again at current scroll position
            let suggestedBox = null;
            const row = btn.closest('[data-testid="attribute"]') || btn.closest('.summary__attributes--field');
            if (row) {
              for (const el of row.querySelectorAll('span, div, p, a')) {
                if (!/^suggested:/i.test((el.textContent || '').trim())) continue;
                const link = el.querySelector('a') || (el.tagName === 'A' ? el : null)
                  || (el.nextElementSibling?.tagName === 'A' ? el.nextElementSibling : null)
                  || el.nextElementSibling?.querySelector?.('a');
                if (link && link.offsetParent !== null) {
                  const r = link.getBoundingClientRect();
                  if (r.width > 0) suggestedBox = { x: r.left + r.width / 2, y: r.top + r.height / 2, text: link.textContent.trim() };
                }
              }
            }
            const r = btn.getBoundingClientRect();
            return { btnX: r.left + r.width / 2, btnY: r.top + r.height / 2, suggestedBox };
          }, field.fieldName).catch(() => null);
          if (!coords) continue;

          // Prefer clicking the "Suggested:" link
          if (coords.suggestedBox) {
            await page.mouse.click(coords.suggestedBox.x, coords.suggestedBox.y);
            progress({ text: `  ✓ ${field.fieldName} → ${coords.suggestedBox.text} (suggested)` });
            await this.delay(800);
            continue;
          }
          if (!field.defaultVal) continue;

          // Click the dropdown button to open it
          await page.mouse.click(coords.btnX, coords.btnY);
          await this.delay(800);

          // Click the search input inside the now-open dropdown
          const searchBox = await page.evaluate((fn) => {
            const inp = document.querySelector(`input[name="search-box-attributes${fn}"]`);
            if (!inp || !inp.offsetParent) return null;
            const r = inp.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }, field.fieldName).catch(() => null);

          if (searchBox) {
            await page.mouse.click(searchBox.x, searchBox.y);
            await this.delay(200);
          }
          await page.keyboard.type(field.defaultVal, { delay: 40 }).catch(() => {});
          await this.delay(800);

          // Click the matching option
          const optBox = await page.evaluate((val) => {
            const opts = [...document.querySelectorAll('div.menu__item[role="menuitemradio"]')]
              .filter(o => o.offsetParent !== null);
            const match = opts.find(o => (o.querySelector('span')?.textContent || '').trim().toLowerCase() === val.toLowerCase())
              || opts.find(o => (o.querySelector('span')?.textContent || '').trim().toLowerCase().startsWith(val.toLowerCase()));
            if (!match) return null;
            const r = match.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (match.querySelector('span')?.textContent || '').trim() };
          }, field.defaultVal).catch(() => null);

          if (optBox) {
            await page.mouse.click(optBox.x, optBox.y);
            progress({ text: `  ✓ ${field.fieldName} → ${optBox.text}` });
          } else {
            await page.keyboard.press('Escape').catch(() => {});
            progress({ text: `  ⚠ ${field.fieldName}: option "${field.defaultVal}" not found in dropdown` });
          }
          await this.delay(800);
        }

        // Fill Expiration Date if present (perishable products like supplements)
        // Uses today + 2 years since we never physically handle the product
        const expiryDate = (() => {
          const d = new Date();
          d.setFullYear(d.getFullYear() + 2);
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const yyyy = d.getFullYear();
          return `${mm}/${yyyy}`;
        })();
        const expiryField = await page.evaluate(() => {
          // Use innerText (rendered) and require short text so we don't match a container div
          const candidates = [...document.querySelectorAll('label, span, div, td, th, p')].filter(el => {
            if (!el.offsetParent) return false;
            const t = (el.innerText || el.textContent || '').trim();
            return /expir(ation)?\s*date/i.test(t) && t.length < 60;
          });
          if (!candidates.length) return null;
          // Prefer the smallest (most specific) matching element
          candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
          const label = candidates[0];
          const row = label.closest('[data-testid="attribute"]')
            || label.closest('.summary__attributes--field')
            || label.closest('tr')
            || label.parentElement;
          const inp = row?.querySelector('input[type="text"], input[type="date"], input:not([type="hidden"])');
          if (!inp) return null;
          inp.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = inp.getBoundingClientRect();
          return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        }).catch(() => null);
        if (expiryField) {
          await page.mouse.click(expiryField.x, expiryField.y);
          await this.delay(200);
          await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
          await page.keyboard.type(expiryDate, { delay: 30 });
          await page.keyboard.press('Tab');
          progress({ text: `  ✓ Expiration Date → ${expiryDate}` });
          await this.delay(400);
        }

        // Check if any REQUIRED (not optional) fields are still empty
        const stillEmptyFields = await page.evaluate(() => {
          const req = [...document.querySelectorAll('fieldset')].find(f =>
            /^required$/i.test((f.querySelector('legend')?.textContent || '').trim()));
          const scope = req || document;
          return [...scope.querySelectorAll('button.fake-menu-button__button[name^="attributes."]')]
            .filter(b => !(b.querySelector('.btn__text')?.textContent || '').trim())
            .map(b => b.getAttribute('name').replace('attributes.', ''));
        }).catch(() => []);
        if (stillEmptyFields.length) progress({ text: `  ⚠ still empty: ${stillEmptyFields.join(', ')}` });

        // Submit or leave as draft
        const blocked = await page.evaluate(() => {
          if (/additional details are required/i.test(document.body.innerText)) return true;
          const req = [...document.querySelectorAll('fieldset')].find(f =>
            /^required$/i.test((f.querySelector('legend')?.textContent || '').trim()));
          if (!req) return false;
          return [...req.querySelectorAll('button.fake-menu-button__button[name^="attributes."]')]
            .some(b => !(b.querySelector('.btn__text')?.textContent || '').trim());
        }).catch(() => false);

        if (autoSubmit && !blocked) {
          const clicked = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(e =>
              /^list it( now)?$/i.test((e.textContent || '').trim()));
            if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
            return false;
          }).catch(() => false);
          if (!clicked) {
            db.updateQueueItem(item.id, { status: 'drafted' });
            progress({ text: '  ⚠ "List it" button not found — left as draft' });
          } else {
            let live = false, ebayItemId = '';
            for (let w = 0; w < 12 && !live; w++) {
              await this.delay(2000);
              const r = await page.evaluate(() => ({
                live: /your item is listed|listing is live|congrats|view your listing|item listed/i.test(document.body.innerText) || !location.pathname.includes('/lstng'),
                itemId: ([...document.querySelectorAll('a[href*="/itm/"]')].map(a => a.href.match(/\/itm\/(\d+)/)?.[1]).find(Boolean)) || '',
              })).catch(() => null);
              if (r?.live) { live = true; ebayItemId = r.itemId; }
            }
            if (live) {
              db.updateQueueItem(item.id, { status: 'posted', ebay_item_id: ebayItemId });
              db.addToBank({ ...item, ebay_item_id: ebayItemId });
              progress({ text: `  ✅ LISTED${ebayItemId ? ' — item ' + ebayItemId : ''}` });
            } else {
              db.updateQueueItem(item.id, { status: 'drafted' });
              progress({ text: '  ⚠ clicked List it but no confirmation — check eBay (left as drafted)' });
            }
          }
        } else {
          db.updateQueueItem(item.id, { status: 'drafted' });
          progress({ text: blocked && autoSubmit
            ? '  ⚠ required fields still empty — left as draft for manual fix'
            : '  ✓ draft ready — review and click "List it"' });
        }
      } catch (e) {
        db.updateQueueItem(item.id, { status: 'post_error', last_error: e.message });
        progress({ text: `  ✕ ${e.message}` });
        clearTimeout(_pageTimeout);
        await page.close().catch(() => {});
        return { posted: 0, failed: 1 };
      }
      clearTimeout(_pageTimeout);
      await page.close().catch(() => {});
      await this.delay(1500);
      return { posted: 1, failed: 0 };
    } catch (outerErr) {
      db.updateQueueItem(item.id, { status: 'post_error', last_error: outerErr.message });
      progress({ text: `  ✕ ${outerErr.message}` });
      return { posted: 0, failed: 1 };
    }
  },

  // ── Listing refresher ─────────────────────────────────────────
  // Scrapes Seller Hub active listings, ends ones older than `days`,
  // then navigates to the ended listing and clicks Relist to repost.
  async refreshListings({ days = 30, limit = 10 } = {}, progress = () => {}, accountId = 'acc1') {
    stopped = false;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let refreshed = 0, failed = 0, skipped = 0;

    progress({ text: `⌕ Loading active listings from Seller Hub…` });
    const active = await this._getSellerHubActive(progress);
    progress({ text: `  Found ${active.length} active listing(s)` });

    // Scrape listing dates from Seller Hub (we need to visit the active list with dates)
    const page = await Pipeline.newPage();
    let candidates = [];
    try {
      let offset = 0;
      while (candidates.length < limit * 3) {
        await page.goto(`https://www.ebay.com/sh/lst/active?limit=200&offset=${offset}`, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);
        const rows = await page.evaluate(() => {
          const out = [];
          // Each listing row — grab item ID, title, and the date text
          for (const row of document.querySelectorAll('tr, [class*="listing-row"], [class*="list-item"]')) {
            const link = row.querySelector('a[href*="/itm/"]');
            if (!link) continue;
            const id = (link.href.match(/\/itm\/(\d+)/) || [])[1];
            if (!id) continue;
            const title = link.textContent.trim();
            // eBay shows dates in columns — look for anything that parses as a date
            const dateEls = [...row.querySelectorAll('td, span, div')].filter(e => {
              const t = e.textContent.trim();
              return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b.*\d{4}/i.test(t) && t.length < 40;
            });
            const dateText = dateEls[0]?.textContent?.trim() || '';
            out.push({ id, title, dateText });
          }
          return out;
        }).catch(() => []);

        if (!rows.length) break;
        for (const r of rows) {
          const parsed = r.dateText ? new Date(r.dateText) : null;
          // If we can't parse the date, include it anyway (eBay date format varies)
          candidates.push({ ...r, listedAt: parsed && !isNaN(parsed) ? parsed : null });
        }
        if (rows.length < 200) break;
        offset += 200;
      }
    } finally { await page.close().catch(() => {}); }

    // Filter: keep listings whose parsed date is before cutoff, or unparseable (treat as old)
    const toRefresh = candidates
      .filter(c => !c.listedAt || c.listedAt < cutoff)
      .slice(0, limit);

    if (!toRefresh.length) {
      progress({ text: `  ✓ No listings older than ${days} days found — nothing to refresh` });
      return { refreshed: 0, failed: 0, skipped: candidates.length };
    }

    progress({ text: `  ${toRefresh.length} listing(s) eligible for refresh` });
    skipped = Math.max(0, candidates.length - toRefresh.length);

    for (const listing of toRefresh) {
      if (stopped) { progress({ text: '■ stopped' }); break; }
      progress({ text: `⟳ ${listing.title.slice(0, 50)} (${listing.id})` });

      try {
        // Step 1: End the listing via Seller Hub
        const endPage = await Pipeline.newPage();
        const endTimeout = setTimeout(() => endPage.close().catch(() => {}), 3 * 60 * 1000);
        try {
          // Go to the listing's action menu on Seller Hub
          await endPage.goto(`https://www.ebay.com/sh/lst/active?limit=200`, { waitUntil: 'domcontentloaded' });
          await this.delay(2500);

          // Find and click the action menu for this listing ID
          const menuBox = await endPage.evaluate((itemId) => {
            // Find the row containing this item ID
            const link = [...document.querySelectorAll('a[href*="/itm/"]')]
              .find(a => a.href.includes(`/itm/${itemId}`));
            if (!link) return null;
            const row = link.closest('tr') || link.closest('[class*="row"]') || link.parentElement;
            if (!row) return null;
            // Action button is typically "..." or "Actions" or a kebab menu
            const actionBtn = row.querySelector('[aria-label*="action" i], [title*="action" i], button[class*="overflow"], button[class*="menu"], button[class*="more"]')
              || [...row.querySelectorAll('button')].find(b => /^(\.\.\.|⋮|actions?)$/i.test(b.textContent.trim()));
            if (!actionBtn) return null;
            actionBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = actionBtn.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }, listing.id).catch(() => null);

          if (menuBox) {
            await endPage.mouse.click(menuBox.x, menuBox.y);
            await this.delay(800);
            // Click "End listing" in the dropdown
            const endBox = await endPage.evaluate(() => {
              const el = [...document.querySelectorAll('a, button, [role="menuitem"]')]
                .find(e => /end listing/i.test(e.textContent) && e.offsetParent);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }).catch(() => null);
            if (endBox) {
              await endPage.mouse.click(endBox.x, endBox.y);
              await this.delay(2000);
              // Confirm the end dialog if one appears
              await endPage.evaluate(() => {
                const confirmBtn = [...document.querySelectorAll('button')].find(b =>
                  /^(end|confirm|yes|submit)$/i.test(b.textContent.trim()));
                if (confirmBtn) confirmBtn.click();
              }).catch(() => {});
              await this.delay(2000);
              progress({ text: `  ✓ ended listing ${listing.id}` });
            } else {
              // Fallback: direct end URL
              await endPage.goto(`https://offer.ebay.com/ws/eBayISAPI.dll?EndingMultipleItems&itemId=${listing.id}`, { waitUntil: 'domcontentloaded' });
              await this.delay(2000);
              await endPage.evaluate(() => {
                const btn = document.querySelector('input[type="submit"], button[type="submit"]');
                if (btn) btn.click();
              }).catch(() => {});
              await this.delay(2000);
              progress({ text: `  ✓ ended listing ${listing.id} (fallback)` });
            }
          } else {
            // Fallback: navigate directly to end URL
            await endPage.goto(`https://offer.ebay.com/ws/eBayISAPI.dll?EndingMultipleItems&itemId=${listing.id}`, { waitUntil: 'domcontentloaded' });
            await this.delay(2000);
            await endPage.evaluate(() => {
              const btn = document.querySelector('input[type="submit"], button[type="submit"]');
              if (btn) btn.click();
            }).catch(() => {});
            await this.delay(2000);
            progress({ text: `  ✓ ended listing ${listing.id} (direct URL)` });
          }

          // Step 2: Navigate to the ended listing and click Relist
          await this.delay(3000);
          await endPage.goto(`https://www.ebay.com/itm/${listing.id}`, { waitUntil: 'domcontentloaded' });
          await this.delay(2500);

          // eBay shows a "Relist" button on ended listings (seller view)
          const relistBox = await endPage.evaluate(() => {
            const el = [...document.querySelectorAll('a, button')].find(e =>
              /^relist/i.test(e.textContent.trim()) && e.offsetParent);
            if (!el) return null;
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, href: el.href || '' };
          }).catch(() => null);

          if (!relistBox) {
            // Try Seller Hub unsold/ended listings page
            await endPage.goto(`https://www.ebay.com/sh/lst/unsold?limit=200`, { waitUntil: 'domcontentloaded' });
            await this.delay(2500);
            const relistBox2 = await endPage.evaluate((itemId) => {
              const link = [...document.querySelectorAll('a[href*="/itm/"]')]
                .find(a => a.href.includes(`/itm/${itemId}`));
              const row = link?.closest('tr') || link?.closest('[class*="row"]');
              const btn = row && [...row.querySelectorAll('a, button')].find(e => /relist/i.test(e.textContent));
              if (!btn) return null;
              btn.scrollIntoView({ block: 'center', behavior: 'instant' });
              const r = btn.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, href: btn.href || '' };
            }, listing.id).catch(() => null);

            if (!relistBox2) {
              progress({ text: `  ⚠ ended but couldn't find Relist button — relist manually` });
              failed++;
              continue;
            }
            if (relistBox2.href) {
              await endPage.goto(relistBox2.href, { waitUntil: 'domcontentloaded' });
            } else {
              await endPage.mouse.click(relistBox2.x, relistBox2.y);
            }
          } else if (relistBox.href) {
            await endPage.goto(relistBox.href, { waitUntil: 'domcontentloaded' });
          } else {
            await endPage.mouse.click(relistBox.x, relistBox.y);
          }

          await this.delay(4000);

          // Now we're on the relist form — just click "List it" to submit as-is
          const listed = await endPage.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(e =>
              /^list it( now)?$/i.test((e.textContent || '').trim()));
            if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
            return false;
          }).catch(() => false);

          if (listed) {
            let live = false, newItemId = '';
            for (let w = 0; w < 12 && !live; w++) {
              await this.delay(2000);
              const r = await endPage.evaluate(() => ({
                live: /your item is listed|listing is live|congrats|view your listing|item listed/i.test(document.body.innerText),
                itemId: ([...document.querySelectorAll('a[href*="/itm/"]')].map(a => a.href.match(/\/itm\/(\d+)/)?.[1]).find(Boolean)) || '',
              })).catch(() => null);
              if (r?.live) { live = true; newItemId = r.itemId; }
            }
            if (live) {
              progress({ text: `  ✅ relisted${newItemId ? ' — new item ' + newItemId : ''}` });
              refreshed++;
            } else {
              progress({ text: `  ⚠ clicked List it but no confirmation page — check eBay` });
              failed++;
            }
          } else {
            progress({ text: `  ⚠ on relist form but "List it" not found — left as draft` });
            failed++;
          }
        } finally {
          clearTimeout(endTimeout);
          await endPage.close().catch(() => {});
        }
      } catch (e) {
        progress({ text: `  ✕ ${listing.id}: ${e.message}` });
        failed++;
      }

      await this.delay(2000);
    }

    return { refreshed, failed, skipped };
  },

  async postItems(itemIds, { autoSubmit = false } = {}, progress = () => {}, accountId = 'acc1') {
    stopped = false;
    const db = DB.forAccount(accountId);
    const Store = require('electron-store');
    const apiKey = new Store().get('anthropicKey');
    const Generate = require('./generate');
    const opts = { autoSubmit, apiKey, Generate, db };

    const queue = db.getQueue().filter(q => itemIds.includes(q.id) && q.our_price && q.asin);
    let posted = 0, failed = 0;

    // One item at a time — running 2 concurrently raced two Puppeteer pages
    // against the same browser and caused intermittent "Requesting main
    // frame too early" navigation errors plus cross-contaminated AI input.
    // NOTE: the tab cycler is deliberately NOT used here — it calls
    // bringToFront() on other tabs on a timer, which steals focus away from
    // the tab mid page.mouse.click()/page.keyboard.type() during description
    // fill. That caused stray clicks to land on the wrong (frontmost) page,
    // popping a real browser context menu whose text ("Open link in new
    // tab") then got typed/scraped into the listing description.
    for (let i = 0; i < queue.length; i++) {
      if (stopped) { progress({ text: '■ stopped by user' }); break; }
      const item = queue[i];
      progress({ text: `▲ Posting: ${(item.title || '').slice(0, 50)}...` });
      const r = await this.postSingleItem(item, opts, progress);
      posted += r.posted; failed += r.failed;
    }

    return { success: true, posted, failed };
  }
};

module.exports = Engine;
