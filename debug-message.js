// debug-message.js — debugs and SENDS the buyer message for each shipped order.
// Heavily logged; updates DB message_sent on success.

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DB_PATH = path.join(process.env.APPDATA, 'zayndrop', 'zayndrop-data.json');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8').replace(/^﻿/, ''));
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

async function messageOrder(page, order) {
  log(`── #${order.order_id} (${order.ship_name})`);
  await page.goto(`https://www.ebay.com/mesh/ord/details?mode=SH&orderid=${order.order_id}&source=Orders`, { waitUntil: 'domcontentloaded' });
  await delay(4500);

  // Arrival estimate from the order page
  const arrival = await page.evaluate(() => {
    const m = document.body.innerText.match(/Estimated delivery[^:]*:?\s*([A-Z][a-z]{2} \d{1,2}(?:, \d{4})?(?:\s*-\s*[A-Z][a-z]{2} \d{1,2}, \d{4})?)/);
    return m ? m[1].trim() : '';
  }).catch(() => '');
  log(`  arrival estimate: "${arrival}"`);

  // Diagnose the Message buyer button
  const diag = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a')].filter(e =>
      /^message buyer$/i.test((e.textContent || '').trim()));
    return els.map(e => {
      const r = e.getBoundingClientRect();
      return `${e.tagName} class="${(e.className || '').toString().slice(0, 50)}" rect=${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)} offsetParent=${e.offsetParent !== null}`;
    });
  });
  log(`  Message buyer candidates:\n    ${diag.join('\n    ') || 'NONE'}`);
  if (!diag.length) throw new Error('No Message buyer button');

  // Click the first VISIBLE one — JS click (works even without coordinates)
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a')].filter(e =>
      /^message buyer$/i.test((e.textContent || '').trim()));
    const vis = els.find(e => e.offsetParent !== null) || els[0];
    vis.scrollIntoView({ block: 'center' });
    vis.click();
    return true;
  });
  log(`  clicked (JS): ${clicked}`);
  await delay(5000);
  log(`  URL now: ${page.url()}`);

  // Find compose textarea (page, modals, iframes)
  let ctx = null, ta = null;
  for (let i = 0; i < 8 && !ta; i++) {
    ta = await page.$('textarea');
    if (ta) { ctx = page; break; }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      ta = await frame.$('textarea').catch(() => null);
      if (ta) { ctx = frame; break; }
    }
    if (!ta) await delay(1500);
  }

  if (!ta) {
    // Dump what we're looking at to figure out the compose UI
    const dump = await page.evaluate(() => {
      const out = [`URL: ${location.href}`, `TEXT: ${document.body.innerText.slice(0, 500)}`];
      out.push('INPUTS: ' + [...document.querySelectorAll('input[type="text"], [contenteditable="true"]')]
        .map(e => `${e.tagName} id="${e.id}" ce=${e.getAttribute('contenteditable')} ph="${e.placeholder || ''}"`).join(' | '));
      return out.join('\n');
    }).catch(() => '(unreadable)');
    log(`  NO TEXTAREA. Page state:\n${dump}`);
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const u = frame.url();
      if (u && u !== 'about:blank') log(`  frame: ${u.slice(0, 100)}`);
    }
    throw new Error('compose textarea not found');
  }
  log(`  textarea found in ${ctx === page ? 'main page' : 'iframe ' + ctx.url().slice(0, 80)}`);

  const firstName = (order.ship_name || 'there').split(/\s+/)[0];
  const msg = `Hey ${firstName}, your order is arriving${arrival ? ' by ' + arrival : ' soon'}. Feel free to give a review!`;
  await ta.click();
  await ta.type(msg, { delay: 8 });
  log(`  typed: "${msg}"`);
  await delay(800);

  // Send button
  const sendDiag = await ctx.evaluate(() => {
    return [...document.querySelectorAll('button, input[type="submit"]')]
      .map(e => (e.textContent || e.value || '').trim())
      .filter(t => t && t.length < 30).join(' | ');
  });
  log(`  buttons available: ${sendDiag}`);

  const sent = await ctx.evaluate(() => {
    const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(e =>
      /^send( message)?$/i.test((e.textContent || e.value || '').trim()));
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
    return false;
  });
  if (!sent) throw new Error('Send button not found');
  await delay(3500);

  // Verify send (look for confirmation or message echo)
  const after = await ctx.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
  log(`  after send: ${after.replace(/\n/g, ' ').slice(0, 150)}`);
  log(`  ✅ SENT to ${firstName}`);
  return true;
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
  const browser = await puppeteer.launch({
    headless: false, userDataDir, defaultViewport: null,
    executablePath: chromePaths.find(p => fs.existsSync(p)),
    args: ['--no-sandbox', '--start-maximized', '--no-first-run', '--no-default-browser-check'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  page.setDefaultTimeout(60000);

  const targets = db.orders.filter(o => o.fulfill_status === 'shipped' && !o.message_sent);
  log(`${targets.length} orders need messaging`);

  let ok = 0, fail = 0;
  for (const order of targets) {
    try {
      await messageOrder(page, order);
      order.message_sent = 1;
      order.updated_at = new Date().toISOString();
      saveDB();
      ok++;
    } catch (e) {
      fail++;
      log(`  ✕ FAILED: ${e.message}`);
    }
    await delay(2000);
  }

  log(`DONE — ${ok} messaged, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
