// verify-orders.js — scrapes Amazon order history to verify which orders actually placed
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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

  await page.goto('https://www.amazon.com/your-orders/orders', { waitUntil: 'domcontentloaded' });
  await delay(3500);

  const orders = await page.evaluate(() => {
    return [...document.querySelectorAll('.order-card.js-order-card')].slice(0, 8).map(card => {
      const text = card.innerText;
      const orderId = text.match(/(\d{3}-\d{7}-\d{7})/)?.[1] || '?';
      const date = text.match(/Order placed\s*\n?\s*([A-Z][a-z]+ \d+, \d{4})/i)?.[1] || '?';
      const total = text.match(/Total\s*\n?\s*(\$[\d.]+)/i)?.[1] || '?';
      const shipTo = text.match(/Ship to\s*\n?\s*([^\n]+)/i)?.[1] || '?';
      const title = [...card.querySelectorAll('a')].map(a => a.textContent.trim()).find(t => t.length > 25) || '?';
      return { orderId, date, total, shipTo, title: title.slice(0, 70) };
    });
  });

  console.log(JSON.stringify(orders, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
