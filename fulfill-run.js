// fulfill-run.js — places real Amazon orders for pending zayndrop orders.
// Uses the checkout state machine verified by debug-checkout.js.
// Reads/writes the zayndrop JSON DB directly. Run with the app CLOSED.

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DB_PATH = path.join(process.env.APPDATA, 'zayndrop', 'zayndrop-data.json');
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8').replace(/^﻿/, ''));
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');

async function fillAddressForm(page, order) {
  const typeInto = async (selectors, val) => {
    if (!val) return;
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click({ clickCount: 3 }); await el.type(String(val), { delay: 20 }); return; }
    }
  };
  await page.waitForSelector('#address-ui-widgets-enterAddressFullName, #enterAddressFullName', { timeout: 10000 }).catch(() => {});
  await typeInto(['#address-ui-widgets-enterAddressFullName', '#enterAddressFullName'], order.ship_name || order.buyer_name);
  await typeInto(['#address-ui-widgets-enterAddressPhoneNumber', '#enterAddressPhoneNumber'], (order.buyer_phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''));
  await typeInto(['#address-ui-widgets-enterAddressLine1', '#enterAddressAddressLine1'], order.ship_addr1);
  await typeInto(['#address-ui-widgets-enterAddressLine2', '#enterAddressAddressLine2'], order.ship_addr2);
  await typeInto(['#address-ui-widgets-enterAddressCity', '#enterAddressCity'], order.ship_city);
  await typeInto(['#address-ui-widgets-enterAddressPostalCode', '#enterAddressPostalCode'], (order.ship_zip || '').split('-')[0]);

  await page.evaluate((st) => {
    const FULL = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };
    const full = FULL[st] || st;
    const selects = [...document.querySelectorAll('select')].filter(s => /stateorregion/i.test(s.id) || /stateorregion/i.test(s.name || ''));
    if (!selects.length) {
      const inp = document.querySelector('#address-ui-widgets-enterAddressStateOrRegion, #enterAddressStateOrRegion');
      if (inp && inp.tagName === 'INPUT') { inp.value = st; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      return;
    }
    const sel = selects[0];
    const match = [...sel.options].find(o => o.value === st || o.text.trim() === st || o.text.trim().toLowerCase() === full.toLowerCase() || o.value.toLowerCase() === full.toLowerCase());
    if (match) {
      sel.value = match.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('blur', { bubbles: true }));
      const prompt = sel.closest('span.a-dropdown-container, span[id]')?.querySelector('.a-dropdown-prompt');
      if (prompt) prompt.textContent = match.text;
    }
  }, order.ship_state).catch(() => {});
  await delay(800);

  await page.evaluate(() => {
    let btn = document.querySelector('#checkout-primary-continue-button-id input[type="submit"], #address-ui-widgets-form-submit-button input, input[name="shipToThisAddress"]');
    if (!btn) {
      btn = [...document.querySelectorAll('input[type="submit"], button, [role="button"]')]
        .find(e => /use this address|add address|save address/i.test((e.textContent || e.value || e.getAttribute('aria-label') || '').trim()));
    }
    if (btn) btn.click();
  }).catch(() => {});
  await delay(4000);

  await page.evaluate(() => {
    const pop = document.querySelector('.a-popover[aria-hidden="false"], #AVS_form');
    if (!pop) return;
    const btn = [...pop.querySelectorAll('input[type="submit"], button, a')]
      .find(e => /use this address|ship to this address|confirm|original/i.test((e.textContent || e.value || '').trim()));
    if (btn) btn.click();
  }).catch(() => {});
  await delay(2500);
}

async function fulfillOrder(page, order, asin) {
  log(`── Order ${order.order_id}: ${order.ship_name} ← ASIN ${asin}`);
  await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded' });
  await delay(2500);
  const buyNow = await page.$('#buy-now-button');
  if (!buyNow) return { success: false, error: 'No Buy Now button' };
  await buyNow.click();
  await delay(4000);

  const buyerName = (order.ship_name || order.buyer_name || '').trim();
  const buyerZip = (order.ship_zip || '').split('-')[0];

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
    }, { name: buyerName, zip: buyerZip }).catch(() => ({}));

    if (s.addressForm === undefined) {
      // evaluate failed — page navigating or context destroyed; log where we are
      log(`  step ${step}: page busy/navigating — url=${page.url().slice(0, 100)}`);
      await delay(2500);
      continue;
    }
    log(`  step ${step}: form=${s.addressForm} select=${s.addressSelect} pay=${s.payment} place=${s.placeBtn} to="${s.deliveringTo}" buyerAddr=${s.hasBuyerAddr}`);

    if (s.placeBtn && s.hasBuyerAddr) {
      log(`  ✓ Review page with ${buyerName}'s address — PLACING ORDER`);
      const placeBtn = await page.$('input[name="placeYourOrder1"], #submitOrderButtonId, #placeOrder, [data-testid="placeOrderButton"]');

      // Scroll into view and do a real mouse click at the element's coordinates —
      // element.click() can silently miss on Amazon's review page
      await placeBtn.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await delay(800);
      const box = await placeBtn.boundingBox();
      if (!box) return { success: false, error: 'Place Order button has no bounding box (hidden?)' };
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      log('  clicked Place Order at coordinates, waiting for confirmation...');

      // Wait up to 20s for the thank-you page
      for (let w = 0; w < 10; w++) {
        await delay(2000);
        const r = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            url: location.href,
            thankyou: /thankyou|thank-you/i.test(location.href) || /order (has been )?placed|thank you, your order/i.test(text),
            orderId: (location.href + '\n' + text).match(/(\d{3}-\d{7}-\d{7})/)?.[1] || '',
          };
        }).catch(() => null);
        if (r && (r.thankyou || (r.orderId && /thankyou|confirm/i.test(r.url)))) {
          log(`  confirmation page: ${r.url.slice(0, 90)}`);
          return { success: true, amazonOrderId: r.orderId };
        }
      }

      // No confirmation — dump exactly what we're looking at
      const dump = await page.evaluate(() => ({
        url: location.href,
        text: document.body.innerText.slice(0, 1200),
      })).catch(() => ({ url: '?', text: '(unreadable)' }));
      log(`  NO CONFIRMATION. URL: ${dump.url}`);
      log(`  PAGE TEXT:\n${dump.text}`);
      return { success: false, error: 'Clicked Place Order but no confirmation — see page dump above' };
    }

    if (s.addressForm) { await fillAddressForm(page, order); continue; }
    if (s.addressSelect) {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('a, button, [role="button"]')]
          .find(e => /add a new (delivery )?address/i.test(e.textContent || ''));
        if (el) el.click();
      }).catch(() => {});
      await delay(3000);
      continue;
    }
    if (s.deliveringTo && buyerName && s.deliveringTo.toLowerCase() !== buyerName.toLowerCase()) {
      await page.evaluate(() => {
        const c = [...document.querySelectorAll('a, button, [role="button"]')]
          .filter(e => /^change$/i.test((e.textContent || '').trim()));
        const best = c.find(e => /deliver/i.test(e.closest('div,section')?.innerText || '')) || c[0];
        if (best) best.click();
      }).catch(() => {});
      await delay(3500);
      continue;
    }
    if (s.payment) {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('input[type="submit"], button, [role="button"]')]
          .find(e => /use this payment method/i.test((e.textContent || e.value || '')));
        if (el) el.click();
      }).catch(() => {});
      await delay(4000);
      continue;
    }
    await delay(2500);
  }
  return { success: false, error: 'No review page with buyer address after 12 steps' };
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

  const pending = db.orders.filter(o => o.fulfill_status === 'pending' && o.ship_addr1);
  log(`${pending.length} pending orders with addresses`);

  let placed = 0, failed = 0;
  for (const order of pending) {
    const asin = db.asin_map.find(m => m.listing_id === order.item_id)?.asin;
    if (!asin) { log(`  ⚠ No ASIN for ${order.order_id} (item ${order.item_id}) — skipping`); continue; }
    try {
      const r = await fulfillOrder(page, order, asin);
      if (r.success) {
        order.fulfill_status = 'ordered';
        order.amazon_order_id = r.amazonOrderId;
        order.updated_at = new Date().toISOString();
        saveDB();
        placed++;
        log(`  ✅ PLACED — Amazon order ${r.amazonOrderId || '(id not captured)'}`);
      } else {
        failed++;
        log(`  ✕ FAILED: ${r.error}`);
      }
    } catch (e) {
      failed++;
      log(`  ✕ ERROR: ${e.message}`);
    }
    await delay(3000);
  }

  log('');
  log(`DONE — ${placed} placed, ${failed} failed`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
