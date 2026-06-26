// debug-ebay-ship3.js — full dump of the tracking iframe contents
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

  const el = (await page.evaluateHandle(() => {
    return [...document.querySelectorAll('button')].find(e =>
      /^add tracking$/i.test((e.textContent || '').trim()) && e.className.includes('default-action'));
  })).asElement();
  await el.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await delay(500);
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  log('Clicked Add tracking');
  await delay(6000);

  const trkFrame = page.frames().find(f => f.url().includes('/ship/trk/'));
  if (!trkFrame) { log('✕ tracking iframe not found'); return; }
  log(`Frame: ${trkFrame.url()}`);

  const dump = await trkFrame.evaluate(() => {
    const out = [];
    out.push('=== TEXT ===');
    out.push(document.body.innerText.slice(0, 800));
    out.push('=== INPUTS ===');
    [...document.querySelectorAll('input, select, textarea')].forEach(e => {
      const lbl = e.labels?.[0]?.textContent?.trim() || e.closest('[class*="field"]')?.querySelector('label')?.textContent?.trim() || '';
      out.push(`${e.tagName} type=${e.type || '?'} id="${e.id}" label="${lbl}" role="${e.getAttribute('role') || ''}" aria-label="${e.getAttribute('aria-label') || ''}" visible=${e.offsetParent !== null}`);
    });
    out.push('=== BUTTONS ===');
    [...document.querySelectorAll('button, input[type="submit"], a')].forEach(e => {
      const t = (e.textContent || e.value || '').trim();
      if (t && t.length < 50) out.push(`${e.tagName} text="${t}" class="${(e.className || '').toString().slice(0, 60)}" visible=${e.offsetParent !== null}`);
    });
    return out.join('\n');
  });
  log(dump);
  log('\n⛔ Browser stays open. Ctrl+C when done.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
