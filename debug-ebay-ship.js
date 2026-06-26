// debug-ebay-ship.js — probes the eBay order page for the Add Tracking flow
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ORDER_ID = '01-14764-11795';
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(m);

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

  await page.goto(`https://www.ebay.com/mesh/ord/details?mode=SH&orderid=${ORDER_ID}&source=Orders`, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  // Dump everything tracking-related
  const dump = await page.evaluate(() => {
    const out = [];
    out.push('=== TRACKING-RELATED CLICKABLES ===');
    [...document.querySelectorAll('a, button, [role="button"], span[onclick]')].forEach(e => {
      const t = (e.textContent || '').trim();
      if (/track|ship/i.test(t) && t.length < 60) {
        out.push(`${e.tagName} text="${t}" id="${e.id}" class="${(e.className || '').toString().slice(0, 70)}" data-testid="${e.getAttribute('data-testid') || ''}" data-test-id="${e.getAttribute('data-test-id') || ''}" href="${(e.href || '').slice(0, 80)}"`);
      }
    });
    return out.join('\n');
  });
  log(dump);

  // Try clicking "Add tracking" by text and see what opens
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a, button, [role="button"]')]
      .find(e => /^add tracking$/i.test((e.textContent || '').trim()));
    if (el) { el.click(); return true; }
    return false;
  });
  log(`\nClicked "Add tracking" by text: ${clicked}`);
  await delay(4000);

  const after = await page.evaluate(() => {
    const out = [];
    out.push(`URL after click: ${location.href}`);
    out.push('=== VISIBLE INPUTS ===');
    [...document.querySelectorAll('input, select, textarea')].forEach(e => {
      if (e.offsetParent === null) return;
      out.push(`${e.tagName} type=${e.type || '?'} id="${e.id}" name="${e.name || ''}" placeholder="${e.placeholder || ''}" aria-label="${e.getAttribute('aria-label') || ''}"`);
    });
    out.push('=== VISIBLE BUTTONS ===');
    [...document.querySelectorAll('button, input[type="submit"]')].forEach(e => {
      if (e.offsetParent === null) return;
      const t = (e.textContent || e.value || '').trim();
      if (t) out.push(`${e.tagName} text="${t.slice(0, 40)}" id="${e.id}" class="${(e.className || '').toString().slice(0, 60)}"`);
    });
    return out.join('\n');
  });
  log(after);
  log('\n⛔ Browser stays open. Ctrl+C when done.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
