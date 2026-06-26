// debug-checkout.js — checkout state-machine debugger
// Handles Amazon's multi-step Chewbacca checkout in any order.
// STOPS before placing the order.
// Run: node debug-checkout.js

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ORDER = {
  order_id: '01-14764-11795',
  ship_name: 'Clyde Isgrig',
  ship_addr1: '736 Oak Meadows Ln',
  ship_addr2: '',
  ship_city: 'Leslie',
  ship_state: 'MO',
  ship_zip: '63056-1179',
  buyer_phone: '636-432-3472',
};
const ASIN = 'B0DLSRTWN2';

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

async function detectState(page, order) {
  return page.evaluate(({ name, zip }) => {
    const text = document.body.innerText;
    const t = text.toLowerCase();
    const hasBuyerAddr = t.includes(name.toLowerCase()) && text.includes(zip);
    const deliveringToBuyer = (() => {
      const m = text.match(/Delivering to ([^\n]+)/i);
      return m ? m[1].trim().toLowerCase() === name.toLowerCase() : false;
    })();
    return {
      addressSelect: /select a delivery address/i.test(text),
      addressForm: !!document.querySelector('#address-ui-widgets-enterAddressFullName, #enterAddressFullName'),
      payment: /use this payment method/i.test(text),
      placeBtn: !!document.querySelector('input[name="placeYourOrder1"], #submitOrderButtonId, #placeOrder, [data-testid="placeOrderButton"]'),
      deliveringTo: (text.match(/Delivering to ([^\n]+)/i) || [])[1]?.trim() || null,
      deliveringToBuyer,
      hasBuyerAddr,
      url: location.href,
    };
  }, { name: order.ship_name, zip: order.ship_zip.split('-')[0] });
}

async function fillAddressForm(page, order) {
  const typeInto = async (selectors, val, label) => {
    if (!val) return;
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click({ clickCount: 3 }); await el.type(String(val), { delay: 20 }); log(`    ✓ ${label}`); return; }
    }
    log(`    ✕ ${label}: field not found`);
  };

  await typeInto(['#address-ui-widgets-enterAddressFullName', '#enterAddressFullName'], order.ship_name, 'name');
  await typeInto(['#address-ui-widgets-enterAddressPhoneNumber', '#enterAddressPhoneNumber'], order.buyer_phone.replace(/\D/g, ''), 'phone');
  await typeInto(['#address-ui-widgets-enterAddressLine1', '#enterAddressAddressLine1'], order.ship_addr1, 'addr1');
  await typeInto(['#address-ui-widgets-enterAddressLine2', '#enterAddressAddressLine2'], order.ship_addr2, 'addr2');
  await typeInto(['#address-ui-widgets-enterAddressCity', '#enterAddressCity'], order.ship_city, 'city');
  await typeInto(['#address-ui-widgets-enterAddressPostalCode', '#enterAddressPostalCode'], order.ship_zip.split('-')[0], 'zip');

  // State: Amazon's a-dropdown wraps a hidden native <select>. Set it directly
  // and fire change events — no clicking the fake dropdown UI.
  const stateResult = await page.evaluate((st) => {
    const FULL = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };
    const full = FULL[st] || st;

    // Find any select that looks like the state field
    const selects = [...document.querySelectorAll('select')].filter(s =>
      /stateorregion/i.test(s.id) || /stateorregion/i.test(s.name || ''));
    if (!selects.length) {
      // Maybe it's a plain text input
      const inp = document.querySelector('#address-ui-widgets-enterAddressStateOrRegion, #enterAddressStateOrRegion');
      if (inp && inp.tagName === 'INPUT') return { mode: 'input' };
      return { mode: 'none', selectsOnPage: [...document.querySelectorAll('select')].map(s => s.id || s.name).join(',') };
    }

    const sel = selects[0];
    const opts = [...sel.options];
    const match = opts.find(o =>
      o.value === st || o.text.trim() === st ||
      o.text.trim().toLowerCase() === full.toLowerCase() ||
      o.value.toLowerCase() === full.toLowerCase());
    if (!match) {
      return { mode: 'select', matched: false, sample: opts.slice(0, 15).map(o => `${o.value}|${o.text.trim()}`).join(', ') };
    }
    sel.value = match.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('blur', { bubbles: true }));
    // Update the visible fake-dropdown label too
    const prompt = sel.closest('span.a-dropdown-container, span[id]')?.querySelector('.a-dropdown-prompt');
    if (prompt) prompt.textContent = match.text;
    return { mode: 'select', matched: true, picked: match.text, selectId: sel.id };
  }, order.ship_state);

  log(`    state: ${JSON.stringify(stateResult)}`);
  if (stateResult.mode === 'input') {
    await typeInto(['#address-ui-widgets-enterAddressStateOrRegion', '#enterAddressStateOrRegion'], order.ship_state, 'state (text)');
  }
  await delay(800);

  const submitted = await page.evaluate(() => {
    // New checkout: the form's continue button is span#checkout-primary-continue-button-id > input[type=submit]
    let btn = document.querySelector('#checkout-primary-continue-button-id input[type="submit"], #address-ui-widgets-form-submit-button input, input[name="shipToThisAddress"]');
    if (!btn) {
      // Search inside spans whose id mentions submit, or by aria-label / surrounding text
      btn = [...document.querySelectorAll('input[type="submit"], button, [role="button"]')]
        .find(e => {
          const label = (e.textContent || e.value || e.getAttribute('aria-label') || '').trim();
          const spanId = e.closest('span[id]')?.id || '';
          return /use this address|add address|save address/i.test(label) || /address.*submit|submit.*address/i.test(spanId);
        });
    }
    if (btn) { btn.click(); return `clicked: ${(btn.value || btn.textContent || btn.closest('span[id]')?.id || '?').trim().slice(0, 50)}`; }
    // Nothing found — report what submit-like elements exist
    const candidates = [...document.querySelectorAll('input[type="submit"], button')]
      .filter(e => e.offsetParent !== null)
      .map(e => `"${(e.textContent || e.value || '').trim().slice(0, 30)}" span=${e.closest('span[id]')?.id || '-'}`)
      .slice(0, 10).join(' ; ');
    return `NOT FOUND. candidates: ${candidates}`;
  });
  log(`    form submit → ${submitted}`);
  await delay(4000);

  // Validation popup ("we suggest..." / unverified address)
  const popupHandled = await page.evaluate(() => {
    const pop = document.querySelector('.a-popover[aria-hidden="false"], #AVS_form');
    if (!pop) return null;
    const btn = [...pop.querySelectorAll('input[type="submit"], button, a')]
      .find(e => /use this address|ship to this address|confirm|original/i.test((e.textContent || e.value || '').trim()));
    if (btn) { btn.click(); return (btn.textContent || btn.value || '').trim().slice(0, 50); }
    return 'POPUP PRESENT BUT NO CONFIRM BUTTON';
  });
  if (popupHandled) log(`    validation popup: ${popupHandled}`);
  await delay(3000);
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
  const executablePath = chromePaths.find(p => fs.existsSync(p));

  log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: false, userDataDir, defaultViewport: null, executablePath,
    args: ['--no-sandbox', '--start-maximized', '--no-first-run', '--no-default-browser-check'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  page.setDefaultTimeout(60000);

  log(`Opening product ${ASIN}...`);
  await page.goto(`https://www.amazon.com/dp/${ASIN}`, { waitUntil: 'domcontentloaded' });
  await delay(2500);
  const buyNow = await page.$('#buy-now-button');
  if (!buyNow) { log('✕ No Buy Now button'); return; }
  log('Clicking Buy Now...');
  await buyNow.click();
  await delay(4000);

  // State machine: up to 12 iterations to reach review with correct address
  for (let i = 0; i < 12; i++) {
    const s = await detectState(page, ORDER);
    log(`STATE ${i}: url=${s.url.match(/checkout\/p\/[^/]+\/(\w+)/)?.[1] || s.url.slice(0, 60)} | addrSelect=${s.addressSelect} form=${s.addressForm} pay=${s.payment} placeBtn=${s.placeBtn} | deliveringTo="${s.deliveringTo}" buyerAddr=${s.hasBuyerAddr}`);

    // Done: place button visible and buyer address confirmed
    if (s.placeBtn && s.hasBuyerAddr) {
      log('✅ SUCCESS — Place Order button present AND buyer address confirmed on page.');
      log('⛔ STOPPING — not placing the order. Inspect the browser; Ctrl+C when done.');
      return;
    }

    // Address form open → fill it
    if (s.addressForm) {
      log('  → Filling address form...');
      await fillAddressForm(page, ORDER);
      continue;
    }

    // Address selection list → add new address
    if (s.addressSelect) {
      log('  → Clicking "Add a new delivery address"...');
      const clicked = await page.evaluate(() => {
        const el = [...document.querySelectorAll('a, button, [role="button"]')]
          .find(e => /add a new (delivery )?address/i.test(e.textContent || ''));
        if (el) { el.click(); return true; }
        return false;
      });
      log(`    clicked: ${clicked}`);
      await delay(3000);
      continue;
    }

    // Wrong delivery address shown → click Change next to it
    if (s.deliveringTo && !s.deliveringToBuyer) {
      log(`  → Wrong address ("${s.deliveringTo}") — clicking Change...`);
      const clicked = await page.evaluate(() => {
        // Find the Change link/button nearest to "Delivering to"
        const candidates = [...document.querySelectorAll('a, button, [role="button"]')]
          .filter(e => /^change$/i.test((e.textContent || '').trim()));
        // Prefer one whose surrounding text mentions Delivering
        const best = candidates.find(e => /deliver/i.test(e.closest('div,section')?.innerText || '')) || candidates[0];
        if (best) { best.click(); return true; }
        return false;
      });
      log(`    clicked: ${clicked}`);
      await delay(3500);
      continue;
    }

    // Payment page → confirm payment method
    if (s.payment) {
      log('  → Payment page — clicking "Use this payment method"...');
      const clicked = await page.evaluate(() => {
        const el = [...document.querySelectorAll('input[type="submit"], button, [role="button"]')]
          .find(e => /use this payment method/i.test((e.textContent || e.value || '')));
        if (el) { el.click(); return true; }
        return false;
      });
      log(`    clicked: ${clicked}`);
      await delay(4000);
      continue;
    }

    // Nothing matched — dump and wait
    log('  → Unknown state, waiting 3s...');
    await delay(3000);
  }

  log('✕ Did not reach review page with buyer address after 12 steps.');
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  log(`FINAL PAGE:\n${text}`);
  log('Browser stays open — Ctrl+C when done.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
