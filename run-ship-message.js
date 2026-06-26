// run-ship-message.js — standalone Ship + Message run (mirrors pipeline.runShipAndMessage)
// eBay awaiting list = ground truth → match Amazon by buyer → tracking → ship → message.

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DB_PATH = path.join(process.env.APPDATA, 'zayndrop', 'zayndrop-data.json');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8').replace(/^﻿/, ''));
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
const updateOrder = (id, patch) => {
  const o = db.orders.find(x => x.order_id === id);
  if (o) { Object.assign(o, patch, { updated_at: new Date().toISOString() }); saveDB(); }
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

let browser, page;

async function newPage() {
  const p = await browser.newPage();
  p.setDefaultTimeout(60000);
  return p;
}

async function scrapeAwaiting() {
  const p = await newPage();
  try {
    await p.goto('https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT', { waitUntil: 'domcontentloaded' });
    try { await p.waitForSelector('tr.order-info', { timeout: 15000 }); } catch (_) {}
    await delay(2000);
    return await p.evaluate(() => {
      const rows = [...document.querySelectorAll('tr.order-info')];
      const titleEls = [...document.querySelectorAll('.item-title')];
      return rows.map((row, idx) => {
        const orderId = [...row.classList].find(c => c.startsWith('orderid_'))?.replace('orderid_', '') || '';
        if (!orderId) return null;
        const cell0 = row.querySelectorAll('td.order-default-cell')[0]?.textContent?.trim() || '';
        const buyerName = cell0.replace(orderId, '').replace('View order details', '').trim().split(/[a-z0-9_\-\.]{4,}Buyer/i)[0]?.trim().slice(0, 60) || '';
        return { orderId, buyerName, itemTitle: titleEls[idx]?.textContent?.trim() || '' };
      }).filter(Boolean);
    });
  } finally { await p.close(); }
}

async function scrapeAmazonOrders() {
  const out = [];
  for (let s = 0; s <= 20; s += 10) {
    const p = await newPage();
    try {
      await p.goto(`https://www.amazon.com/your-orders/orders?startIndex=${s}`, { waitUntil: 'domcontentloaded' });
      await delay(2500);
      const batch = await p.evaluate(() => {
        return [...document.querySelectorAll('.order-card.js-order-card')].map(card => {
          const text = card.innerText;
          return {
            orderId: text.match(/(\d{3}-\d{7}-\d{7})/)?.[1] || '',
            shipTo: (text.match(/Ship to\s*\n?\s*([^\n]+)/i) || [])[1]?.trim() || '',
            arriving: (text.match(/(?:Arriving|Delivered|Expected)\s+([^\n]+)/i) || [])[1]?.trim() || '',
          };
        }).filter(o => o.orderId);
      });
      out.push(...batch);
      if (batch.length < 10) { await p.close(); break; }
    } finally { try { await p.close(); } catch (_) {} }
  }
  return out;
}

async function scrapeTracking(amazonOrderId) {
  const p = await newPage();
  try {
    await p.goto(`https://www.amazon.com/gp/css/order-details?orderID=${amazonOrderId}`, { waitUntil: 'domcontentloaded' });
    await delay(2500);
    const extract = (text) => {
      const m = text.match(/Tracking ID:?\s*([A-Z0-9]{10,})/i)
        || text.match(/\b(1Z[A-Z0-9]{16}|TBA[0-9]{9,}|9[0-9]{21}|[A-Z]{2}[0-9]{9}US)\b/);
      if (!m) return null;
      const num = m[1] || m[0];
      const tl = text.toLowerCase();
      const carrier = num.startsWith('TBA') ? 'Amazon' : num.startsWith('1Z') ? 'UPS' : tl.includes('fedex') ? 'FedEx' : 'USPS';
      return { trackingNumber: num, carrier };
    };
    let t = extract(await p.evaluate(() => document.body.innerText).catch(() => ''));
    if (t) return t;
    const link = await p.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(e => /track package/i.test(e.textContent) || /progress-tracker/.test(e.href || ''));
      return a ? a.href : null;
    }).catch(() => null);
    if (link) {
      await p.goto(link, { waitUntil: 'domcontentloaded' });
      await delay(2500);
      await p.evaluate(() => {
        const b = [...document.querySelectorAll('a, button')].find(e => /see all updates|shipment details/i.test(e.textContent));
        if (b) b.click();
      }).catch(() => {});
      await delay(1500);
      t = extract(await p.evaluate(() => document.body.innerText).catch(() => ''));
      if (t) return t;
    }
    return null;
  } finally { await p.close(); }
}

async function markShipped(order) {
  const p = await newPage();
  try {
    await p.goto(`https://www.ebay.com/mesh/ord/details?mode=SH&orderid=${order.order_id}&source=Orders`, { waitUntil: 'domcontentloaded' });
    await delay(4000);
    const clicked = await p.evaluate(() => {
      const els = [...document.querySelectorAll('button')].filter(e => /^add tracking$/i.test((e.textContent || '').trim()));
      const vis = els.find(e => e.offsetParent !== null) || els[0];
      if (!vis) return false;
      vis.scrollIntoView({ block: 'center' });
      vis.click();
      return true;
    });
    if (!clicked) throw new Error('Add tracking button not found');
    let frame = null;
    for (let i = 0; i < 10 && !frame; i++) { await delay(1000); frame = p.frames().find(f => f.url().includes('/ship/trk/')); }
    if (!frame) throw new Error('tracking iframe missing');
    await delay(2000);
    const numInput = await frame.$('input[id$="-textbox"]');
    await numInput.click({ clickCount: 3 });
    await numInput.type(order.tracking_number, { delay: 25 });
    await delay(400);
    const carrierInput = await frame.$('input[role="combobox"], input[id$="-input"]');
    if (carrierInput) {
      await carrierInput.click({ clickCount: 3 });
      await carrierInput.type(order.carrier || 'USPS', { delay: 40 });
      await delay(1200);
      await frame.evaluate(() => {
        const opt = document.querySelector('[role="listbox"] [role="option"], .combobox-options li');
        if (opt) opt.click();
      }).catch(() => {});
      await delay(500);
    }
    const saved = await frame.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(e => /save and continue|^save$/i.test((e.textContent || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!saved) throw new Error('Save button missing');
    await delay(3500);
  } finally { await p.close(); }
}

async function messageBuyer(order, arriving) {
  const p = await newPage();
  try {
    await p.goto(`https://www.ebay.com/mesh/ord/details?mode=SH&orderid=${order.order_id}&source=Orders`, { waitUntil: 'domcontentloaded' });
    await delay(4500);
    const clicked = await p.evaluate(() => {
      const els = [...document.querySelectorAll('button, a')].filter(e => /^message buyer$/i.test((e.textContent || '').trim()));
      const vis = els.find(e => e.offsetParent !== null) || els[0];
      if (!vis) return false;
      vis.scrollIntoView({ block: 'center' });
      vis.click();
      return true;
    });
    if (!clicked) throw new Error('Message buyer button not found');
    await delay(5000);
    let ctx = null, ta = null;
    for (let i = 0; i < 8 && !ta; i++) {
      ta = await p.$('textarea');
      if (ta) { ctx = p; break; }
      for (const f of p.frames()) {
        if (f === p.mainFrame()) continue;
        ta = await f.$('textarea').catch(() => null);
        if (ta) { ctx = f; break; }
      }
      if (!ta) await delay(1500);
    }
    if (!ta) throw new Error('compose textarea not found');
    const firstName = (order.ship_name || order.buyer_name || 'there').split(/\s+/)[0];
    const msg = `Hey ${firstName}, your order is arriving${arriving ? ' ' + arriving : ' soon'}. Feel free to give a review!`;
    await ta.click();
    await ta.type(msg, { delay: 8 });
    await delay(800);
    const sent = await ctx.evaluate(() => {
      const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(e => /^send( message)?$/i.test((e.textContent || e.value || '').trim()));
      if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
      return false;
    });
    if (!sent) throw new Error('Send button not found');
    await delay(2500);
    log(`  ✓ messaged: "${msg}"`);
  } finally { await p.close(); }
}

(async () => {
  const userDataDir = path.join(process.env.APPDATA, 'zayndrop', 'puppeteer-profile');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(userDataDir, f)); } catch (_) {}
  }
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  browser = await puppeteer.launch({
    headless: false, userDataDir, defaultViewport: null,
    executablePath: chromePaths.find(p => fs.existsSync(p)),
    args: ['--no-sandbox', '--start-maximized', '--no-first-run', '--no-default-browser-check'],
  });
  page = (await browser.pages())[0];

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const isRecent = (o) => { if (!o.sale_date) return false; const d = new Date(o.sale_date); return !isNaN(d) && d >= todayStart; };
  const messagable = (o) => !o.message_sent && (['pending', 'ordered'].includes(o.fulfill_status) || isRecent(o));

  log('Checking eBay awaiting-shipment (ground truth)...');
  const awaitingRows = await scrapeAwaiting();
  const awaiting = new Set(awaitingRows.map(r => r.orderId));
  log(`  → ${awaiting.size} awaiting on eBay: ${[...awaiting].join(', ') || '(none)'}`);
  // Register unknown awaiting orders
  for (const r of awaitingRows) {
    if (!db.orders.find(o => o.order_id === r.orderId)) {
      db.orders.unshift({ id: Date.now(), order_id: r.orderId, item_title: r.itemTitle, buyer_name: r.buyerName, fulfill_status: 'pending', created_at: new Date().toISOString(), sale_date: new Date().toDateString() });
      saveDB();
      log(`  + new order found: ${r.orderId} (${r.buyerName})`);
    }
  }

  const candidates = db.orders.filter(o =>
    o.fulfill_status !== 'cancelled' &&
    (awaiting.has(o.order_id) || ['pending', 'ordered'].includes(o.fulfill_status) ||
     (o.fulfill_status === 'shipped' && messagable(o))));
  log(`${candidates.length} orders to process`);
  if (!candidates.length) { log('Nothing to do.'); await browser.close(); process.exit(0); }

  log('Scanning Amazon orders...');
  const amz = await scrapeAmazonOrders();
  log(`  → ${amz.length} Amazon orders`);

  let shipped = 0, messaged = 0, waiting = 0;
  for (const order of candidates) {
    log(`── #${order.order_id} (${order.ship_name || order.buyer_name}) [${order.fulfill_status}]`);
    try {
      const buyer = (order.ship_name || order.buyer_name || '').trim().toLowerCase();
      let match = order.amazon_order_id ? amz.find(a => a.orderId === order.amazon_order_id) : null;
      if (!match && buyer) match = amz.find(a => a.shipTo.toLowerCase() === buyer);
      if (!match) { log(`  ⚠ no matching Amazon order for "${buyer}"`); continue; }
      if (!order.amazon_order_id) updateOrder(order.order_id, { amazon_order_id: match.orderId });

      let hasTracking = !!order.tracking_number;
      if (!hasTracking) {
        const t = await scrapeTracking(match.orderId);
        if (t) {
          order.tracking_number = t.trackingNumber; order.carrier = t.carrier;
          updateOrder(order.order_id, { tracking_number: t.trackingNumber, carrier: t.carrier });
          log(`  ✓ tracking: ${t.trackingNumber} (${t.carrier})`);
          hasTracking = true;
        } else {
          waiting++;
          log(`  ⚠ Amazon hasn't shipped yet (${match.arriving || 'no tracking'})`);
        }
      }

      if (hasTracking && (awaiting.has(order.order_id) || order.fulfill_status !== 'shipped')) {
        await markShipped(order);
        updateOrder(order.order_id, { fulfill_status: 'shipped' });
        shipped++;
        log(`  ✓ marked shipped on eBay`);
      }

      if (messagable(order)) {
        await messageBuyer(order, match.arriving);
        updateOrder(order.order_id, { message_sent: 1 });
        messaged++;
      }
    } catch (e) { log(`  ✕ ${e.message}`); }
    await delay(1500);
  }

  log(`DONE — ${shipped} shipped, ${messaged} messaged, ${waiting} awaiting Amazon shipment`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
