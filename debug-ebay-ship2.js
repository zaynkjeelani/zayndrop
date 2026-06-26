// debug-ebay-ship2.js — clicks Add Tracking, waits longer, dumps modal/dialog contents
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
  await delay(4500);

  // Click the primary "Add tracking" button (btn--secondary variant) with a REAL mouse click
  const btn = await page.evaluateHandle(() => {
    return [...document.querySelectorAll('button')].find(e =>
      /^add tracking$/i.test((e.textContent || '').trim()) && e.className.includes('default-action'));
  });
  const el = btn.asElement();
  if (!el) { log('No Add tracking button found'); return; }
  await el.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await delay(500);
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  log('Clicked Add tracking (mouse)');
  await delay(6000);

  log(`URL now: ${page.url()}`);

  // Dump EVERYTHING in dialogs/modals/lightboxes, visible or not
  const dump = await page.evaluate(() => {
    const out = [];
    const dialogs = [...document.querySelectorAll('[role="dialog"], .lightbox-dialog, .modal, [class*="dialog"], [class*="overlay"]')];
    out.push(`dialog-ish containers: ${dialogs.length}`);
    for (const d of dialogs.slice(0, 5)) {
      out.push(`--- ${d.tagName} class="${(d.className || '').toString().slice(0, 80)}" visible=${d.offsetParent !== null} ---`);
      out.push((d.innerText || '').slice(0, 400));
      [...d.querySelectorAll('input, select, textarea')].forEach(e => {
        out.push(`  ${e.tagName} type=${e.type} id="${e.id}" name="${e.name || ''}" placeholder="${e.placeholder || ''}" aria-label="${e.getAttribute('aria-label') || ''}"`);
      });
      [...d.querySelectorAll('button, input[type="submit"]')].forEach(e => {
        out.push(`  BTN text="${(e.textContent || e.value || '').trim().slice(0, 40)}" class="${(e.className || '').toString().slice(0, 50)}"`);
      });
    }
    // Also any input that mentions tracking anywhere
    out.push('--- any tracking inputs on page ---');
    [...document.querySelectorAll('input')].forEach(e => {
      const meta = `${e.id} ${e.name} ${e.placeholder} ${e.getAttribute('aria-label')}`;
      if (/track/i.test(meta)) out.push(`INPUT id="${e.id}" name="${e.name}" placeholder="${e.placeholder}" aria-label="${e.getAttribute('aria-label')}" visible=${e.offsetParent !== null}`);
    });
    return out.join('\n');
  });
  log(dump);

  // Check iframes too
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const finputs = await frame.evaluate(() =>
      [...document.querySelectorAll('input, select')].map(e =>
        `${e.tagName} id="${e.id}" name="${e.name || ''}" placeholder="${e.placeholder || ''}"`).join('\n')
    ).catch(() => '');
    if (finputs) log(`--- FRAME ${frame.url().slice(0, 80)} ---\n${finputs}`);
  }

  log('\n⛔ Browser stays open. Ctrl+C when done.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
