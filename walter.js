// walter.js — ZaynDrop's autonomous business intelligence agent
// Default:   node walter.js          (uses saved scout results)
// Full hunt: node walter.js --hunt   (fresh Puppeteer Amazon scrape)

const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const { execSync } = require('child_process');
const nodemailer = require('nodemailer');

// ── Config ──────────────────────────────────────────────────────────────────
const USER_DATA     = path.join(process.env.APPDATA, 'zayndrop');
const STATUS_PATH   = path.join(USER_DATA, 'agent-status.json');
const DB_PATH     = path.join(USER_DATA, 'zayndrop-data-acc1.json');
const CFG_PATH    = path.join(USER_DATA, 'config.json');
const LOG_PATH    = path.join(USER_DATA, 'agent-log.json');
const DIGEST_PATH = path.join(USER_DATA, 'daily-digest.html');
const PPTR_PROFILE = path.join(USER_DATA, 'puppeteer-profile');

const EMAIL_FROM = process.env.ZAYN_EMAIL_FROM || 'jeelanikeelzayn@gmail.com';
const EMAIL_TO   = process.env.ZAYN_EMAIL_TO   || 'jeelanikeelzayn@gmail.com';
const EMAIL_PASS = process.env.ZAYN_EMAIL_PASS || '';

// Keywords to hunt when running with --hunt
const HUNT_KEYWORDS = [
  '65w usb c laptop charger',
  'roku remote replacement',
  'usb c charger 65w pd',
  'laptop charger fast charge',
];
// ────────────────────────────────────────────────────────────────────────────

// ── Live status file (UI polls this) ─────────────────────────────────────────
const _status = { running: false, started_at: null, finished_at: null, error: null, lines: [] };

function statusLog(line) {
  console.log(line);
  _status.lines.push({ t: new Date().toISOString(), msg: line });
  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(_status), 'utf8'); } catch {}
}

function statusStart() {
  _status.running = true;
  _status.started_at = new Date().toISOString();
  _status.finished_at = null;
  _status.error = null;
  _status.lines = [];
  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(_status), 'utf8'); } catch {}
}

function statusDone(err) {
  _status.running = false;
  _status.finished_at = new Date().toISOString();
  _status.error = err || null;
  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(_status), 'utf8'); } catch {}
}

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { orders: [], queue: [], bank: [], scout_results: null }; }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch { return {}; }
}

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const cfg = readConfig();
  return cfg.anthropicKey || cfg.__internal?.anthropicKey || null;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Business context builder ─────────────────────────────────────────────────
function buildContext(db) {
  const yday = yesterday();
  const allOrders = db.orders || [];

  const ydayOrders = allOrders.filter(o => (o.created_at || '').startsWith(yday));
  const fulfilled  = ydayOrders.filter(o => o.amazon_order_id);
  const pending    = allOrders.filter(o => !o.amazon_order_id && o.fulfill_status !== 'cancelled');

  let revenue = 0, cost = 0;
  fulfilled.forEach(o => {
    revenue += parseFloat(o.sale_price) || 0;
    cost    += parseFloat(o.amazon_cost) || 0;
  });
  const fees   = revenue * 0.13;
  const profit = revenue - cost - fees;

  const bank = (db.asin_map || []); // bank feature unused; asin_map is the real active listing count

  return {
    date: yday,
    yesterday: {
      ordersReceived:   ydayOrders.length,
      ordersFulfilled:  fulfilled.length,
      revenue:          revenue.toFixed(2),
      amazonCost:       cost.toFixed(2),
      ebayFees:         fees.toFixed(2),
      estimatedProfit:  profit.toFixed(2),
      orders: ydayOrders.map(o => ({
        id:         o.order_id,
        item:       o.item_title,
        status:     o.fulfill_status || 'pending',
        salePrice:  o.sale_price,
        amazonCost: o.amazon_cost,
        fulfilled:  !!o.amazon_order_id,
        messageSent:!!o.message_sent,
      }))
    },
    pending: {
      count: pending.length,
      orders: pending.slice(0, 5).map(o => ({ id: o.order_id, item: o.item_title, created: o.created_at?.slice(0, 10) }))
    },
    activeListings: {
      count: bank.length,
      listings: bank.map(b => ({ asin: b.asin, title: b.title, price: b.our_price }))
    },
    queue: { count: (db.queue || []).length },
    allTime: {
      totalFulfilled: allOrders.filter(o => o.amazon_order_id).length,
      totalOrders:    allOrders.length,
    }
  };
}

// ── Claude API call (https, no fetch dependency) ─────────────────────────────
function claudeCall(apiKey, system, userMsg, maxTokens = 1024) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Daily digest generation ──────────────────────────────────────────────────
async function generateDigest(apiKey, context) {
  return claudeCall(apiKey,
    `You are ZaynDrop's autonomous business intelligence agent. You analyze daily data for Zayn's eBay dropshipping business (sourcing from Amazon) and provide actionable insights.

Business: sells 65W USB-C laptop chargers and Roku remotes on eBay, sourced from Amazon. Multiple accounts.
Profit formula: sale price − Amazon cost − 13% eBay fees.
Use ZaynDrop app for automation: fulfillment, scouting, listing.

Be direct and specific. Reference actual numbers. No generic advice.`,

    `Daily business data for ${context.date}:
${JSON.stringify(context, null, 2)}

Produce a digest with these sections (HTML, inline styles only):
1. <b>Yesterday at a Glance</b> — key numbers, flag unfulfilled orders or missing messages
2. <b>Profit Estimate</b> — revenue minus costs minus 13% eBay fees breakdown
3. <b>What's Working / What's Not</b> — patterns in orders, listings, pricing
4. <b>Today's Priority</b> — one specific task

Max 300 words. No CSS frameworks.`,
    1024
  );
}

// ── AI Picks from scout products ─────────────────────────────────────────────
async function runAIPicks(apiKey, products) {
  if (!products?.length) return null;

  const top = [...products]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 40)
    .map(p => ({
      asin: p.asin || null,
      title: (p.title || p.ebayTitle || '').slice(0, 80),
      amazonPrice: p.price || null,
      reviews: p.reviews || null,
      score: p.score,
      ebayLowest: p.ebayLowest ?? null,
      ebayCount: p.ebayCount ?? null,
      sold30d: p.sold30d ?? null,
      marginAfterFees: p.margin ?? null,
      signalSource: p.signalSource || p.source || 'hunt',
    }));

  const raw = await claudeCall(apiKey,
    'You are an expert Amazon-to-eBay dropshipping analyst.',
    `For each product below give: STRONG BUY, BUY, WATCH, or SKIP with one reason (max 12 words).
Weigh: observed eBay sales (sold30d/sold7d = real demand) > margin > competitor count > reviews.
signalSource "competitor:<seller>" = strongest signal. "movers" = rank spike. "keyword"/"hunt" = search result.

Products:
${JSON.stringify(top, null, 1)}

Reply ONLY with a JSON array: [{"asin":"...","title":"first 30 chars","verdict":"BUY","reason":"..."}]`,
    2000
  );

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]); }
  catch { return null; }
}

// ── Standalone Puppeteer hunt (--hunt mode) ───────────────────────────────────
async function runFreshHunt(keywords) {
  const puppeteer = require('puppeteer');
  const veroPath  = path.join(__dirname, 'assets', 'vero.txt');
  const veroBrands = fs.readFileSync(veroPath, 'utf8')
    .split('\n').map(l => l.trim().toLowerCase()).filter(l => l.length > 2);

  function isVero(title) {
    const t = title.toLowerCase();
    return veroBrands.some(b => t.includes(b));
  }

  function score(p) {
    let s = 0;
    if (p.price >= 8 && p.price <= 60) s += 30; else if (p.price > 0) s += 10;
    if (p.reviews >= 1000) s += 25;
    else if (p.reviews >= 200) s += 20;
    else if (p.reviews >= 50) s += 12;
    else if (p.reviews >= 10) s += 5;
    if (p.prime) s += 10;
    s += 12; // unknown eBay competition (no check in nightly for speed)
    return Math.min(100, s);
  }

  // Clear stale lock files
  for (const lf of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(PPTR_PROFILE, lf);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }

  console.log('[scout] Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: PPTR_PROFILE,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const seen = new Set();
  const all  = [];

  try {
    for (const kw of keywords) {
      for (let pg = 1; pg <= 2; pg++) {
        console.log(`[scout] Searching "${kw}" page ${pg}...`);
        const page = await browser.newPage();
        try {
          await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(kw)}&page=${pg}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await new Promise(r => setTimeout(r, 2500));
          const items = await page.evaluate(() =>
            [...document.querySelectorAll('[data-asin]')].map(card => {
              const asin = card.getAttribute('data-asin');
              if (!asin || asin.length !== 10) return null;
              const title = card.querySelector('h2')?.textContent?.trim() || '';
              if (!title) return null;
              const price = parseFloat(card.querySelector('.a-price .a-offscreen')?.textContent?.replace(/[$,]/g, '') || '0') || 0;
              const reviewsEl = [...card.querySelectorAll('span[aria-label]')].find(s => /^[\d,]+$/.test(s.textContent.trim()));
              const reviews = parseInt((reviewsEl?.textContent || '0').replace(/,/g, '')) || 0;
              const sponsored = !!card.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"]');
              const prime = !!card.querySelector('.a-icon-prime');
              return { asin, title, price, reviews, sponsored, prime };
            }).filter(Boolean)
          );
          for (const it of items) {
            if (seen.has(it.asin) || it.sponsored || isVero(it.title)) continue;
            seen.add(it.asin);
            it.keyword = kw;
            it.signalSource = 'hunt';
            it.score = score(it);
            all.push(it);
          }
          console.log(`[scout]   → ${items.length} items found`);
        } catch (e) {
          console.warn(`[scout]   ⚠ ${kw} p${pg}: ${e.message}`);
        } finally { await page.close().catch(() => {}); }
        await new Promise(r => setTimeout(r, 800));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  all.sort((a, b) => b.score - a.score);
  console.log(`[scout] Hunt done — ${all.length} products after VeRO filter`);
  return all;
}

// ── Render AI picks as HTML ───────────────────────────────────────────────────
function renderPicks(picks, source) {
  const colors = { 'STRONG BUY': '#00cc66', 'BUY': '#c8f04a', 'WATCH': '#f0a832', 'SKIP': '#888' };
  const rows = picks.map(p => {
    const color = colors[p.verdict] || '#ccc';
    return `<tr>
      <td style="padding:6px 8px;color:${color};font-weight:bold;white-space:nowrap">${p.verdict}</td>
      <td style="padding:6px 8px;font-size:12px">${p.title}</td>
      <td style="padding:6px 8px;font-size:11px;color:#888">${p.reason}</td>
    </tr>`;
  }).join('');

  return `<div style="margin-top:20px">
  <h3 style="color:#c8f04a;margin:0 0 10px">⬡ Scout AI Picks <span style="font-size:11px;color:#888;font-weight:normal">(${source})</span></h3>
  <table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:13px">
    <tr style="border-bottom:1px solid #333">
      <th style="text-align:left;padding:4px 8px;color:#888">Verdict</th>
      <th style="text-align:left;padding:4px 8px;color:#888">Product</th>
      <th style="text-align:left;padding:4px 8px;color:#888">Reason</th>
    </tr>
    ${rows}
  </table>
</div>`;
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendEmail(html, subject) {
  if (!EMAIL_PASS) {
    console.log('[email] No ZAYN_EMAIL_PASS set — digest saved to:', DIGEST_PATH);
    return;
  }
  const transporter = nodemailer.createTransporter({ service: 'gmail', auth: { user: EMAIL_FROM, pass: EMAIL_PASS } });
  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html });
  console.log('[email] Digest sent to', EMAIL_TO);
}

// ── Windows toast notification ────────────────────────────────────────────────
function toast(title, message) {
  try {
    const os = require('os');
    const t = title.replace(/'/g, "''");
    const m = message.replace(/'/g, "''").slice(0, 200);
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(6000, '${t}', '${m}', [System.Windows.Forms.ToolTipIcon]::None)
Start-Sleep -Seconds 7
$n.Dispose()
`.trim();
    const tmp = path.join(os.tmpdir(), 'zayndrop-toast.ps1');
    require('fs').writeFileSync(tmp, script, 'utf8');
    execSync(`powershell -NoProfile -NonInteractive -File "${tmp}"`, { timeout: 10000, windowsHide: true });
  } catch (_) { /* toast failure is non-fatal */ }
}

// ── Run log ───────────────────────────────────────────────────────────────────
function appendLog(entry) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch {}
  log.unshift({ ...entry, ran_at: new Date().toISOString() });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log.slice(0, 30), null, 2), 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const doHunt = process.argv.includes('--hunt');
  statusStart();
  statusLog(`⬡ Walter starting — ${new Date().toLocaleString()}`);
  statusLog(`Mode: ${doHunt ? 'fresh Amazon hunt' : 'saved scout results'}`);

  const apiKey = getApiKey();
  if (!apiKey) {
    statusLog('✗ No API key found — add it on the ZaynDrop Home screen');
    statusDone('No API key');
    process.exit(1);
  }

  statusLog('Reading business data...');
  const db      = readDB();
  const context = buildContext(db);

  statusLog(`Yesterday: ${context.yesterday.ordersReceived} orders received, ${context.yesterday.ordersFulfilled} fulfilled`);
  statusLog(`Estimated profit: $${context.yesterday.estimatedProfit} (after Amazon cost + 13% fees)`);
  statusLog(`Pending orders: ${context.pending.count} | Active listings: ${context.activeListings.count} | Queue: ${context.queue.count}`);

  // ── Scout ──────────────────────────────────────────────────────────────────
  let scoutProducts = null;
  let scoutSource   = '';

  if (doHunt) {
    statusLog('Launching browser for Amazon hunt...');
    try {
      scoutProducts = await runFreshHunt(HUNT_KEYWORDS);
      scoutSource = `fresh hunt — ${scoutProducts.length} products`;
      const dbRaw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      dbRaw.scout_results = { products: scoutProducts, saved_at: new Date().toISOString() };
      fs.writeFileSync(DB_PATH, JSON.stringify(dbRaw, null, 2), 'utf8');
      statusLog(`Hunt complete — ${scoutProducts.length} products after VeRO filter, saved to DB`);
    } catch (e) {
      statusLog(`⚠ Hunt failed: ${e.message} — falling back to saved results`);
    }
  }

  if (!scoutProducts && db.scout_results?.products?.length) {
    scoutProducts = db.scout_results.products;
    const savedAt = db.scout_results.saved_at?.slice(0, 10) || 'unknown date';
    scoutSource = `saved results from ${savedAt}`;
    statusLog(`Using ${scoutProducts.length} saved scout products (from ${savedAt})`);
  } else if (!scoutProducts) {
    statusLog('No scout results available — run Scout in-app first, or use --hunt flag');
  }

  // ── AI Picks ───────────────────────────────────────────────────────────────
  let picksHtml = '';
  if (scoutProducts?.length) {
    statusLog(`Running AI Picks on top ${Math.min(40, scoutProducts.length)} products...`);
    try {
      const picks = await runAIPicks(apiKey, scoutProducts);
      if (picks?.length) {
        picksHtml = renderPicks(picks, scoutSource);
        const buys = picks.filter(p => p.verdict === 'STRONG BUY' || p.verdict === 'BUY').length;
        const strong = picks.filter(p => p.verdict === 'STRONG BUY').length;
        statusLog(`AI Picks complete — ${strong} STRONG BUY, ${buys - strong} BUY, ${picks.length - buys} WATCH/SKIP`);
      }
    } catch (e) {
      statusLog(`⚠ AI Picks failed: ${e.message}`);
    }
  }

  // ── Digest ─────────────────────────────────────────────────────────────────
  statusLog('Generating business digest...');
  const digestBody = await generateDigest(apiKey, context);

  const subject = `ZaynDrop Daily — ${context.date} | ${context.yesterday.ordersFulfilled} fulfilled | $${context.yesterday.estimatedProfit} profit`;

  const fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family:monospace;max-width:700px;margin:40px auto;color:#1a1a1a;background:#f9f9f9;padding:24px;border-radius:8px;line-height:1.5">
  <h2 style="color:#c8f04a;background:#1a1a1a;padding:12px 16px;border-radius:4px;margin:0 0 20px">
    ⬡ ZaynDrop Daily Digest — ${context.date}
  </h2>
  ${digestBody}
  ${picksHtml}
  <hr style="margin:24px 0;border:1px solid #ddd">
  <p style="font-size:11px;color:#888">
    Generated ${new Date().toLocaleString()} · mode: ${doHunt ? 'fresh hunt' : 'saved results'}<br>
    ${context.yesterday.ordersReceived} orders yesterday · ${context.pending.count} pending · ${context.activeListings.count} live listings · ${scoutProducts?.length || 0} scout products analyzed
  </p>
</body>
</html>`;

  fs.writeFileSync(DIGEST_PATH, fullHtml, 'utf8');
  statusLog('Digest saved — open via ZaynDrop Home → open digest');

  await sendEmail(fullHtml, subject);
  if (EMAIL_PASS) statusLog(`Email sent to ${EMAIL_TO}`);

  appendLog({
    date:             context.date,
    mode:             doHunt ? 'hunt' : 'saved',
    orders_received:  context.yesterday.ordersReceived,
    orders_fulfilled: context.yesterday.ordersFulfilled,
    estimated_profit: context.yesterday.estimatedProfit,
    pending_orders:   context.pending.count,
    scout_products:   scoutProducts?.length || 0,
  });

  statusLog('✓ Agent finished');
  statusDone(null);

  toast('Walter ✓',
    `${context.yesterday.ordersFulfilled} fulfilled · $${context.yesterday.estimatedProfit} profit · ${context.pending.count} pending`);
}

main().catch(err => {
  const msg = err.message || String(err);
  statusLog(`✗ Fatal error: ${msg}`);
  statusDone(msg);
  toast('Walter ✗', `Failed: ${msg}`);
  process.exit(1);
});

/*
── WINDOWS TASK SCHEDULER SETUP ──────────────────────────────────────────────
Run once in PowerShell (as yourself, not admin):

  $nodePath = (Get-Command node).Source
  $action   = New-ScheduledTaskAction -Execute $nodePath `
                -Argument "C:\Users\zaynj\OneDrive\Desktop\Zayndrop\zayndrop\walter.js" `
                -WorkingDirectory "C:\Users\zaynj\OneDrive\Desktop\Zayndrop\zayndrop"
  $trigger  = New-ScheduledTaskTrigger -Daily -At "7:00AM"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
  Register-ScheduledTask -TaskName "ZaynDrop Walter" -Action $action -Trigger $trigger -Settings $settings -Force

For weekly fresh hunt (Sunday 6AM), add a second task:
  $action2  = New-ScheduledTaskAction -Execute $nodePath `
                -Argument "C:\Users\zaynj\OneDrive\Desktop\Zayndrop\zayndrop\walter.js --hunt" `
                -WorkingDirectory "C:\Users\zaynj\OneDrive\Desktop\Zayndrop\zayndrop"
  $trigger2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "6:00AM"
  $settings2 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
  Register-ScheduledTask -TaskName "ZaynDrop Weekly Hunt" -Action $action2 -Trigger $trigger2 -Settings $settings2 -Force

Email setup — set Windows environment variable (System Settings → Advanced → Environment Variables):
  ZAYN_EMAIL_PASS = <16-char Gmail App Password>
  (Get one: myaccount.google.com → Security → 2-Step Verification → App passwords)
──────────────────────────────────────────────────────────────────────────────
*/
