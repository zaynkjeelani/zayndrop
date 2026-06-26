// test-post.js — standalone test of the eBay posting flow for one queue item.
// Mirrors src/list/engine.js postItems. Leaves the draft OPEN (no submit).

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ITEM_ID = 59; // Paint Additives
const DB_PATH = path.join(process.env.APPDATA, 'zayndrop', 'zayndrop-data.json');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8').replace(/^﻿/, ''));
const item = db.queue.find(q => q.id === ITEM_ID);

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

(async () => {
  if (!item) { console.error('item not found'); process.exit(1); }
  log(`Item: ${item.title} | ASIN ${item.asin} | $${item.our_price}`);

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

  // ── Photos ──
  let images = [];
  const imgDir = path.join(os.tmpdir(), 'zayndrop-imgs', item.asin);
  if (fs.existsSync(imgDir)) {
    images = fs.readdirSync(imgDir).filter(f => f.endsWith('.jpg')).map(f => path.join(imgDir, f));
  }
  if (!images.length) {
    const p = (await browser.pages())[0] || await browser.newPage();
    await p.goto(`https://www.amazon.com/dp/${item.asin}`, { waitUntil: 'domcontentloaded' });
    await delay(2500);
    const urls = await p.evaluate(() => {
      const out = new Set();
      for (const m of document.body.innerHTML.matchAll(/"hiRes":"(https:[^"]+?)"/g)) out.add(m[1]);
      const landing = document.querySelector('#landingImage');
      if (landing) { const hi = landing.getAttribute('data-old-hires'); if (hi) out.add(hi); else if (landing.src) out.add(landing.src); }
      return [...out].slice(0, 7);
    });
    fs.mkdirSync(imgDir, { recursive: true });
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await fetch(urls[i]);
        if (!res.ok) continue;
        fs.writeFileSync(path.join(imgDir, `${i}.jpg`), Buffer.from(await res.arrayBuffer()));
        images.push(path.join(imgDir, `${i}.jpg`));
      } catch (_) {}
    }
  }
  log(`📷 ${images.length} photos ready`);

  // ── Prelist wizard ──
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.goto('https://www.ebay.com/sl/prelist/suggest', { waitUntil: 'domcontentloaded' });
  await delay(3500);
  const input = await page.$('input[placeholder*="what you" i], input[aria-label*="Tell us" i], .se-search-box__field input, input[type="text"]');
  if (!input) { log('✕ prelist search box not found'); return; }
  await input.click();
  await input.type(item.title.slice(0, 65), { delay: 15 });
  await delay(800);
  await page.keyboard.press('Enter');
  await delay(4000);

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
    log(`step ${step}: form=${state.form} cat=${state.category} withoutMatch=${state.withoutMatch} condition=${state.condition} url=${page.url().slice(0, 70)}`);
    if (state.form) { onForm = true; break; }

    if (state.category) {
      // Pick the FIRST suggested category path, then Done
      const picked = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, li, label, div[role="option"], span')]
          .filter(e => e.offsetParent !== null && / > /.test((e.textContent || '').trim()) && (e.textContent || '').length < 150);
        if (!els.length) return null;
        els[0].click();
        return els[0].textContent.trim().slice(0, 80);
      }).catch(() => null);
      log(`  category picked: ${picked}`);
      await delay(1200);
      await page.evaluate(() => {
        const done = [...document.querySelectorAll('button')].find(e => /^done$/i.test((e.textContent || '').trim()));
        if (done) done.click();
      }).catch(() => {});
      await delay(3500);
      continue;
    }
    if (state.withoutMatch) {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a')].find(e => /continue without match|create new listing/i.test((e.textContent || '').trim()));
        if (btn) btn.click();
      }).catch(() => {});
      await delay(3000);
      continue;
    }
    if (state.condition) {
      const picked = await page.evaluate(() => {
        const firstLine = (e) => ((e.innerText || e.textContent || '').trim().split('\n')[0] || '').trim().toLowerCase();
        const prefs = ['new', 'new with tags', 'brand new', 'new with box', 'new without tags', 'new without box', 'new other'];
        const radios = [...document.querySelectorAll('input[type="radio"]')];
        for (const pref of prefs) {
          const r = radios.find(r => {
            const lbl = (r.labels?.[0]?.innerText || r.getAttribute('aria-label') || '').trim().split('\n')[0].toLowerCase();
            return lbl === pref;
          });
          if (r) { r.click(); r.dispatchEvent(new Event('change', { bubbles: true })); (r.labels?.[0])?.click(); return pref + ' (radio)'; }
        }
        const clickables = [...document.querySelectorAll('label, [role="radio"], [role="button"], button, div, span')]
          .filter(e => e.offsetParent !== null && (e.innerText || '').length < 250);
        for (const pref of prefs) {
          const el = clickables.find(e => firstLine(e) === pref);
          if (el) { el.click(); return pref; }
        }
        return null;
      }).catch(() => null);
      log(`  condition picked: ${picked}`);
      await delay(1200);
      await page.evaluate(() => {
        const cont = [...document.querySelectorAll('button')].find(e => /continue to listing|^continue$/i.test((e.textContent || '').trim()));
        if (cont) cont.click();
      }).catch(() => {});
      await delay(4000);
      continue;
    }
    await delay(2500);
  }
  if (!onForm) {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 1200)).catch(() => '');
    log(`✕ never reached form. PAGE:\n${text}`);
    log('Browser stays open — Ctrl+C when done.');
    return;
  }
  log('✓ on listing form');
  await delay(3000);

  // ── Photos upload ──
  if (images.length) {
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) { await fileInput.uploadFile(...images); log(`📷 uploaded ${images.length}`); await delay(6000); }
    else log('⚠ no file input found');
  }

  // ── Price ──
  await page.evaluate((price) => {
    const inp = [...document.querySelectorAll('input')].find(e =>
      /price/i.test(e.name || '') || /price/i.test(e.getAttribute('aria-label') || ''));
    if (inp) { inp.value = String(price); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); }
  }, item.our_price).catch(() => {});
  log(`$ price set: ${item.our_price}`);
  await delay(1500);

  // ── Specifics: Apply all ──
  const appliedAll = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('a, button')].find(e => /^apply all$/i.test((e.textContent || '').trim()));
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);
  log(`apply all: ${appliedAll}`);
  await delay(2500);

  // ── Specifics: required combobox fields from the error banner ──
  const requiredFields = await page.evaluate(() => {
    const banner = [...document.querySelectorAll('div, section')].find(e =>
      /additional details are required/i.test(e.textContent || '') && (e.textContent || '').length < 300);
    if (!banner) return [];
    return [...banner.querySelectorAll('a')].map(a => a.textContent.trim()).filter(Boolean);
  }).catch(() => []);
  log(`required fields flagged: ${requiredFields.join(', ') || '(none)'}`);

  for (const fieldName of requiredFields) {
    let value = /brand/i.test(fieldName) ? 'Unbranded' : /color/i.test(fieldName) ? 'Multicolor' : null;
    const suggested = await page.evaluate((fn) => {
      const lbl = [...document.querySelectorAll('label, span')].find(e => (e.textContent || '').trim() === fn);
      const scope = lbl?.closest('div')?.parentElement || document;
      const m = (scope.textContent || '').match(/Suggested:\s*([A-Za-z][\w\s-]{1,25})/);
      return m ? m[1].trim() : null;
    }, fieldName).catch(() => null);
    if (suggested) value = suggested;
    if (!value) { log(`  ? no value strategy for ${fieldName}`); continue; }

    const opened = await page.evaluate((fn) => {
      const lbl = [...document.querySelectorAll('label, span, div')].find(e =>
        (e.textContent || '').trim() === fn && e.offsetParent !== null);
      if (!lbl) return 'label not found';
      let scope = lbl.parentElement;
      for (let i = 0; i < 5 && scope; i++) {
        const trig = scope.querySelector('button[aria-haspopup], [role="combobox"], button.listbox-button__control, input[role="combobox"]');
        if (trig && trig.offsetParent !== null) { trig.click(); return 'opened: ' + (trig.tagName + '.' + (trig.className || '').toString().slice(0, 40)); }
        scope = scope.parentElement;
      }
      return 'no trigger found near label';
    }, fieldName).catch(e => 'err ' + e.message);
    log(`  ${fieldName}: ${opened}`);
    if (!String(opened).startsWith('opened')) continue;
    await delay(1200);
    await page.keyboard.type(value, { delay: 30 }).catch(() => {});
    await delay(1200);
    const pickedOpt = await page.evaluate((val) => {
      const opts = [...document.querySelectorAll('[role="listbox"] [role="option"], .listbox__option, [role="option"]')]
        .filter(o => o.offsetParent !== null);
      const exact = opts.find(o => (o.textContent || '').trim().toLowerCase() === val.toLowerCase());
      const close = exact || opts.find(o => (o.textContent || '').trim().toLowerCase().startsWith(val.toLowerCase()));
      if (close) { close.click(); return (close.textContent || '').trim(); }
      return null;
    }, value).catch(() => null);
    if (!pickedOpt) { await page.keyboard.press('Enter').catch(() => {}); }
    log(`  ✓ ${fieldName} → ${pickedOpt || value + ' (typed+enter)'}`);
    await delay(1200);
  }

  // Final check
  await delay(2000);
  const banner = await page.evaluate(() => {
    const b = [...document.querySelectorAll('div, section')].find(e =>
      /additional details are required/i.test(e.textContent || '') && (e.textContent || '').length < 300);
    return b ? b.textContent.trim().slice(0, 120) : null;
  }).catch(() => null);
  log(banner ? `⚠ banner still present: ${banner}` : '✓ no required-details banner — draft looks complete');
  log('⛔ Draft left open for review — NOT submitting. Ctrl+C when done.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
