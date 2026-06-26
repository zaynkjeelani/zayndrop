// src/fill/pipeline.js — ZaynDrop Fill v1.8

const puppeteer = require('puppeteer');
const path = require('path');
const { app } = require('electron');
const DB = require('../shared/db');

let browsers = {};
let running = {};
let cyclerIntervals = {};
let cyclerIndices = {};

const Pipeline = {

  delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  wordOverlap(a, b) {
    if (!a || !b) return 0;
    const wa = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wb = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let common = 0;
    wa.forEach(w => { if (wb.has(w)) common++; });
    return common / Math.max(wa.size, wb.size, 1);
  },

  stop(accountId = 'acc1') { running[accountId] = false; },
  isBrowserOpen(accountId = 'acc1') { return !!(browsers[accountId] && browsers[accountId].isConnected()); },

  startTabCycler(accountId = 'acc1') {
    if (cyclerIntervals[accountId]) return;
    cyclerIndices[accountId] = 0;
    cyclerIntervals[accountId] = setInterval(async () => {
      try {
        const b = browsers[accountId];
        if (!b || !b.isConnected()) return;
        const pages = await b.pages();

        for (const p of pages) {
          try {
            const text = await Promise.race([
              p.evaluate(() => document.body && document.body.innerText || ''),
              new Promise(r => setTimeout(() => r(''), 1000)),
            ]);
            if (/your listing is now live|listing is now live/i.test(text)) {
              await p.close().catch(() => {});
            }
          } catch (_) {}
        }

        const remaining = await b.pages();
        if (!remaining.length) return;
        cyclerIndices[accountId] = (cyclerIndices[accountId] + 1) % remaining.length;
        await remaining[cyclerIndices[accountId]].bringToFront().catch(() => {});
      } catch (_) {}
    }, 3000);
  },

  stopTabCycler(accountId = 'acc1') {
    if (cyclerIntervals[accountId]) {
      clearInterval(cyclerIntervals[accountId]);
      delete cyclerIntervals[accountId];
      delete cyclerIndices[accountId];
    }
  },

  // ── Get or launch browser ──────────────────────────────────────
  async getBrowser(accountId = 'acc1') {
    if (browsers[accountId] && browsers[accountId].isConnected()) return browsers[accountId];

    const fs   = require('fs');
    const os   = require('os');
    const { execSync } = require('child_process');

    // Find Chrome executable
    const possibleChrome = [
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    let executablePath = null;
    for (const p of possibleChrome) {
      try { if (fs.existsSync(p)) { executablePath = p; break; } } catch (_) {}
    }

    // Each account gets its own profile directory so they can run simultaneously
    const puppeteerUserData = path.join(app.getPath('userData'), 'profiles', accountId);
    fs.mkdirSync(puppeteerUserData, { recursive: true });

    // If a previous Puppeteer browser is still running (e.g. ZaynDrop restarted mid-run),
    // reconnect to it via DevToolsActivePort instead of trying to launch a new instance.
    const devToolsPortFile = path.join(puppeteerUserData, 'DevToolsActivePort');
    if (fs.existsSync(devToolsPortFile)) {
      try {
        const port = parseInt(fs.readFileSync(devToolsPortFile, 'utf8').split('\n')[0]);
        if (port > 0) {
          browser = await puppeteer.connect({ browserURL: `http://localhost:${port}`, defaultViewport: null });
          browser.on('disconnected', () => { browser = null; });
          return browser;
        }
      } catch (_) {
        // Can't reconnect — fall through to fresh launch
      }
    }

    // Clear all stale lock files before launching fresh
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'DevToolsActivePort']) {
      try { fs.rmSync(path.join(puppeteerUserData, f), { force: true }); } catch (_) {}
    }
    try { fs.rmSync(path.join(puppeteerUserData, 'Default', 'LOCK'), { force: true }); } catch (_) {}

    const launchOpts = {
      headless: false,
      userDataDir: puppeteerUserData,
      defaultViewport: null,
      // pipe: true breaks page.evaluate in Electron — leave it off
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-infobars',
        '--start-maximized',
        '--remote-debugging-port=0',
      ],
    };

    // Try with explicit path first, fall back to Puppeteer's channel auto-detect
    let browser;
    try {
      browser = await puppeteer.launch({ ...launchOpts, executablePath: executablePath || undefined });
    } catch (e1) {
      try {
        browser = await puppeteer.launch({ ...launchOpts, channel: 'chrome', executablePath: undefined });
      } catch (e2) {
        throw new Error(`Could not launch browser.\nPath tried: ${executablePath || 'none'}\nError: ${e1.message}`);
      }
    }

    browsers[accountId] = browser;
    browser.on('disconnected', () => { delete browsers[accountId]; });

    // Open a visible eBay tab
    try {
      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      await page.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (_) {}

    return browser;
  },

  async newPage(accountId = 'acc1') {
    const b = await this.getBrowser(accountId);
    const page = await b.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    // Hide Puppeteer fingerprints — eBay/Amazon detect navigator.webdriver and block
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
      const orig = navigator.permissions.query;
      navigator.permissions.query = (p) =>
        p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig.call(navigator.permissions, p);
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    return page;
  },

  // ── Open browser for login — stays open until closeBrowser() ──
  async openForLogin(accountId = 'acc1') {
    const b = await this.getBrowser(accountId);
    const pages = await b.pages();
    const ebayPage = pages[0] || await b.newPage();
    await ebayPage.goto('https://signin.ebay.com/signin/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const amazonPage = await b.newPage();
    await amazonPage.goto('https://www.amazon.com/gp/sign-in.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    return { success: true };
  },

  async closeBrowser(accountId = 'acc1') {
    const b = browsers[accountId];
    if (b && b.isConnected()) {
      await b.close().catch(() => {});
      delete browsers[accountId];
    }
    return { success: true };
  },

  async checkLoginStatus(accountId = 'acc1') {
    try {
      const b = await this.getBrowser(accountId);
      const page = await b.newPage();
      let ebay = false, amazon = false;

      try {
        await page.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.delay(1500);
        ebay = await page.evaluate(() =>
          document.body.innerText.includes('Hi ') || !!document.querySelector('#gh-ug')
        ).catch(() => false);
      } catch (_) {}

      try {
        await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.delay(1500);
        amazon = await page.evaluate(() => {
          const el = document.querySelector('#nav-link-accountList-nav-line-1');
          return !!(el && !el.textContent.toLowerCase().includes('sign in'));
        }).catch(() => false);
      } catch (_) {}

      await page.close();
      return { ebay, amazon };
    } catch (e) {
      return { ebay: false, amazon: false, error: e.message };
    }
  },

  // ── Main scan pipeline ─────────────────────────────────────────
  async runScan(options = {}, emit, accountId = 'acc1') {
    running[accountId] = true;
    this._emit = emit;
    const db = DB.forAccount(accountId);
    const log = (type, text) => emit('scan-log', { type, text });
    const stats = { imported: 0, addressed: 0, matched: 0, fulfilled: 0, tracked: 0, messaged: 0, errors: 0 };

    log('heading', '⬡ ZAYNDROP FILL — SCAN STARTED');

    // Step 1: Scrape eBay orders
    if (options.scrapeEbay !== false && running[accountId]) {
      log('info', 'Step 1 — Scraping eBay orders...');
      try {
        const filters = options.ebayFilters?.length ? options.ebayFilters : ['awaiting_ship'];
        const EBAY_FILTERS = {
          awaiting_ship:    'https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT',
          awaiting_payment: 'https://www.ebay.com/sh/ord/?filter=status:AWAITING_PAYMENT',
          all:              'https://www.ebay.com/sh/ord/?filter=status:ALL_ORDERS',
          paid_shipped:     'https://www.ebay.com/sh/ord/?filter=status:PAID_SHIPPED'
        };
        for (const filter of filters) {
          const url = EBAY_FILTERS[filter];
          if (!url) continue;
          log('info', `  Opening ${filter}...`);
          const orders = await this.scrapeEbayOrders(url, accountId);
          const importStatus = filter === 'awaiting_ship' ? 'pending' : 'shipped';
          for (const order of orders) {
            db.upsertOrder({
              order_id: order.orderId, item_title: order.itemTitle,
              item_id: order.itemId || '', sale_price: order.salePrice,
              quantity: order.quantity || 1, buyer_name: order.buyerName,
              sale_date: order.saleDate, fulfill_status: importStatus,
              detail_url: order.detailUrl
            });
            stats.imported++;
          }
          log('success', `✓ ${orders.length} orders from ${filter} (as ${importStatus})`);
        }
      } catch (e) {
        log('error', `✕ eBay scrape failed: ${e.message}`);
        stats.errors++;
      }
    }

    // Step 2: Scrape addresses
    if (options.scrapeAddresses !== false && running[accountId]) {
      log('info', 'Step 2 — Scraping shipping addresses...');
      const noAddress = db.getOrders().filter(o => !o.ship_addr1 && o.fulfill_status !== 'cancelled');
      log('info', `  → ${noAddress.length} orders need addresses`);
      for (const order of noAddress) {
        if (!running[accountId]) break;
        try {
          const addr = await this.scrapeOrderAddress(order.detail_url, order.order_id, accountId);
          if (addr?.name) {
            const quantity = Math.max(addr.quantity || 1, order.quantity || 1);
            db.updateOrder(order.order_id, {
              ship_name: addr.name, ship_addr1: addr.addr1, ship_addr2: addr.addr2 || '',
              ship_city: addr.city, ship_state: addr.state, ship_zip: addr.zip, buyer_phone: addr.phone,
              quantity
            });
            stats.addressed++;
            log('success', `  ✓ ${addr.name}, ${addr.city} ${addr.state} ${addr.zip}`);
          } else {
            log('warn', `  ⚠ No address for #${order.order_id}`);
          }
          emit('fill-order-updated', { orderId: order.order_id });
        } catch (e) {
          log('warn', `  ⚠ Error for #${order.order_id}: ${e.message}`);
        }
        await this.delay(800);
      }
    }

    // Step 3: Match Amazon orders
    let cachedAmzOrders = [];
    if (options.matchAmazon !== false && running[accountId]) {
      log('info', 'Step 3 — Matching to Amazon orders...');
      try {
        cachedAmzOrders = await this.scrapeAmazonOrders(accountId);
        log('info', `  → ${cachedAmzOrders.length} Amazon orders found`);
        const pending = db.getOrders().filter(o => o.fulfill_status === 'pending');
        for (const amz of cachedAmzOrders) {
          if (!amz.asin) continue;
          const match = pending.find(o => this.wordOverlap(o.item_title, amz.title) > 0.45);
          if (match) {
            // If this Amazon order was cancelled, don't mark as ordered — leave pending so it gets re-fulfilled
            if (/cancel/i.test(amz.status)) {
              log('warn', `  ⚠ Matched #${match.order_id} but Amazon order was CANCELLED — will re-order`);
            } else {
              db.updateOrder(match.order_id, { amazon_order_id: amz.orderId, fulfill_status: 'ordered' });
              stats.matched++;
              log('success', `  ✓ Matched #${match.order_id} (status: ${amz.status || 'unknown'})`);
              emit('fill-order-updated', { orderId: match.order_id });
            }
          }
        }
        log('success', `✓ ${stats.matched} orders matched`);
      } catch (e) {
        log('error', `✕ Amazon match failed: ${e.message}`);
        stats.errors++;
      }
    }

    // Step 4: Fulfill
    if (options.fulfill !== false && running[accountId]) {
      log('info', 'Step 4 — Fulfilling unordered orders...');
      const toFulfill = db.getOrders().filter(o =>
        o.fulfill_status === 'pending' && o.ship_addr1 &&
        !o.amazon_order_id && !o.tracking_number && !o.message_sent);
      const asinMap = db.getAsinMap();
      log('info', `  → ${toFulfill.length} orders to fulfill`);
      for (const order of toFulfill) {
        if (!running[accountId]) break;
        const mapEntry = asinMap.find(m => m.listing_id === order.item_id || m.listing_id === order.order_id);
        const isAli = mapEntry?.source === 'aliexpress' && mapEntry?.ali_item_id;
        const asin = mapEntry?.asin;
        if (!mapEntry) { log('warn', `  ⚠ No ASIN/source mapped for listing ${order.item_id} — skipping #${order.order_id}`); continue; }
        if (!isAli && !asin) { log('warn', `  ⚠ No ASIN for #${order.order_id}`); continue; }

        // Pre-check Amazon duplicate only for Amazon-sourced orders
        if (!isAli) {
        const buyerName = (order.ship_name || order.buyer_name || '').toLowerCase();
        const existingAmz = cachedAmzOrders.find(a =>
          a.asin === asin &&
          buyerName && a.shipTo && a.shipTo.toLowerCase().includes(buyerName.split(' ')[0]) &&
          !/cancel/i.test(a.status)
        );
        if (existingAmz) {
          log('warn', `  ⚠ Skipping #${order.order_id} — Amazon already has an active order for ${order.buyer_name} (${existingAmz.status || 'active'}, AMZ: ${existingAmz.orderId})`);
          if (existingAmz.orderId) db.updateOrder(order.order_id, { amazon_order_id: existingAmz.orderId, fulfill_status: 'ordered' });
          emit('fill-order-updated', { orderId: order.order_id });
          continue;
        }
        }

        try {
          log('info', `  Ordering via ${isAli ? 'AliExpress' : 'Amazon'}: ${(order.item_title || '').slice(0, 45)}...`);
          const result = isAli
            ? await this.fulfillOrderAliExpress(order, mapEntry.ali_item_id, accountId)
            : await this.fulfillOrder(order, asin, accountId);
          if (result.success) {
            stats.fulfilled++;
            log('success', `  ✓ Ordered #${order.order_id}${result.amazonCost ? ` — paid $${result.amazonCost.toFixed(2)}` : ' (cost not captured)'}`);
          } else {
            log('error', `  ✕ Failed #${order.order_id}: ${result.error}`);
            db.updateOrder(order.order_id, { fulfill_status: 'error', last_error: result.error });
            stats.errors++;
          }
          emit('fill-order-updated', { orderId: order.order_id });
        } catch (e) {
          log('error', `  ✕ Error: ${e.message}`);
          stats.errors++;
        }
        await this.delay(2000);
      }
    }

    // Step 5: Pull tracking
    if (options.pullTracking !== false && running[accountId]) {
      log('info', 'Step 5 — Pulling tracking numbers...');
      const needTracking = db.getOrders().filter(o => o.amazon_order_id && !o.tracking_number);
      log('info', `  → ${needTracking.length} orders need tracking`);
      for (const order of needTracking) {
        if (!running[accountId]) break;
        try {
          const tracking = await this.scrapeAmazonTracking(order.amazon_order_id, accountId);
          if (tracking?.trackingNumber) {
            db.updateOrder(order.order_id, { tracking_number: tracking.trackingNumber, carrier: tracking.carrier || 'USPS' });
            stats.tracked++;
            log('success', `  ✓ #${order.order_id}: ${tracking.trackingNumber}`);
            emit('fill-order-updated', { orderId: order.order_id });
          } else {
            log('warn', `  ⚠ No tracking yet for #${order.order_id}`);
          }
        } catch (e) { log('warn', `  ⚠ Error: ${e.message}`); }
        await this.delay(1000);
      }
    }

    // Step 6: Mark shipped
    if (options.markShipped === true && running[accountId]) {
      log('info', 'Step 6 — Marking shipped on eBay...');
      const toMark = db.getOrders().filter(o => o.tracking_number && o.fulfill_status !== 'shipped');
      for (const order of toMark) {
        if (!running[accountId]) break;
        try {
          await this.markEbayShipped(order, accountId);
          db.updateOrder(order.order_id, { fulfill_status: 'shipped' });
          log('success', `  ✓ Marked shipped: #${order.order_id}`);
          emit('fill-order-updated', { orderId: order.order_id });
        } catch (e) { log('warn', `  ⚠ Could not mark shipped: #${order.order_id}`); }
        await this.delay(1000);
      }
    }

    // Step 7: Message buyers
    if (options.messageBuyers === true && running[accountId]) {
      log('info', 'Step 7 — Messaging buyers...');
      const toMessage = db.getOrders().filter(o => o.tracking_number && !o.message_sent);
      const Store = require('electron-store');
      const store = new Store();
      const template = store.get('messageTemplate') || 'Hi {{name}},\n\nYour order has shipped!\nTracking: {{tracking}}\nCarrier: {{carrier}}\n\nThanks!';
      for (const order of toMessage) {
        if (!running[accountId]) break;
        try {
          const msg = template
            .replace(/{{name}}/g, order.buyer_name || 'there')
            .replace(/{{tracking}}/g, order.tracking_number || '')
            .replace(/{{carrier}}/g, order.carrier || 'USPS')
            .replace(/{{item}}/g, (order.item_title || '').slice(0, 50));
          await this.sendEbayMessage(order, msg, accountId);
          db.updateOrder(order.order_id, { message_sent: 1 });
          stats.messaged++;
          log('success', `  ✓ Messaged buyer for #${order.order_id}`);
          emit('fill-order-updated', { orderId: order.order_id });
        } catch (e) { log('warn', `  ⚠ Message failed`); }
        await this.delay(800);
      }
    }

    const summary = `${stats.imported} imported, ${stats.addressed} addressed, ${stats.fulfilled} fulfilled, ${stats.tracked} tracked, ${stats.messaged} messaged`;
    log('heading', `⬡ SCAN COMPLETE — ${summary}`);
    emit('scan-log', { type: 'summary', stats });
    running[accountId] = false;
    return { success: true, stats };
  },

  // ── Auto-map ASINs from order history ──────────────────────────
  async autoMapAsins(emit, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const log = (type, text) => emit('scan-log', { type, text });
    log('heading', '⬡ AUTO-MAP ASINs — matching buyers across both order histories');

    // Amazon orders with ship-to name AND asin
    const amzOrders = [];
    for (let startIndex = 0; startIndex <= 40; startIndex += 10) {
      const page = await this.newPage(accountId);
      try {
        await page.goto(`https://www.amazon.com/your-orders/orders?startIndex=${startIndex}`, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);
        const batch = await page.evaluate(() => {
          return [...document.querySelectorAll('.order-card.js-order-card')].map(card => {
            const text = card.innerText;
            return {
              shipTo: (text.match(/Ship to\s*\n?\s*([^\n]+)/i) || [])[1]?.trim() || '',
              asin: card.querySelector('a[href*="/dp/"]')?.href?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || '',
              title: [...card.querySelectorAll('a')].map(a => a.textContent.trim()).find(t => t.length > 25) || '',
            };
          }).filter(o => o.shipTo && o.asin);
        });
        amzOrders.push(...batch);
        if (batch.length < 5) { await page.close(); break; }
      } finally { try { await page.close(); } catch (_) {} }
    }
    log('info', `  → ${amzOrders.length} Amazon orders with ship-to + ASIN`);

    const existing = new Set(db.getAsinMap().map(m => m.listing_id));
    let mapped = 0, skipped = 0;
    const seen = new Set();
    for (const order of db.getOrders()) {
      if (!order.item_id || existing.has(order.item_id) || seen.has(order.item_id)) continue;
      seen.add(order.item_id);
      const buyer = (order.ship_name || order.buyer_name || '').trim().toLowerCase();
      if (!buyer) { skipped++; continue; }
      const match = amzOrders.find(a => a.shipTo.toLowerCase() === buyer);
      if (!match) {
        log('warn', `  ⚠ ${order.item_id} (${(order.item_title || '').slice(0, 40)}): no Amazon order for "${order.ship_name || order.buyer_name}"`);
        skipped++;
        continue;
      }
      db.mapAsin(order.item_id, match.asin, match.title.slice(0, 60));
      existing.add(order.item_id);
      mapped++;
      log('success', `  ✓ ${order.item_id} → ${match.asin} (via ${match.shipTo.trim()})`);
    }

    log('heading', `⬡ AUTO-MAP DONE — ${mapped} new mappings, ${skipped} unmatched`);
    return { success: true, mapped, skipped };
  },

  // ── Sync Orders ────────────────────────────────────────────────
  // 1. Scrape all eBay orders (awaiting shipment + all orders) → upsert into DB
  // 2. Scrape Amazon order history → build buyer-name → ASIN lookup
  // 3. Scrape AliExpress order history → build buyer-name → item_id lookup
  // 4. For each eBay listing with no mapping, try to match by buyer name to either source
  // Does NOT place any orders.
  async syncOrders(emit, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const log = (type, text) => emit('scan-log', { type, text });
    log('heading', '⬡ SYNC ORDERS — scraping eBay, Amazon, AliExpress');

    // ── Step 1: Scrape eBay orders ─────────────────────────────
    log('info', '① Scraping eBay orders…');
    let ebayImported = 0;
    for (const [filter, url] of [
      ['awaiting_ship', 'https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT'],
      ['all',           'https://www.ebay.com/sh/ord/?filter=status:ALL_ORDERS'],
    ]) {
      try {
        const orders = await this.scrapeEbayOrders(url, accountId);
        const importStatus = filter === 'awaiting_ship' ? 'pending' : undefined;
        for (const o of orders) {
          db.upsertOrder({
            order_id: o.orderId, item_title: o.itemTitle, item_id: o.itemId || '',
            sale_price: o.salePrice, buyer_name: o.buyerName, sale_date: o.saleDate,
            ship_name: o.shipName, ship_address: o.shipAddress, ship_city: o.shipCity,
            ship_state: o.shipState, ship_zip: o.shipZip, ship_country: o.shipCountry,
            ...(importStatus ? { fulfill_status: importStatus } : {}),
          });
          ebayImported++;
        }
        log('info', `  eBay (${filter}): ${orders.length} orders`);
      } catch (e) {
        log('warn', `  ⚠ eBay ${filter} scrape failed: ${e.message}`);
      }
    }
    log('info', `  → ${ebayImported} eBay order records upserted`);

    // ── Step 2: Scrape Amazon order history ────────────────────
    log('info', '② Scraping Amazon orders…');
    // buyerName (lowercase) → { asin, title }
    const amazonByBuyer = new Map();
    for (let startIndex = 0; startIndex <= 60; startIndex += 10) {
      const page = await this.newPage(accountId);
      try {
        await page.goto(`https://www.amazon.com/your-orders/orders?startIndex=${startIndex}`, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);
        const batch = await page.evaluate(() =>
          [...document.querySelectorAll('.order-card.js-order-card')].map(card => {
            const text = card.innerText;
            const shipTo = (text.match(/Ship to\s*\n?\s*([^\n]+)/i) || [])[1]?.trim() || '';
            const asin = card.querySelector('a[href*="/dp/"]')?.href?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || '';
            const title = [...card.querySelectorAll('a')].map(a => a.textContent.trim()).find(t => t.length > 25) || '';
            // Real order IDs are 112-... format (not 106-... session IDs)
            const orderId = (text.match(/\b(112-\d{7}-\d{7})\b/) || [])[1] || '';
            const cancelled = /cancelled/i.test(text);
            const shipped = /shipped|delivered|out for delivery/i.test(text);
            return { shipTo, asin, title, orderId, cancelled, shipped };
          }).filter(o => o.shipTo && o.asin)
        ).catch(() => []);
        for (const o of batch) {
          const key = o.shipTo.toLowerCase();
          if (!amazonByBuyer.has(key)) amazonByBuyer.set(key, []);
          amazonByBuyer.get(key).push({ asin: o.asin, title: o.title, orderId: o.orderId, cancelled: o.cancelled, shipped: o.shipped });
        }
        if (batch.length < 5) { await page.close(); break; }
      } finally { try { await page.close(); } catch (_) {} }
    }
    log('info', `  → ${amazonByBuyer.size} unique Amazon buyers found`);

    // ── Step 3: Scrape AliExpress order history ────────────────
    log('info', '③ Scraping AliExpress orders…');
    // buyerFirstName (lowercase) → [{ itemId, title }]  (AliExpress doesn't store buyer name,
    // so we match by the address name set during checkout, parsed from order detail if available)
    const aliByItemId = new Map(); // itemId → title (for lookup only)
    const aliOrders = []; // { ref, title, itemId }
    const aliPage = await this.newPage(accountId);
    try {
      await aliPage.goto('https://www.aliexpress.com/p/order/index.html', { waitUntil: 'domcontentloaded' });
      await this.delay(3000);
      let pageNum = 0;
      while (pageNum < 5) {
        const cards = await aliPage.evaluate(() => {
          const seen = new Set();
          return [...document.querySelectorAll('.order-item, [class*="order-item"]')]
            .map(card => {
              const text = card.innerText || '';
              const ref = text.match(/\b(\d{14,16})\b/)?.[1] || '';
              const itemLink = card.querySelector('a[href*="/item/"]');
              const itemId = itemLink?.href?.match(/\/item\/(\d+)/)?.[1] || '';
              const titleEl = card.querySelector('a[class*="title"], a[class*="product"]') ||
                [...card.querySelectorAll('a')].find(a => {
                  const t = a.textContent.trim();
                  return t.length > 20 && !/track|detail|confirm|store/i.test(t);
                });
              const title = titleEl?.textContent?.trim() || '';
              const status = text.match(/Awaiting delivery|Completed|Processing|Cancelled/i)?.[0] || '';
              return { ref, itemId, title, status };
            })
            .filter(o => o.ref && !seen.has(o.ref) && seen.add(o.ref));
        }).catch(() => []);

        for (const c of cards) {
          if (c.itemId) aliByItemId.set(c.itemId, c.title);
          aliOrders.push(c);
        }

        const hasNext = await aliPage.evaluate(() => {
          const btn = [...document.querySelectorAll('button, a')].find(el =>
            /next page|下一页/i.test(el.textContent) && !el.disabled);
          if (btn) { btn.click(); return true; }
          return false;
        }).catch(() => false);
        if (!hasNext || !cards.length) break;
        await this.delay(2500);
        pageNum++;
      }
      log('info', `  → ${aliOrders.length} AliExpress orders found`);
    } catch (e) {
      log('warn', `  ⚠ AliExpress scrape failed: ${e.message} (not logged in?)`);
    } finally { await aliPage.close().catch(() => {}); }

    // ── Step 4: Match unmapped eBay listings ───────────────────
    log('info', '④ Matching listings…');
    const existingMap = new Set(db.getAsinMap().map(m => m.listing_id));
    const seen = new Set();
    let mapped = 0, skipped = 0;

    for (const order of db.getOrders()) {
      const listingId = order.item_id;
      if (!listingId || existingMap.has(listingId) || seen.has(listingId)) continue;
      seen.add(listingId);

      const buyer = (order.ship_name || order.buyer_name || '').trim().toLowerCase();
      if (!buyer) { skipped++; continue; }

      // Try Amazon first (exact buyer name match)
      const amzMatches = amazonByBuyer.get(buyer) || [];
      if (amzMatches.length) {
        const best = amzMatches[0];
        db.mapAsin(listingId, best.asin, best.title.slice(0, 60), { source: 'amazon' });
        existingMap.add(listingId);
        mapped++;
        log('success', `  ✓ ${listingId} → Amazon ${best.asin}  (buyer: ${buyer})`);
        continue;
      }

      // Try AliExpress: match by title word overlap between eBay order title and AliExpress order titles
      const ebayTitle = (order.item_title || '').toLowerCase();
      if (ebayTitle && aliOrders.length) {
        const words = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
        const ebayWords = words(ebayTitle);
        let bestAli = null, bestScore = 0;
        for (const ali of aliOrders) {
          if (!ali.itemId) continue;
          const aliWords = words(ali.title);
          let common = 0; for (const w of ebayWords) if (aliWords.has(w)) common++;
          const score = common / Math.max(ebayWords.size, aliWords.size, 1);
          if (score > bestScore) { bestScore = score; bestAli = ali; }
        }
        if (bestAli && bestScore >= 0.35) {
          db.mapAsin(listingId, 'ALI', bestAli.title.slice(0, 60), { source: 'aliexpress', ali_item_id: bestAli.itemId });
          existingMap.add(listingId);
          mapped++;
          log('success', `  ✓ ${listingId} → AliExpress ${bestAli.itemId}  (title match ${Math.round(bestScore * 100)}%: "${bestAli.title.slice(0, 40)}")`);
          continue;
        }
      }

      log('warn', `  ⚠ ${listingId} (${(order.item_title || '').slice(0, 35)}): no match`);
      skipped++;
    }

    // ── Step 5: Update fulfill_status from Amazon/AliExpress ──────
    log('info', '⑤ Updating order statuses…');
    let statusUpdated = 0;
    for (const order of db.getOrders()) {
      if (order.fulfill_status !== 'pending') continue; // only touch pending orders
      const buyer = (order.ship_name || order.buyer_name || '').trim().toLowerCase();
      if (!buyer) continue;

      // Check Amazon: match by buyer name (first name at minimum)
      const buyerFirst = buyer.split(/\s+/)[0];
      let amzMatch = null;
      for (const [key, entries] of amazonByBuyer) {
        if (key === buyer || key.startsWith(buyerFirst)) {
          amzMatch = entries.find(e => !e.cancelled);
          if (amzMatch) break;
        }
      }
      if (amzMatch) {
        const patch = { fulfill_status: 'ordered' };
        if (amzMatch.orderId) patch.amazon_order_id = amzMatch.orderId;
        db.updateOrder(order.order_id, patch);
        statusUpdated++;
        log('success', `  ✓ #${order.order_id} → ordered (Amazon ${amzMatch.orderId || 'no ID'}, buyer: ${buyer})`);
        continue;
      }

      // Check AliExpress: match by title overlap (AliExpress doesn't expose ship-to name easily)
      const ebayTitle = (order.item_title || '').toLowerCase();
      if (ebayTitle && aliOrders.length) {
        const words = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
        const ebayWords = words(ebayTitle);
        const aliMatch = aliOrders.find(ali => {
          if (!ali.itemId || /cancel/i.test(ali.status || '')) return false;
          const aliWords = words(ali.title);
          let common = 0; for (const w of ebayWords) if (aliWords.has(w)) common++;
          return (common / Math.max(ebayWords.size, aliWords.size, 1)) >= 0.35;
        });
        if (aliMatch) {
          db.updateOrder(order.order_id, { fulfill_status: 'ordered' });
          statusUpdated++;
          log('success', `  ✓ #${order.order_id} → ordered (AliExpress, title match: "${aliMatch.title.slice(0, 35)}")`);
        }
      }
    }
    log('info', `  → ${statusUpdated} orders updated to "ordered"`);

    log('heading', `⬡ SYNC DONE — ${ebayImported} orders synced, ${mapped} new mappings, ${statusUpdated} statuses updated, ${skipped} unmatched`);
    return { success: true, ebayImported, mapped, skipped, statusUpdated };
  },

  // ── Combined Ship + Message ────────────────────────────────────
  // 1. Scan Amazon order history (with Ship-To names)
  // 2. Match unshipped eBay orders to Amazon orders by buyer name
  // 3. Pull tracking from Amazon, add it on eBay, message the buyer with arrival date
  async runShipAndMessage(emit, accountId = 'acc1') {
    running[accountId] = true;
    const db = DB.forAccount(accountId);
    const log = (type, text) => emit('scan-log', { type, text });
    const stats = { matched: 0, shipped: 0, messaged: 0, waiting: 0, errors: 0 };

    // Only handle orders sold TODAY or later — older orders were likely already
    // shipped/messaged outside zayndrop (prevents double-messaging buyers).
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const isRecent = (o) => {
      if (!o.sale_date) return false;
      const d = new Date(o.sale_date);
      return !isNaN(d) && d >= todayStart;
    };

    // Ground truth first: ask eBay who is ACTUALLY still awaiting shipment.
    // DB status can lie (manual fulfillment, re-imports) — eBay can't.
    log('info', 'Checking eBay awaiting-shipment list (ground truth)...');
    const ebayAwaiting = new Set();
    try {
      const rows = await this.scrapeEbayOrders('https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT');
      for (const r of rows) {
        ebayAwaiting.add(r.orderId);
        db.upsertOrder({
          order_id: r.orderId, item_title: r.itemTitle, item_id: r.itemId || '',
          sale_price: r.salePrice, buyer_name: r.buyerName, sale_date: r.saleDate,
          fulfill_status: 'pending', detail_url: r.detailUrl
        });
      }
      log('info', `  → ${ebayAwaiting.size} orders still awaiting shipment on eBay`);
    } catch (e) {
      log('warn', `  ⚠ Could not read awaiting list: ${e.message} — falling back to DB status`);
    }

    // Who to process:
    // - anything eBay says is awaiting shipment (needs tracking added, whatever DB thinks)
    // - pending/ordered = actively in the pipeline
    // - shipped but unmessaged → only if sold today (older = handled elsewhere)
    const messagable = (o) =>
      !o.message_sent && (['pending', 'ordered'].includes(o.fulfill_status) || isRecent(o));
    const candidates = db.getOrders().filter(o =>
      o.fulfill_status !== 'cancelled' &&
      (ebayAwaiting.has(o.order_id) ||
       ['pending', 'ordered'].includes(o.fulfill_status) ||
       (o.fulfill_status === 'shipped' && messagable(o))));
    log('heading', `⬡ SHIP + MESSAGE — ${candidates.length} eBay orders to process`);
    if (!candidates.length) {
      log('warn', 'Nothing to do — all orders are shipped and messaged.');
      running[accountId] = false;
      return { success: true, stats };
    }

    // 1. Scan recent Amazon orders (ship-to name is the matching key)
    log('info', 'Scanning Amazon order history...');
    const amzOrders = [];
    for (let startIndex = 0; startIndex <= 20 && running[accountId]; startIndex += 10) {
      const page = await this.newPage(accountId);
      try {
        await page.goto(`https://www.amazon.com/your-orders/orders?startIndex=${startIndex}`, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);
        const batch = await page.evaluate(() => {
          return [...document.querySelectorAll('.order-card.js-order-card')].map(card => {
            const text = card.innerText;
            return {
              orderId: text.match(/(\d{3}-\d{7}-\d{7})/)?.[1] || '',
              shipTo: (text.match(/Ship to\s*\n?\s*([^\n]+)/i) || [])[1]?.trim() || '',
              arriving: (text.match(/(?:Arriving|Delivered|Expected)\s+([^\n]+)/i) || [])[1]?.trim() || '',
              title: [...card.querySelectorAll('a')].map(a => a.textContent.trim()).find(t => t.length > 25) || '',
            };
          }).filter(o => o.orderId);
        });
        amzOrders.push(...batch);
        if (batch.length < 10) { await page.close(); break; }
      } finally { try { await page.close(); } catch (_) {} }
    }
    log('info', `  → ${amzOrders.length} Amazon orders found`);

    // 2-3. Match and process each eBay order
    for (const order of candidates) {
      if (!running[accountId]) break;
      try {
        const buyer = (order.ship_name || order.buyer_name || '').trim().toLowerCase();
        let match = order.amazon_order_id ? amzOrders.find(a => a.orderId === order.amazon_order_id) : null;
        if (!match && buyer) match = amzOrders.find(a => a.shipTo.toLowerCase() === buyer);
        if (!match) {
          log('warn', `⚠ #${order.order_id} (${order.ship_name || order.buyer_name}): no matching Amazon order`);
          continue;
        }
        stats.matched++;
        if (!order.amazon_order_id) db.updateOrder(order.order_id, { amazon_order_id: match.orderId });

        let hasTracking = !!order.tracking_number;
        if (!hasTracking) {
          const t = await this.scrapeAmazonTracking(match.orderId, accountId);
          if (t?.trackingNumber) {
            order.tracking_number = t.trackingNumber;
            order.carrier = t.carrier;
            db.updateOrder(order.order_id, { tracking_number: t.trackingNumber, carrier: t.carrier });
            log('success', `✓ Tracking from Amazon: ${t.trackingNumber} (${t.carrier})`);
            hasTracking = true;
          } else {
            stats.waiting++;
            log('warn', `⚠ #${order.order_id}: Amazon hasn't shipped yet (${match.arriving || 'no tracking'}) — will mark shipped on a later run`);
          }
        }

        if (hasTracking && (ebayAwaiting.has(order.order_id) || order.fulfill_status !== 'shipped')) {
          await this.markEbayShipped(order, accountId);
          db.updateOrder(order.order_id, { fulfill_status: 'shipped' });
          stats.shipped++;
          log('success', `✓ Marked shipped on eBay: #${order.order_id}`);
          emit('fill-order-updated', { orderId: order.order_id });
          await this.delay(1000);
        }

        if (messagable(order)) {
          const firstName = (order.ship_name || order.buyer_name || 'there').split(/\s+/)[0];
          const arrivalText = match.arriving ? ` ${match.arriving}` : ' soon';
          const msg = `Hey ${firstName}, your order is arriving${arrivalText}. Feel free to give a review!`;
          await this.sendEbayMessage(order, msg, accountId);
          db.updateOrder(order.order_id, { message_sent: 1 });
          stats.messaged++;
          log('success', `✓ Messaged ${firstName}: "${msg}"`);
          emit('fill-order-updated', { orderId: order.order_id });
        }
      } catch (e) {
        stats.errors++;
        log('error', `✕ #${order.order_id}: ${e.message}`);
      }
      await this.delay(1200);
    }

    log('heading', `⬡ DONE — ${stats.matched} matched, ${stats.shipped} shipped, ${stats.messaged} messaged, ${stats.waiting} awaiting Amazon shipment`);
    running[accountId] = false;
    return { success: true, stats };
  },

  async scrapeEbayOrders(url, accountId = 'acc1') {
    const page = await this.newPage(accountId);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      try { await page.waitForSelector('tr.order-info', { timeout: 15000 }); } catch (_) {}
      await this.delay(2000);
      return await page.evaluate(() => {
        const rows = [...document.querySelectorAll('tr.order-info')];
        const titleEls = [...document.querySelectorAll('.item-title')];
        return rows.map((row, idx) => {
          const orderIdClass = [...row.classList].find(c => c.startsWith('orderid_'));
          const orderId = orderIdClass?.replace('orderid_', '') || '';
          if (!orderId) return null;
          const cells = [...row.querySelectorAll('td.order-default-cell')];
          const cell0 = cells[0]?.textContent?.trim() || '';
          const cell3 = cells[3]?.textContent?.trim() || '';
          const cell4 = cells[4]?.textContent?.trim() || '';
          const buyerName = cell0.replace(orderId, '').replace('View order details', '').trim().split(/[a-z0-9_\-\.]{4,}Buyer/i)[0]?.trim().slice(0, 60) || '';
          const salePrice = parseFloat(cell3.match(/\$([0-9.]+)/)?.[1] || '0') || null;
          const detailLink = row.querySelector('a[href*="orderid="]');
          const titleEl = titleEls[idx];
          const itemId = titleEl?.querySelector('a[href*="/itm/"]')?.href?.match(/\/itm\/(\d+)/)?.[1] || '';
          // Qty often shows inline near the item title/details as "Qty: 2" or "x2" —
          // scan the whole row text as a first-pass guess (refined later from the
          // order detail page, which is more reliable).
          const rowText = row.textContent || '';
          const qtyMatch = rowText.match(/qty:?\s*(\d+)/i) || rowText.match(/\bx\s?(\d+)\b/i);
          const quantity = qtyMatch ? parseInt(qtyMatch[1]) || 1 : 1;
          return { orderId, buyerName, salePrice, itemTitle: titleEl?.textContent?.trim() || '', itemId, saleDate: cell4, detailUrl: detailLink?.href || '', quantity };
        }).filter(Boolean);
      });
    } finally { await page.close(); }
  },

  async scrapeOrderAddress(detailUrl, orderId, accountId = 'acc1') {
    const page = await this.newPage(accountId);
    try {
      const meshUrl = `https://www.ebay.com/mesh/ord/details?mode=SH&orderid=${orderId}&source=Orders`;
      const url = detailUrl || meshUrl;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await this.delay(3500);

      const extractAddress = (text) => {
        // Note: eBay puts city / "," / state / zip on SEPARATE lines:
        //   Ship to / Name / 736 Oak Meadows Ln / Leslie / , / MO / 63056-1179 / United States
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && l !== ',');

        const labelPatterns = [/^ship\s+to:?$/i, /^shipping\s+address:?$/i, /^deliver\s+to:?$/i];
        let shipIdx = -1;
        for (const pat of labelPatterns) {
          shipIdx = lines.findIndex(l => pat.test(l));
          if (shipIdx > -1) break;
        }
        if (shipIdx === -1) return null;

        const name = lines[shipIdx + 1] || '';
        if (!name) return null;

        // Collect the address block: everything between name and the zip line
        const zipRe = /^\d{5}(-\d{4})?$/;
        const stateRe = /^[A-Z]{2}$/;
        const block = [];
        let state = '', zip = '';
        for (let i = shipIdx + 2; i < Math.min(shipIdx + 10, lines.length); i++) {
          const l = lines[i];
          if (zipRe.test(l)) { zip = l; break; }
          if (stateRe.test(l)) { state = l; continue; }
          if (/^united states$/i.test(l)) break;
          block.push(l);
        }
        if (!zip || !state || block.length < 2) {
          // Maybe single-line format: "City, ST 12345"
          for (let i = shipIdx + 2; i < Math.min(shipIdx + 8, lines.length); i++) {
            const m = lines[i].match(/^(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
            if (m) {
              const addr1 = lines[shipIdx + 2] || '';
              const addr2 = i > shipIdx + 3 ? lines.slice(shipIdx + 3, i).join(' ') : '';
              return { name, addr1, addr2, city: m[1].trim(), state: m[2], zip: m[3], phone: '' };
            }
          }
          return null;
        }

        // Last entry in block is the city; everything before it is street address
        const city = block.pop() || '';
        const addr1 = block.shift() || '';
        const addr2 = block.join(' ');

        const phoneIdx = lines.findIndex((l, i) => i > shipIdx && /^phone:?$/i.test(l));
        const phone = phoneIdx > -1 ? (lines[phoneIdx + 1] || '').replace(/^\+1\s*/, '') : '';

        // Quantity appears as "Quantity" / "2" / "(7 available)" on the order page,
        // sometimes abbreviated "Qty" or on the same line ("Quantity: 2", "Qty 2").
        let quantity = 1;
        const qtyLabelIdx = lines.findIndex(l => /^(quantity|qty)\.?:?$/i.test(l));
        if (qtyLabelIdx > -1) {
          quantity = parseInt(lines[qtyLabelIdx + 1]) || 1;
        } else {
          const sameLine = lines.find(l => /^(quantity|qty)\.?:?\s*\d+/i.test(l));
          if (sameLine) quantity = parseInt(sameLine.match(/\d+/)[0]) || 1;
        }

        if (!addr1 || !city) return null;
        return { name, addr1, addr2, city, state, zip, phone, quantity };
      };

      // Try main frame first
      let text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      let addr = extractAddress(text);
      if (addr) return addr;

      // eBay loads order detail in a mesh.ebay.com iframe — wait for it and check all frames
      await this.delay(2000);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          await frame.waitForSelector('body', { timeout: 5000 }).catch(() => {});
          text = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
          addr = extractAddress(text);
          if (addr) return addr;
        } catch (_) {}
      }

      // Last resort: navigate directly to the mesh URL (the iframe source itself)
      if (url !== meshUrl) {
        await page.goto(meshUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        await this.delay(2500);
        text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        addr = extractAddress(text);
        if (addr) return addr;
      }

      // Dump everything we saw to a debug file so we can inspect the real page structure
      try {
        const fs = require('fs');
        const debugPath = path.join(app.getPath('userData'), 'address-debug.txt');
        let dump = `\n===== ORDER ${orderId} — ${new Date().toISOString()} =====\nURL: ${page.url()}\nFRAMES: ${page.frames().length}\n`;
        dump += `\n--- MAIN FRAME TEXT ---\n${(await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 3000)}\n`;
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const ftext = await frame.evaluate(() => document.body?.innerText || '').catch(() => '(unreadable)');
          dump += `\n--- FRAME ${frame.url().slice(0, 100)} ---\n${ftext.slice(0, 3000)}\n`;
        }
        fs.appendFileSync(debugPath, dump, 'utf8');
        console.log(`[Fill] Address parse failed for #${orderId} — debug written to ${debugPath}`);
      } catch (_) {}
      return null;
    } finally { await page.close(); }
  },

  async scrapeAmazonOrders(accountId = 'acc1') {
    const allOrders = [];
    const seen = new Set();
    let startIndex = 0;
    for (let pageNum = 0; pageNum < 20; pageNum++) {
      const page = await this.newPage(accountId);
      try {
        await page.goto(`https://www.amazon.com/your-orders/orders?startIndex=${startIndex}`, { waitUntil: 'domcontentloaded' });
        await this.delay(2000);
        const orders = await page.evaluate(() => {
          const skipTexts = ['view order','view invoice','track','return','review','support','gift','question','buy it'];
          return [...document.querySelectorAll('.order-card.js-order-card')].map(card => {
            const text = card.innerText || '';
            const asin = card.querySelector('a[href*="/dp/"]')?.href?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || null;
            const titleEl = [...card.querySelectorAll('a')].find(a => { const t = a.textContent.trim().toLowerCase(); return t.length > 15 && !skipTexts.some(s => t.includes(s)); });
            const orderNum = [...card.querySelectorAll('span')].find(s => s.textContent.match(/\d{3}-\d{7}-\d{7}/))?.textContent?.trim() || '';
            // Ship-to name appears after "Ship to" or "Shipping to" label
            const shipToM = text.match(/Ship(?:ping)? to\s*\n?\s*([^\n]+)/i);
            const shipTo = shipToM ? shipToM[1].trim() : '';
            // Status: first prominent status line (Delivered, Shipped, Cancelled, etc.)
            const statusM = text.match(/\b(Delivered|Shipped|Arriving|Cancelled|Canceled|Not yet shipped|Preparing for shipment)\b/i);
            const status = statusM ? statusM[1].toLowerCase() : '';
            return { asin, title: titleEl?.textContent?.trim() || '', orderId: orderNum, shipTo, status };
          }).filter(o => o.asin || o.title);
        });
        const newOrders = orders.filter(o => { const k = o.orderId || o.asin; if (!k || seen.has(k)) return false; seen.add(k); return true; });
        allOrders.push(...newOrders);
        if (orders.length < 10) break;
        startIndex += 10;
      } finally { await page.close(); }
      await this.delay(800);
    }
    return allOrders;
  },

  // Scrapes AliExpress orders page: clicks each "Track status" popup, extracts tracking number,
  // matches to eBay orders by product title (FIFO per product), marks shipped on eBay.
  async syncTrackingFromAliExpress(emit, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const log = (type, text) => emit('scan-log', { type, text });
    log('heading', '⬡ SYNC TRACKING (AliExpress) — scraping tracking numbers');

    const page = await this.newPage(accountId);
    const aliOrders = [];

    try {
      await page.goto('https://www.aliexpress.com/p/order/index.html', { waitUntil: 'domcontentloaded' });
      await this.delay(3000);

      // Paginate through all orders (AliExpress uses scroll / next-page button)
      let pageNum = 0;
      while (pageNum < 10) {
        // Get all unique order cards on this page
        const cards = await page.evaluate(() => {
          const seen = new Set();
          return [...document.querySelectorAll('.order-item, [class*="order-item"]')]
            .map(card => {
              const text = card.innerText || '';
              const ref = text.match(/\b(\d{14,16})\b/)?.[1] || '';
              const titleLink = card.querySelector('a[class*="title"], a[class*="product"]') ||
                [...card.querySelectorAll('a')].find(a => {
                  const t = a.textContent.trim();
                  return t.length > 20 && !/track|detail|confirm|store/i.test(t);
                });
              const title = titleLink?.textContent?.trim() || '';
              const date = text.match(/Date:\s*([\w\s,]+202\d)/i)?.[1]?.trim() || '';
              const status = text.match(/Awaiting delivery|Completed|Processing|Cancelled/i)?.[0] || '';
              return { ref, title, date, status };
            })
            .filter(o => o.ref && !seen.has(o.ref) && seen.add(o.ref));
        });

        log('info', `  Page ${pageNum + 1}: ${cards.length} orders`);

        // For each card, click its Track status button and extract tracking
        for (const card of cards) {
          if (!card.ref) continue;
          try {
            // Scroll card into view and find the Track status button
            const btn = await page.evaluateHandle((ref) => {
              const card = [...document.querySelectorAll('.order-item, [class*="order-item"]')]
                .find(c => c.innerText.includes(ref));
              if (!card) return null;
              const b = [...card.querySelectorAll('a, button')].find(el =>
                /track status/i.test(el.textContent.trim()));
              if (b) b.scrollIntoView({ block: 'center' });
              return b || null;
            }, card.ref);

            if (!btn || !(await btn.boundingBox())) {
              aliOrders.push({ ...card, trackingNumber: '', carrier: '' });
              continue;
            }

            await this.delay(400);
            const box = await btn.boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await this.delay(2000);

            // Read from the popup (.comet-popover-content) not body text
            const trackingInfo = await page.evaluate(() => {
              const popup = document.querySelector('.comet-popover-content, .order-track-popup, [class*="order-track"]');
              const text = popup ? popup.innerText : '';
              if (!text || /not been updated|no logistics/i.test(text)) return { trackingNumber: '', carrier: '' };

              // Try various label formats AliExpress uses
              const patterns = [
                /tracking\s*(?:number|no\.?|#)[:\s]+([A-Z0-9]{8,})/i,
                /(?:^|\n)\s*([A-Z]{1,3}[0-9]{10,}[A-Z0-9]*)\s*(?:\n|$)/m,
                /([A-Z]{2}\d{9}[A-Z]{2})/,   // USPS format
                /(\d{20,22})/,                 // USPS/UPS numeric
                /([A-Z0-9]{18,30})/,
              ];
              let num = '';
              for (const p of patterns) {
                const m = text.match(p);
                if (m?.[1] && m[1].length >= 8) { num = m[1]; break; }
              }

              const carrier = !num ? 'Other'
                : num.startsWith('AP') ? 'USPS'
                : num.startsWith('YT') || num.startsWith('YW') ? 'Yanwen'
                : num.startsWith('1Z') ? 'UPS'
                : num.startsWith('TBA') ? 'Amazon'
                : num.match(/^[A-Z]{2}\d{9}[A-Z]{2}$/) ? 'USPS'
                : num.length >= 20 ? 'USPS'
                : 'Other';
              return { trackingNumber: num, carrier, popupText: text.slice(0, 200) };
            });

            aliOrders.push({ ...card, trackingNumber: trackingInfo.trackingNumber, carrier: trackingInfo.carrier });
            if (trackingInfo.trackingNumber) {
              log('info', `  ${card.ref}: ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
            } else if (trackingInfo.popupText) {
              log('info', `  ${card.ref}: popup="${trackingInfo.popupText.slice(0, 80)}"`);
            }

            // Dismiss popup by pressing Escape or clicking elsewhere
            await page.keyboard.press('Escape');
            await this.delay(500);
          } catch (e) {
            aliOrders.push({ ...card, trackingNumber: '', carrier: '' });
          }
        }

        // Check for next page
        const hasNext = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button, a')].find(el =>
            /next page|下一页/i.test(el.textContent) && !el.disabled);
          if (btn) { btn.click(); return true; }
          return false;
        }).catch(() => false);

        if (!hasNext) break;
        await this.delay(2500);
        pageNum++;
      }
    } finally {
      await page.close().catch(() => {});
    }

    const withTracking = aliOrders.filter(o => o.trackingNumber);
    log('info', `  → ${withTracking.length} orders with tracking (of ${aliOrders.length} total)`);

    if (!withTracking.length) {
      log('warn', '  No tracking numbers found on AliExpress');
      return { success: true, tracked: 0 };
    }

    // Match to eBay orders FIFO per product title
    const ebayOrders = db.getOrders().filter(o => !o.tracking_number);
    // Group AliExpress orders by title, group eBay orders by title → assign in order
    const groupByTitle = (arr, getTitle) => {
      const map = {};
      for (const item of arr) {
        const words = (getTitle(item) || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const key = words.slice(0, 4).join(' ');
        if (!map[key]) map[key] = [];
        map[key].push(item);
      }
      return map;
    };

    const aliByTitle  = groupByTitle(withTracking, o => o.title);
    const ebayByTitle = groupByTitle(ebayOrders,   o => o.item_title);

    // Match AliExpress groups to eBay groups by word overlap
    let tracked = 0;
    for (const [aliKey, aliGroup] of Object.entries(aliByTitle)) {
      const aliWords = new Set(aliKey.split(' '));
      let bestEbayKey = null, bestScore = 0;
      for (const ebayKey of Object.keys(ebayByTitle)) {
        const ebayWords = new Set(ebayKey.split(' '));
        let common = 0;
        aliWords.forEach(w => { if (ebayWords.has(w)) common++; });
        const score = common / Math.max(aliWords.size, ebayWords.size, 1);
        if (score > bestScore) { bestScore = score; bestEbayKey = ebayKey; }
      }

      if (!bestEbayKey || bestScore < 0.3) {
        log('warn', `  ⚠ No eBay match for AliExpress product: "${aliKey}"`);
        continue;
      }

      const ebayGroup = ebayByTitle[bestEbayKey];
      for (let i = 0; i < aliGroup.length && i < ebayGroup.length; i++) {
        const ali  = aliGroup[i];
        const ebay = ebayGroup[i];

        db.updateOrder(ebay.order_id, {
          tracking_number: ali.trackingNumber,
          carrier: ali.carrier || 'USPS',
        });
        emit('fill-order-updated', { orderId: ebay.order_id });
        log('success', `  ✓ #${ebay.order_id} (${ebay.buyer_name}) → ${ali.trackingNumber} (${ali.carrier})`);

        try {
          await this.markEbayShipped({ ...ebay, tracking_number: ali.trackingNumber, carrier: ali.carrier || 'USPS' }, accountId);
          db.updateOrder(ebay.order_id, { fulfill_status: 'shipped' });
          emit('fill-order-updated', { orderId: ebay.order_id });
          log('success', `    ✓ Marked shipped on eBay`);
        } catch (e) {
          log('warn', `    ⚠ Tracking saved but eBay mark-shipped failed: ${e.message}`);
        }

        tracked++;
        await this.delay(1000);
      }
    }

    log('heading', `⬡ ALIEXPRESS TRACKING COMPLETE — ${tracked} orders updated`);
    return { success: true, tracked };
  },

  // ── Verify Shipped ─────────────────────────────────────────────
  // Scrapes eBay PAID_SHIPPED filter and cross-checks against DB tracking data.
  // Flags orders that eBay considers shipped but we have no tracking for.
  async verifyShipped(emit, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const log = (type, text) => emit('scan-log', { type, text });
    log('heading', '⬡ VERIFY SHIPPED — checking PAID_SHIPPED orders against DB');

    const page = await this.newPage(accountId);
    let ebayShipped = [];
    try {
      await page.goto('https://www.ebay.com/sh/ord/?filter=status:PAID_SHIPPED', { waitUntil: 'domcontentloaded' });
      try { await page.waitForSelector('tr.order-info', { timeout: 15000 }); } catch (_) {}
      await this.delay(2000);
      ebayShipped = await page.evaluate(() => {
        return [...document.querySelectorAll('tr.order-info')].map(row => {
          const orderId = (row.className.match(/orderid_([\d-]+)/) || [])[1] || '';
          const title = row.querySelector('.item-title')?.textContent?.trim() || '';
          const buyer = row.querySelector('.buyerName, [class*="buyer"]')?.textContent?.trim() || '';
          return { orderId, title, buyer };
        }).filter(o => o.orderId);
      }).catch(() => []);
    } finally { await page.close().catch(() => {}); }

    log('info', `  → ${ebayShipped.length} orders in PAID_SHIPPED on eBay`);
    if (!ebayShipped.length) {
      log('warn', '  No PAID_SHIPPED orders found (not logged in?)');
      return { success: true, ok: 0, missing: 0, results: [] };
    }

    const dbOrders = db.getOrders();
    let ok = 0, missing = 0;
    const results = [];

    for (const ebay of ebayShipped) {
      const dbOrder = dbOrders.find(o => o.order_id === ebay.orderId);
      if (dbOrder?.tracking_number) {
        ok++;
        log('success', `  ✓ #${ebay.orderId} — tracking: ${dbOrder.tracking_number}`);
        results.push({ orderId: ebay.orderId, title: ebay.title, status: 'ok', tracking: dbOrder.tracking_number });
      } else if (dbOrder?.fulfill_status === 'shipped') {
        // Marked shipped in DB but no tracking number captured
        ok++;
        log('warn', `  ⚠ #${ebay.orderId} — marked shipped but no tracking in DB`);
        results.push({ orderId: ebay.orderId, title: ebay.title, status: 'no_tracking', tracking: '' });
      } else {
        missing++;
        log('error', `  ✕ #${ebay.orderId} "${(ebay.title || '').slice(0, 40)}" — eBay says SHIPPED but we have no tracking`);
        results.push({ orderId: ebay.orderId, title: ebay.title, status: 'missing', tracking: '', buyer: ebay.buyer });
      }
    }

    log('heading', `⬡ VERIFY DONE — ${ok} confirmed, ${missing} missing tracking`);
    return { success: true, ok, missing, results };
  },

  // ── Pre-order duplicate check ──────────────────────────────────
  // Checks Amazon order history for an active order matching this buyer+ASIN.
  // Returns { isDuplicate, existingOrderId } so caller can skip or record.
  async checkAmazonDuplicate(order, asin, accountId = 'acc1') {
    const buyerFirst = (order.ship_name || order.buyer_name || '').trim().toLowerCase().split(/\s+/)[0];
    if (!buyerFirst || buyerFirst.length < 2) return { isDuplicate: false };
    const page = await this.newPage(accountId);
    try {
      await page.goto('https://www.amazon.com/your-orders/orders?startIndex=0', { waitUntil: 'domcontentloaded' });
      await this.delay(2500);
      const found = await page.evaluate((first, asin) => {
        for (const card of document.querySelectorAll('.order-card.js-order-card')) {
          const text = card.innerText;
          if (!/cancel/i.test(text) && text.toLowerCase().includes(first)) {
            const cardAsin = card.querySelector('a[href*="/dp/"]')?.href?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || '';
            if (!asin || cardAsin === asin) {
              const orderId = (text.match(/\b(112-\d{7}-\d{7})\b/) || [])[1] || '';
              return { isDuplicate: true, existingOrderId: orderId };
            }
          }
        }
        return { isDuplicate: false };
      }, buyerFirst, asin || '');
      return found;
    } catch (_) { return { isDuplicate: false }; } // fail open — don't block on error
    finally { await page.close().catch(() => {}); }
  },

  // Scrapes Amazon shipped/delivered orders, matches to eBay orders by buyer name,
  // pulls tracking numbers, and marks each matched eBay order as shipped.
  async syncTrackingFromAmazon(emit, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const log = (type, text) => emit('scan-log', { type, text });
    log('heading', '⬡ SYNC TRACKING — scraping Amazon shipped orders');

    // 1. Collect Amazon orders that have shipped/delivered status
    const amzOrders = await this.scrapeAmazonOrders(accountId);
    const shipped = amzOrders.filter(o => /delivered|shipped|arriving/i.test(o.status) && o.orderId);
    log('info', `  → ${shipped.length} shipped/delivered Amazon orders (of ${amzOrders.length} total)`);

    if (!shipped.length) {
      log('warn', '  No shipped Amazon orders found');
      return { success: true, tracked: 0 };
    }

    // 2. Get eBay orders that still need tracking
    const ebayOrders = db.getOrders().filter(o => !o.tracking_number);
    log('info', `  → ${ebayOrders.length} eBay orders without tracking`);

    // Track which eBay orders have already been claimed this run — prevents double-assignment
    const claimedEbayIds = new Set();

    let tracked = 0, skipped = 0;

    for (const amz of shipped) {
      const amzShipTo = (amz.shipTo || '').trim().toLowerCase();
      if (!amzShipTo || amzShipTo.length < 2) { skipped++; continue; }
      const amzParts = amzShipTo.split(/\s+/);
      const amzFirst = amzParts[0];
      const amzLast  = amzParts[amzParts.length - 1]; // last word = last name

      // Priority 1: exact amazon_order_id linkage (set during fulfill/sync)
      // Priority 2: full name match (first + last)
      // Priority 3: first name + last name both present (handles "John A. Smith" vs "John Smith")
      // Never match on first name alone
      const ebayMatch = ebayOrders.find(o => {
        if (claimedEbayIds.has(o.order_id)) return false;
        // Definitive match via stored amazon_order_id
        if (o.amazon_order_id && o.amazon_order_id === amz.orderId) return true;
        const name = (o.ship_name || o.buyer_name || '').trim().toLowerCase();
        if (!name) return false;
        const eParts = name.split(/\s+/);
        const eFirst = eParts[0];
        const eLast  = eParts[eParts.length - 1];
        // Require both first AND last name to match — first name alone is not enough
        const fullMatch = eFirst === amzFirst && eLast === amzLast;
        if (!fullMatch) return false;
        // If we have titles, use overlap as a sanity check (don't block on it — titles often differ)
        if (amz.title && o.item_title) {
          const overlap = this.wordOverlap(o.item_title, amz.title);
          if (overlap < 0.15) return false; // titles too different — skip, probably wrong buyer
        }
        return true;
      });

      if (!ebayMatch) {
        log('warn', `  ⚠ No eBay match for AMZ ${amz.orderId} (ship-to: "${amz.shipTo || '?'}")`);
        skipped++;
        continue;
      }

      // Claim this eBay order immediately so no other Amazon order can steal it
      claimedEbayIds.add(ebayMatch.order_id);
      log('info', `  Pulling tracking for #${ebayMatch.order_id} buyer="${ebayMatch.ship_name || ebayMatch.buyer_name}" (AMZ: ${amz.orderId})...`);
      try {
        const tracking = await this.scrapeAmazonTracking(amz.orderId, accountId);
        if (!tracking?.trackingNumber) {
          log('warn', `  ⚠ No tracking number yet for AMZ ${amz.orderId}`);
          skipped++;
          continue;
        }

        // Update DB
        db.updateOrder(ebayMatch.order_id, {
          tracking_number: tracking.trackingNumber,
          carrier: tracking.carrier || 'USPS',
          amazon_order_id: ebayMatch.amazon_order_id || amz.orderId,
        });
        emit('fill-order-updated', { orderId: ebayMatch.order_id });
        log('success', `  ✓ #${ebayMatch.order_id} → ${tracking.trackingNumber} (${tracking.carrier})`);

        // Mark shipped on eBay
        try {
          await this.markEbayShipped({ ...ebayMatch, tracking_number: tracking.trackingNumber, carrier: tracking.carrier || 'USPS' }, accountId);
          db.updateOrder(ebayMatch.order_id, { fulfill_status: 'shipped' });
          emit('fill-order-updated', { orderId: ebayMatch.order_id });
          log('success', `  ✓ Marked shipped on eBay: #${ebayMatch.order_id}`);
        } catch (e) {
          log('warn', `  ⚠ Tracking saved but eBay mark-shipped failed: ${e.message}`);
        }

        tracked++;
      } catch (e) {
        log('warn', `  ⚠ Error for AMZ ${amz.orderId}: ${e.message}`);
        skipped++;
      }
      await this.delay(1200);
    }

    log('heading', `⬡ SYNC TRACKING COMPLETE — ${tracked} tracked, ${skipped} skipped`);
    return { success: true, tracked, skipped };
  },

  // ── AliExpress order fulfillment ─────────────────────────────
  // Navigates to the AliExpress product page, clicks Buy Now, changes
  // the shipping address to the eBay buyer's address (matching saved
  // addresses by name or editing one), then clicks Place Order.
  async fulfillOrderAliExpress(order, aliItemId, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const page = await this.newPage(accountId);
    try {
      // 1. Go to product page
      await page.goto(`https://www.aliexpress.com/item/${aliItemId}.html`, { waitUntil: 'domcontentloaded' });
      await this.delay(3500);

      // 2. Select quantity if > 1
      const qty = parseInt(order.quantity) || 1;
      if (qty > 1) {
        const qtyPlus = await page.$('[class*="quantity"] [class*="plus"], [class*="qty"] button:last-child');
        if (qtyPlus) {
          for (let i = 1; i < qty; i++) {
            const box = await qtyPlus.boundingBox();
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await this.delay(300);
          }
        }
      }

      // 3. Click Buy Now
      const buyNow = await page.$('[data-pl="product-buy-now"], .purchase-btn--buyNow, button[class*="buy-now"], a[class*="buy-now"]');
      if (!buyNow) return { success: false, error: 'AliExpress Buy Now button not found' };
      const buyBox = await buyNow.boundingBox();
      if (!buyBox) return { success: false, error: 'Buy Now button not visible' };
      await page.mouse.click(buyBox.x + buyBox.width / 2, buyBox.y + buyBox.height / 2);
      await this.delay(4000);

      // Should now be on /p/trade/confirm.html
      if (!/confirm|trade|checkout/i.test(page.url())) {
        return { success: false, error: `Did not reach checkout — landed on: ${page.url().slice(0, 80)}` };
      }

      // 4. Change shipping address to buyer's address
      const buyerName = (order.ship_name || order.buyer_name || '').trim();
      const buyerFirstName = buyerName.split(' ')[0].toLowerCase();
      const buyerZip = (order.ship_zip || '').split('-')[0];

      // Click "Change" link on the shipping address section
      const changeBtn = await page.evaluateHandle(() =>
        [...document.querySelectorAll('a, button, span')].find(el =>
          /^change$/i.test((el.textContent || '').trim()))
      );
      if (changeBtn) {
        const changeBox = await changeBtn.boundingBox().catch(() => null);
        if (changeBox) {
          await page.mouse.click(changeBox.x + changeBox.width / 2, changeBox.y + changeBox.height / 2);
          await this.delay(2000);
        }
      }

      // 5. In address modal: find saved address by buyer name or edit one
      const addressed = await page.evaluate((firstName, fullName, zip) => {
        // Find all address container rows in the modal
        const items = [...document.querySelectorAll('[class*="address-item"]')].filter(el =>
          el.querySelector('input[type="radio"]'));
        for (const item of items) {
          const text = (item.innerText || '').toLowerCase();
          if (text.includes(firstName) || text.includes(fullName.toLowerCase())) {
            // Click this radio button
            const radio = item.querySelector('input[type="radio"]');
            if (radio) { radio.click(); return { found: true, method: 'radio' }; }
          }
        }
        return { found: false };
      }, buyerFirstName, buyerName, buyerZip);

      if (!addressed.found) {
        // Click Edit on the first non-default address to reuse its slot
        const editLinks = await page.$$('[class*="address-item"] a, [class*="address-item"] button');
        let editClicked = false;
        for (const el of editLinks) {
          const t = await el.evaluate(e => e.textContent.trim());
          if (/^edit$/i.test(t)) {
            const box = await el.boundingBox();
            if (box) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); editClicked = true; break; }
          }
        }
        if (!editClicked) return { success: false, error: 'Could not find saved address or Edit button in AliExpress modal' };
        await this.delay(2000);

        // Fill address form
        const typeField = async (selectors, val) => {
          if (!val) return;
          for (const sel of selectors) {
            const el = await page.$(sel);
            if (el) {
              await el.click({ clickCount: 3 });
              await el.type(String(val), { delay: 20 });
              return;
            }
          }
        };

        // Split buyer name into first/last
        const nameParts = buyerName.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || firstName;

        await typeField(['input[name="firstName"], [placeholder*="first" i]'], firstName);
        await typeField(['input[name="lastName"], [placeholder*="last" i]'], lastName);
        await typeField(['input[name="mobileNo"], input[name="phone"], [placeholder*="phone" i]'], (order.buyer_phone || '').replace(/\D/g, '').slice(-10));
        await typeField(['input[name="address"], input[name="addressLine1"], [placeholder*="address" i]'], order.ship_addr1);
        await typeField(['input[name="city"], [placeholder*="city" i]'], order.ship_city);
        await typeField(['input[name="zip"], input[name="postCode"], [placeholder*="zip" i], [placeholder*="postal" i]'], buyerZip);

        // State — try select first, then input
        const stateVal = order.ship_state || '';
        const stateSelect = await page.$('select[name="province"], select[name="state"]');
        if (stateSelect) {
          await page.select('select[name="province"], select[name="state"]', stateVal).catch(() => {});
        } else {
          await typeField(['input[name="province"], input[name="state"], [placeholder*="state" i]'], stateVal);
        }

        // Save the address
        await this.delay(500);
        const saveBtn = await page.evaluateHandle(() =>
          [...document.querySelectorAll('button, input[type="submit"]')].find(el =>
            /save|confirm|ok/i.test(el.textContent || el.value || ''))
        );
        if (saveBtn) {
          const saveBox = await saveBtn.boundingBox().catch(() => null);
          if (saveBox) { await page.mouse.click(saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2); }
        }
        await this.delay(2500);
      } else {
        // Address was selected via radio — click Confirm in modal
        const confirmBtn = await page.evaluateHandle(() =>
          [...document.querySelectorAll('button, a')].find(el =>
            /confirm|use this|select|ok/i.test((el.textContent || '').trim()))
        );
        if (confirmBtn) {
          const box = await confirmBtn.boundingBox().catch(() => null);
          if (box) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
        }
        await this.delay(2000);
      }

      // 6. Safety check — verify buyer name appears on checkout page
      const addressOk = await page.evaluate((name, zip) => {
        const text = document.body.innerText.toLowerCase();
        return name && text.includes(name.toLowerCase()) && (!zip || text.includes(zip));
      }, buyerFirstName, buyerZip).catch(() => false);

      if (!addressOk) {
        const fs = require('fs');
        const debugPath = path.join(app.getPath('userData'), 'checkout-debug.txt');
        const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
        fs.appendFileSync(debugPath, `\n=== ALI ADDRESS FAIL ${order.order_id} ${new Date().toISOString()} ===\n${pageText.slice(0, 3000)}\n`, 'utf8');
        return { success: false, error: `Buyer address (${buyerName}, ${buyerZip}) not confirmed on AliExpress checkout — refusing to place` };
      }

      // 7. Capture order total
      const orderTotal = await page.evaluate(() => {
        const text = document.body.innerText;
        const m = text.match(/total[:\s]+\$?([\d.]+)/i);
        return m ? parseFloat(m[1]) : null;
      }).catch(() => null);

      // 8. Place Order — yellow PayPal button or generic place-order button
      const placeBtn = await page.$('[class*="place-order"] button, [class*="placeOrder"] button, button[class*="pay-btn"], .pay-btn, [class*="paypal-btn"] button');
      if (!placeBtn) {
        // Fall back: any button containing "place order" text
        const fallback = await page.evaluateHandle(() =>
          [...document.querySelectorAll('button, input[type="submit"]')].find(el =>
            /place order|confirm order|pay now/i.test(el.textContent || el.value || ''))
        );
        const fb = await fallback.asElement();
        if (!fb) return { success: false, error: 'AliExpress Place Order button not found' };
        const box = await fb.boundingBox();
        if (!box) return { success: false, error: 'Place Order button not visible' };
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        const box = await placeBtn.boundingBox();
        if (!box) return { success: false, error: 'Place Order button not visible' };
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }

      // 9. Wait for confirmation
      let confirmed = false;
      for (let w = 0; w < 12 && !confirmed; w++) {
        await this.delay(2000);
        confirmed = await page.evaluate(() =>
          /order.*success|payment.*success|thank.*order|order.*placed/i.test(document.body.innerText) ||
          /trade\/order|order\/detail|pay\/success/i.test(location.href)
        ).catch(() => false);
      }

      if (!confirmed) {
        const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
        // PayPal might open in a new window — check URL too
        const isPayPal = /paypal/i.test(page.url());
        if (isPayPal) return { success: false, error: 'AliExpress redirected to PayPal login — please set a card as default payment instead of PayPal' };
        return { success: false, error: `Order placed but no confirmation detected (url: ${page.url().slice(0, 80)})` };
      }

      db.updateOrder(order.order_id, { fulfill_status: 'ordered', amazon_cost: orderTotal || null });
      return { success: true, amazonOrderId: '', amazonCost: orderTotal, source: 'aliexpress' };

    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      await page.close().catch(() => {});
    }
  },

  async fulfillOrder(order, asin, accountId = 'acc1') {
    const db = DB.forAccount(accountId);
    const page = await this.newPage(accountId);
    try {
      await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded' });
      await this.delay(2000);

      // Select quantity BEFORE Buy Now (eBay orders can be for multiple units)
      const qty = parseInt(order.quantity) || 1;
      if (qty > 1) {
        const qtySet = await page.select('#quantity, select[name="quantity"]', String(qty)).catch(() => []);
        if (qtySet.length) {
          await this.delay(800);
        } else {
          return { success: false, error: `Order is for ${qty} units but quantity selector not found — fulfill manually` };
        }
      }

      // "Buy Now" goes straight to checkout — preferred over add-to-cart flow
      const buyNow = await page.$('#buy-now-button');
      if (buyNow) {
        await buyNow.click();
      } else {
        const addBtn = await page.$('#add-to-cart-button, input[name="submit.add-to-cart"]');
        if (!addBtn) return { success: false, error: 'Buy Now / Add to cart button not found' };
        await addBtn.click();
        await this.delay(2000);
        await page.evaluate(() => { const btn = document.querySelector('#proceed-to-checkout-action, #hlb-ptc-btn, #checkout-button, input[name="proceedToRetailCheckout"]'); if (btn) btn.click(); });
      }
      await this.delay(3500);

      // Amazon's checkout is a multi-step wizard that resumes wherever it left off.
      // Loop: detect which page we're on, take the right action, repeat until the
      // review page shows the Place Order button with the BUYER's address.
      const buyerName0 = (order.ship_name || order.buyer_name || '').trim();
      const buyerZip0 = (order.ship_zip || '').split('-')[0];
      let reachedReview = false;

      for (let step = 0; step < 12; step++) {
        const s = await page.evaluate(({ name, zip }) => {
          const text = document.body.innerText;
          const m = text.match(/Delivering to ([^\n]+)/i);
          return {
            addressSelect: /select a delivery address/i.test(text),
            addressForm: !!document.querySelector('#address-ui-widgets-enterAddressFullName, #enterAddressFullName'),
            payment: /use this payment method/i.test(text),
            placeBtn: !!document.querySelector('input[name="placeYourOrder1"], #submitOrderButtonId, #placeOrder, [data-testid="placeOrderButton"]'),
            deliveringTo: m ? m[1].trim() : null,
            hasBuyerAddr: !!(name && text.toLowerCase().includes(name.toLowerCase()) && zip && text.includes(zip)),
          };
        }, { name: buyerName0, zip: buyerZip0 }).catch(() => ({}));

        // evaluate failed → page mid-navigation; wait and re-detect
        if (s.placeBtn === undefined) { await this.delay(2500); continue; }

        if (s.placeBtn && s.hasBuyerAddr) { reachedReview = true; break; }

        if (s.addressForm) {
          await this.fillAddress(page, order);
          continue;
        }
        if (s.addressSelect) {
          await page.evaluate(() => {
            const el = [...document.querySelectorAll('a, button, [role="button"]')]
              .find(e => /add a new (delivery )?address/i.test(e.textContent || ''));
            if (el) el.click();
          }).catch(() => {});
          await this.delay(3000);
          continue;
        }
        if (s.deliveringTo && buyerName0 && s.deliveringTo.toLowerCase() !== buyerName0.toLowerCase()) {
          // Wrong address on file — open the address selector
          await page.evaluate(() => {
            const candidates = [...document.querySelectorAll('a, button, [role="button"]')]
              .filter(e => /^change$/i.test((e.textContent || '').trim()));
            const best = candidates.find(e => /deliver/i.test(e.closest('div,section')?.innerText || '')) || candidates[0];
            if (best) best.click();
          }).catch(() => {});
          await this.delay(3500);
          continue;
        }
        if (s.payment) {
          await page.evaluate(() => {
            const el = [...document.querySelectorAll('input[type="submit"], button, [role="button"]')]
              .find(e => /use this payment method/i.test((e.textContent || e.value || '')));
            if (el) el.click();
          }).catch(() => {});
          await this.delay(4000);
          continue;
        }
        await this.delay(2500);
      }

      if (!reachedReview) {
        return { success: false, error: 'Could not reach review page with buyer address after 12 checkout steps' };
      }

      // Uncheck gift options
      await page.evaluate(() => { document.querySelectorAll('input[name*="gift"], #gift-wrap-checkbox').forEach(el => { if (el.checked) el.click(); }); }).catch(() => {});
      await this.delay(400);

      // Place order — wait for the button across old and new checkout layouts
      const placeSelectors = [
        'input[name="placeYourOrder1"]',
        '#submitOrderButtonId',
        '#placeOrder',
        'input[name="placeOrder1"]',
        '#bottomSubmitOrderButtonId',
        'span#submitOrderButtonId input',
        'input[data-testid="placeOrderButton"]',
        '[data-testid="placeOrderButton"]',
      ].join(', ');

      let placeBtn = null;
      for (let i = 0; i < 8 && !placeBtn; i++) {
        placeBtn = await page.$(placeSelectors);
        if (!placeBtn) await this.delay(1500);
      }

      // SAFETY: never place an order unless the buyer's address is on the checkout page.
      // Otherwise Amazon ships to YOUR default address.
      const buyerName = (order.ship_name || order.buyer_name || '').trim();
      const buyerZip = (order.ship_zip || '').split('-')[0];
      const addressOk = await page.evaluate(({ name, zip }) => {
        const text = document.body.innerText.toLowerCase();
        const nameOk = name && text.includes(name.toLowerCase());
        const zipOk = zip && text.includes(zip);
        return nameOk && zipOk;
      }, { name: buyerName, zip: buyerZip }).catch(() => false);

      if (!addressOk) {
        // Try opening the address selector and adding the buyer's address
        const changeLink = await page.$('#addressChangeLinkId, a[href*="addressselect"], [data-testid="address-change-link"]');
        if (changeLink) {
          await changeLink.click();
          await this.delay(2500);
          await this.fillAddress(page, order);
          await this.delay(3000);
        }
        const recheck = await page.evaluate(({ name, zip }) => {
          const text = document.body.innerText.toLowerCase();
          return name && text.includes(name.toLowerCase()) && zip && text.includes(zip);
        }, { name: buyerName, zip: buyerZip }).catch(() => false);
        if (!recheck) {
          // Dump checkout page structure so we can fix the address selector flow
          try {
            const fs = require('fs');
            const debugPath = path.join(app.getPath('userData'), 'checkout-debug.txt');
            const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            const links = await page.evaluate(() =>
              [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')]
                .map(b => `${b.tagName} id="${b.id || ''}" class="${(b.className || '').toString().slice(0, 60)}" text="${(b.textContent || b.value || '').trim().slice(0, 60)}"`)
                .filter(s => /address|deliver|change|ship/i.test(s))
                .slice(0, 30).join('\n')
            ).catch(() => '');
            fs.appendFileSync(debugPath, `\n===== ADDRESS FAIL ${order.order_id} — ${new Date().toISOString()} =====\nURL: ${page.url()}\n\n--- ADDRESS-RELATED ELEMENTS ---\n${links}\n\n--- PAGE TEXT ---\n${text.slice(0, 4000)}\n`, 'utf8');
          } catch (_) {}
          return { success: false, error: `Buyer address (${buyerName}, ${buyerZip}) not on checkout page — refusing to place order to wrong address` };
        }
      }

      if (!placeBtn) {
        // Dump the checkout page so we can see what Amazon is showing
        try {
          const fs = require('fs');
          const debugPath = path.join(app.getPath('userData'), 'checkout-debug.txt');
          const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
          const buttons = await page.evaluate(() =>
            [...document.querySelectorAll('input[type="submit"], button, [role="button"]')]
              .map(b => `${b.tagName}#${b.id || '?'} name=${b.name || '?'} text="${(b.textContent || b.value || '').trim().slice(0, 50)}"`)
              .slice(0, 40).join('\n')
          ).catch(() => '');
          fs.appendFileSync(debugPath, `\n===== ${order.order_id} — ${new Date().toISOString()} =====\nURL: ${page.url()}\n\n--- BUTTONS ---\n${buttons}\n\n--- PAGE TEXT ---\n${text.slice(0, 3000)}\n`, 'utf8');
        } catch (_) {}
        return { success: false, error: `Place Order button not found (page: ${page.url().slice(0, 80)})` };
      }

      // For multi-unit orders, verify the review page shows the right quantity
      if (qty > 1) {
        const qtyOk = await page.evaluate((q) => {
          const text = document.body.innerText;
          return new RegExp(`(Quantity|Qty)[.:]?\\s*${q}\\b`, 'i').test(text);
        }, qty).catch(() => false);
        if (!qtyOk) {
          return { success: false, error: `Review page doesn't show quantity ${qty} — refusing to place (would under-ship)` };
        }
      }

      // Capture what we're actually about to pay — used for real profit tracking
      // instead of guessing cost as a fraction of the eBay sale price.
      const orderTotal = await page.evaluate(() => {
        const text = document.body.innerText;
        const m = text.match(/order total:?\s*\$([0-9][0-9,]*\.?[0-9]*)/i)
               || text.match(/grand total:?\s*\$([0-9][0-9,]*\.?[0-9]*)/i);
        return m ? parseFloat(m[1].replace(/,/g, '')) : null;
      }).catch(() => null);

      // Real mouse click at coordinates — element.click() is silently swallowed
      // on Amazon's review page (verified 2026-06)
      await placeBtn.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await this.delay(800);
      const box = await placeBtn.boundingBox();
      if (!box) return { success: false, error: 'Place Order button not visible' };
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      // Confirmation = the thank-you page URL, NOT page text (review page contains
      // boilerplate that false-matches "order placed")
      let confirmed = false;
      for (let w = 0; w < 10 && !confirmed; w++) {
        await this.delay(2000);
        confirmed = await page.evaluate(() =>
          /thankyou|thank-you/i.test(location.href) ||
          /order (has been )?placed|thank you, your order/i.test(document.body.innerText)
        ).catch(() => false);
      }
      if (!confirmed) {
        return { success: false, error: 'Clicked Place Order but no thank-you page appeared — check Amazon manually before retrying' };
      }

      // NOTE: ids on the thank-you page are purchase-session ids (106-...), not the
      // real order id (112-...). Mark ordered now; the tracking step resolves the
      // real id from order history by matching the buyer name.
      db.updateOrder(order.order_id, { fulfill_status: 'ordered', amazon_cost: orderTotal || null });
      return { success: true, amazonOrderId: '', amazonCost: orderTotal };
    } catch (e) { return { success: false, error: e.message }; }
    finally { await page.close(); }
  },

  // Fills the already-open address form in Amazon's new checkout.
  // Verified working flow (2026-06): type fields → set hidden native <select>
  // for state → submit via #checkout-primary-continue-button-id.
  async fillAddress(page, order) {
    const typeInto = async (selectors, val) => {
      if (!val) return;
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) { await el.click({ clickCount: 3 }); await el.type(String(val), { delay: 20 }); return; }
        } catch (_) {}
      }
    };

    await page.waitForSelector('#address-ui-widgets-enterAddressFullName, #enterAddressFullName', { timeout: 10000 }).catch(() => {});

    await typeInto(['#address-ui-widgets-enterAddressFullName', '#enterAddressFullName'], order.ship_name || order.buyer_name);
    await typeInto(['#address-ui-widgets-enterAddressPhoneNumber', '#enterAddressPhoneNumber'], (order.buyer_phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''));
    await typeInto(['#address-ui-widgets-enterAddressLine1', '#enterAddressAddressLine1'], order.ship_addr1);
    await typeInto(['#address-ui-widgets-enterAddressLine2', '#enterAddressAddressLine2'], order.ship_addr2);
    await typeInto(['#address-ui-widgets-enterAddressCity', '#enterAddressCity'], order.ship_city);
    await typeInto(['#address-ui-widgets-enterAddressPostalCode', '#enterAddressPostalCode'], (order.ship_zip || '').split('-')[0]);

    // State: Amazon's a-dropdown wraps a hidden native <select> — set it directly
    if (order.ship_state) {
      await page.evaluate((st) => {
        const FULL = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };
        const full = FULL[st] || st;
        const selects = [...document.querySelectorAll('select')].filter(s =>
          /stateorregion/i.test(s.id) || /stateorregion/i.test(s.name || ''));
        if (!selects.length) {
          const inp = document.querySelector('#address-ui-widgets-enterAddressStateOrRegion, #enterAddressStateOrRegion');
          if (inp && inp.tagName === 'INPUT') { inp.value = st; inp.dispatchEvent(new Event('input', { bubbles: true })); }
          return;
        }
        const sel = selects[0];
        const match = [...sel.options].find(o =>
          o.value === st || o.text.trim() === st ||
          o.text.trim().toLowerCase() === full.toLowerCase() ||
          o.value.toLowerCase() === full.toLowerCase());
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('blur', { bubbles: true }));
          const prompt = sel.closest('span.a-dropdown-container, span[id]')?.querySelector('.a-dropdown-prompt');
          if (prompt) prompt.textContent = match.text;
        }
      }, order.ship_state).catch(() => {});
    }
    await this.delay(800);

    // Submit — primary continue button in new checkout, legacy fallbacks after
    await page.evaluate(() => {
      let btn = document.querySelector('#checkout-primary-continue-button-id input[type="submit"], #address-ui-widgets-form-submit-button input, input[name="shipToThisAddress"]');
      if (!btn) {
        btn = [...document.querySelectorAll('input[type="submit"], button, [role="button"]')]
          .find(e => {
            const label = (e.textContent || e.value || e.getAttribute('aria-label') || '').trim();
            return /use this address|add address|save address/i.test(label);
          });
      }
      if (btn) btn.click();
    }).catch(() => {});
    await this.delay(4000);

    // Address validation popup — confirm if Amazon questions the address
    await page.evaluate(() => {
      const pop = document.querySelector('.a-popover[aria-hidden="false"], #AVS_form');
      if (!pop) return;
      const btn = [...pop.querySelectorAll('input[type="submit"], button, a')]
        .find(e => /use this address|ship to this address|confirm|original/i.test((e.textContent || e.value || '').trim()));
      if (btn) btn.click();
    }).catch(() => {});
    await this.delay(2500);
  },

  async scrapeAmazonTracking(amazonOrderId, accountId = 'acc1') {
    const page = await this.newPage(accountId);
    try {
      await page.goto(`https://www.amazon.com/gp/css/order-details?orderID=${amazonOrderId}`, { waitUntil: 'domcontentloaded' });
      await this.delay(2500);

      const extract = (text) => {
        // "Tracking ID: TBA309..." (Amazon Logistics) or standard carrier formats
        const m = text.match(/Tracking ID:?\s*([A-Z0-9]{10,})/i)
          || text.match(/\b(1Z[A-Z0-9]{16}|TBA[0-9]{9,}|9[0-9]{21}|[0-9]{20,22}|[A-Z]{2}[0-9]{9}US)\b/);
        if (!m) return null;
        const tl = text.toLowerCase();
        const num = m[1] || m[0];
        const carrier = num.startsWith('TBA') || tl.includes('amazon logistics') ? 'Amazon'
          : num.startsWith('1Z') || tl.includes('ups') ? 'UPS'
          : tl.includes('fedex') ? 'FedEx' : 'USPS';
        return { trackingNumber: num, carrier };
      };

      // Try the order details page first
      let text = await page.evaluate(() => document.body.innerText).catch(() => '');
      let t = extract(text);
      if (t) return t;

      // Follow "Track package" to the progress tracker page
      const trackLink = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a')].find(e =>
          /track package/i.test(e.textContent) || /progress-tracker/.test(e.href || ''));
        return a ? a.href : null;
      }).catch(() => null);
      if (trackLink) {
        await page.goto(trackLink, { waitUntil: 'domcontentloaded' });
        await this.delay(2500);
        // Tracking ID is sometimes behind "See all updates" — try to expand
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('a, button')].find(e => /see all updates|shipment details/i.test(e.textContent));
          if (b) b.click();
        }).catch(() => {});
        await this.delay(1500);
        text = await page.evaluate(() => document.body.innerText).catch(() => '');
        t = extract(text);
        if (t) return t;
      }

      return { trackingNumber: '', carrier: '' };
    } finally { await page.close(); }
  },

  // Verified flow (2026-06): "Add tracking" button → form opens in an IFRAME
  // (ebay.com/ship/trk/trackings) → Tracking number textbox + Carrier combobox
  // → "Save and continue"
  async markEbayShipped(order, accountId = 'acc1') {
    const page = await this.newPage(accountId);
    try {
      await page.goto(order.detail_url || `https://www.ebay.com/mesh/ord/details?mode=SH&orderid=${order.order_id}&source=Orders`, { waitUntil: 'domcontentloaded' });
      await this.delay(4000);

      // Click "Add tracking" (find by text — real mouse click)
      const btnHandle = (await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button')].find(e =>
          /^add tracking$/i.test((e.textContent || '').trim()));
      })).asElement();
      if (!btnHandle) throw new Error('"Add tracking" button not found on order page');
      await btnHandle.evaluate(e => e.scrollIntoView({ block: 'center' }));
      await this.delay(500);
      const bbox = await btnHandle.boundingBox();
      await page.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);

      // Wait for the tracking iframe
      let trkFrame = null;
      for (let i = 0; i < 10 && !trkFrame; i++) {
        await this.delay(1000);
        trkFrame = page.frames().find(f => f.url().includes('/ship/trk/'));
      }
      if (!trkFrame) throw new Error('Tracking iframe did not appear');
      await this.delay(2000);

      // Tracking number: the plain textbox (id ends with -textbox)
      const numInput = await trkFrame.$('input[id$="-textbox"]');
      if (!numInput) throw new Error('Tracking number input not found in iframe');
      await numInput.click({ clickCount: 3 });
      await numInput.type(order.tracking_number, { delay: 25 });
      await this.delay(400);

      // Carrier: combobox input — type the carrier and pick the first suggestion
      const carrierMap = { Amazon: 'Amazon', UPS: 'UPS', FedEx: 'FedEx', USPS: 'USPS' };
      const carrier = carrierMap[order.carrier] || order.carrier || 'USPS';
      const carrierInput = await trkFrame.$('input[role="combobox"], input[id$="-input"]');
      if (carrierInput) {
        await carrierInput.click({ clickCount: 3 });
        await carrierInput.type(carrier, { delay: 40 });
        await this.delay(1200);
        // Pick first autocomplete option if a listbox opened
        await trkFrame.evaluate(() => {
          const opt = document.querySelector('[role="listbox"] [role="option"], .combobox-options li');
          if (opt) opt.click();
        }).catch(() => {});
        await this.delay(500);
      }

      // Save and continue
      const saved = await trkFrame.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(e =>
          /save and continue|^save$/i.test((e.textContent || '').trim()));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!saved) throw new Error('"Save and continue" button not found in iframe');
      await this.delay(3500);

      // Verify: the order page should now show the tracking number or "Mark not shipped"
      const verified = await page.evaluate((trk) =>
        document.body.innerText.includes(trk) || /mark not shipped/i.test(document.body.innerText),
        order.tracking_number).catch(() => false);
      if (!verified) throw new Error('Saved but tracking not visible on order page — verify manually');
    } finally { await page.close(); }
  },

  async sendEbayMessage(order, messageText, accountId = 'acc1') {
    const page = await this.newPage(accountId);
    try {
      await page.goto(order.detail_url || `https://www.ebay.com/mesh/ord/details?mode=SH&orderid=${order.order_id}&source=Orders`, { waitUntil: 'domcontentloaded' });
      await this.delay(3000);

      // The order page has SEVERAL "Message buyer" buttons; only one is visible.
      // Pick the visible one and JS-click it (coordinate clicks hit the hidden ones).
      const clicked = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a')].filter(e =>
          /^message buyer$/i.test((e.textContent || '').trim()));
        const vis = els.find(e => e.offsetParent !== null) || els[0];
        if (!vis) return false;
        vis.scrollIntoView({ block: 'center' });
        vis.click();
        return true;
      });
      if (!clicked) throw new Error('"Message buyer" button not found');
      await this.delay(4000);

      // Compose form lives in an iframe (ebay.com/cnt/ViewMessage/getConversation)
      const findTextarea = async () => {
        let ta = await page.$('textarea');
        if (ta) return { ta, ctx: page };
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          ta = await frame.$('textarea').catch(() => null);
          if (ta) return { ta, ctx: frame };
        }
        return null;
      };
      let found = null;
      for (let i = 0; i < 8 && !found; i++) { found = await findTextarea(); if (!found) await this.delay(1500); }
      if (!found) throw new Error('Message textarea not found after clicking Message buyer');

      await found.ta.click();
      await found.ta.type(messageText, { delay: 8 });
      await this.delay(500);

      const sent = await found.ctx.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(e =>
          /^send( message)?$/i.test((e.textContent || e.value || '').trim()));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!sent) throw new Error('Send button not found in message form');
      await this.delay(2500);
    } finally { await page.close(); }
  }
};

module.exports = Pipeline;
