// debug-form-probe.js — opens the address form and dumps its exact structure
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ASIN = 'B0DLSRTWN2';
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

  await page.goto(`https://www.amazon.com/dp/${ASIN}`, { waitUntil: 'domcontentloaded' });
  await delay(2500);
  await (await page.$('#buy-now-button')).click();
  await delay(4000);

  // Get to address selection (click Change if on pay page)
  let onSelect = await page.evaluate(() => /select a delivery address/i.test(document.body.innerText));
  if (!onSelect) {
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('a, button, [role="button"]')]
        .filter(e => /^change$/i.test((e.textContent || '').trim()));
      const best = c.find(e => /deliver/i.test(e.closest('div,section')?.innerText || '')) || c[0];
      if (best) best.click();
    });
    await delay(3500);
  }

  // Open add-new-address form
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('a, button, [role="button"]')]
      .find(e => /add a new (delivery )?address/i.test(e.textContent || ''));
    if (el) el.click();
  });
  await delay(3500);

  // DUMP: every form control inside the address form area
  const dump = await page.evaluate(() => {
    const out = [];
    out.push('=== ALL VISIBLE INPUTS/SELECTS ===');
    [...document.querySelectorAll('input, select, textarea')].forEach(e => {
      if (e.offsetParent === null && e.type !== 'hidden') return;
      out.push(`${e.tagName} type=${e.type || '?'} id="${e.id}" name="${e.name || ''}" visible=${e.offsetParent !== null}`);
      if (e.tagName === 'SELECT') {
        out.push(`  OPTIONS(${e.options.length}): ${[...e.options].slice(0, 12).map(o => `"${o.value}"|"${o.text}"`).join(', ')}`);
      }
    });
    out.push('');
    out.push('=== DROPDOWN-LIKE ELEMENTS ===');
    [...document.querySelectorAll('[data-action="a-dropdown-button"], [role="button"][aria-haspopup], .a-dropdown-prompt, [data-a-class*="dropdown"]')].forEach(e => {
      out.push(`${e.tagName} id="${e.id}" class="${(e.className || '').toString().slice(0, 80)}" text="${(e.textContent || '').trim().slice(0, 50)}" parentId="${e.parentElement?.id || ''}" closestSpanId="${e.closest('span[id]')?.id || ''}"`);
    });
    out.push('');
    out.push('=== SUBMIT BUTTONS ===');
    [...document.querySelectorAll('input[type="submit"], button')].forEach(e => {
      if (e.offsetParent === null) return;
      out.push(`${e.tagName} id="${e.id}" name="${e.name || ''}" text="${(e.textContent || e.value || '').trim().slice(0, 60)}" closestSpanId="${e.closest('span[id]')?.id || ''}"`);
    });
    return out.join('\n');
  });

  log(dump);
  log('\n⛔ Browser stays open. Ctrl+C to exit.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
