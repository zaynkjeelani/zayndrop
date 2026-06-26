// src/list/generate.js — Claude-powered eBay description generator

const Pipeline = require('../fill/pipeline');

const SHIPPING_INFO = `
<li>Free &amp; Fast Shipping — most US orders arrive in 3-7 business days via USPS/FedEx/UPS.</li>
<li>Handling Time — orders ship within 1-2 business days of payment.</li>
<li>Tracking — tracking number provided once your order ships.</li>
`.trim();

const RETURN_INFO = `
<li>30-day returns accepted. Item must be in original condition.</li>
<li>Buyer pays return shipping unless item is not as described.</li>
`.trim();

const PAYMENT_INFO = `We accept PayPal and all major credit/debit cards through eBay's secure checkout.`;
const FEEDBACK_INFO = `We strive for 5-star service. If you have any issue, please contact us before leaving feedback — we will make it right.`;
const CONTACT_INFO = `Please use eBay's messaging system to contact us. We respond within 24 hours.`;
const THANK_YOU = `Thank you for shopping with us!`;

function buildTemplate(productTitle, productImageUrl, productDescription) {
  return `<html><head>
<meta charset="utf-8">
<link href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css" rel="stylesheet">
<style>
img{max-width:100%}
.total_body{background:#fff;border:3px solid #ccc;display:block;margin:0 auto;overflow:hidden;width:950px;color:#111;border-radius:15px}
.descriptions,.tabs{width:100%;display:block;overflow:hidden}
.descriptions{font-family:Arial;font-weight:400;margin-top:25px}
.title{background-color:#fff!important;color:#058CD3!important;font-size:35px!important;font-weight:700!important;padding-bottom:20px;padding-top:20px;text-align:center!important}
.description{color:#111!important;font-size:14px!important}
.description li{padding-bottom:10px}
ul{padding-top:15px}
ul li{padding-bottom:5px}
button.accordion{background-color:#058CD3;border:none;color:#fff;cursor:pointer;font-size:26px;font-weight:bold;outline:none;padding:3px 21px;text-align:center;width:100%}
div.panel{padding:0 18px;background-color:white;overflow:hidden}
.footerss{font-size:xx-large}
@media only screen and (max-width:767px){.total_body{width:320px}.title{font-size:19px;margin:0}.footerss{font-size:15px}}
</style>
</head>
<body>
<div class="total_body">
  <div class="col-lg-12 title"><h1>${productTitle}</h1></div>
  <div class="col-lg-12 descriptions">
    <div class="col-xs-12 col-sm-6 col-md-6 col-lg-6">
      <div class="images"><img src="${productImageUrl}" style="max-width:100%;max-height:100%"></div>
    </div>
    <div class="col-xs-12 col-sm-6 col-md-6 col-lg-6">
      <div class="description">${productDescription}</div>
    </div>
  </div>
  <button class="accordion">Shipping</button>
  <div class="panel"><ul>${SHIPPING_INFO}</ul></div>
  <button class="accordion">Returns</button>
  <div class="panel"><ul>${RETURN_INFO}</ul></div>
  <button class="accordion">Payment</button>
  <div class="panel"><p>${PAYMENT_INFO}</p></div>
  <button class="accordion">Feedback</button>
  <div class="panel"><p>${FEEDBACK_INFO}</p></div>
  <button class="accordion">Contact Us</button>
  <div class="panel"><p>${CONTACT_INFO}</p></div>
  <div class="col-lg-12 title"><p><span class="footerss">${THANK_YOU}</span></p></div>
</div>
</body></html>`;
}

async function scrapeAmazonBullets(asin) {
  const page = await Pipeline.newPage();
  try {
    await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));
    return await page.evaluate(() => {
      const title = document.querySelector('#productTitle')?.textContent?.trim() || '';
      const bullets = [...document.querySelectorAll('#feature-bullets li span:not(.a-list-item ~ span)')].map(e => e.textContent.trim()).filter(Boolean);
      const img = document.querySelector('#landingImage')?.getAttribute('data-old-hires')
        || document.querySelector('#landingImage')?.src || '';
      return { title, bullets, img };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function callClaude(amazonTitle, bullets, apiKey) {
  const bulletText = bullets.length
    ? bullets.map(b => `• ${b}`).join('\n')
    : '(no bullet points available — use title only)';
  const prompt = `Product: ${amazonTitle}\n\nFeatures:\n${bulletText}\n\nWrite a compelling eBay listing description. Use plain text with line breaks — no HTML tags. Include: a short intro sentence, a Features section with bullet points (use • character), a Benefits section, and a closing "Why buy from us" line. Keep it under 300 words. No brand or company names.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

async function callClaudeTitle(ebayTitle, amazonTitle, bullets, apiKey) {
  const rawTitle = amazonTitle || ebayTitle;
  const bulletText = bullets.slice(0, 8).map(b => b.slice(0, 120)).join('. ') || rawTitle;

  const prompt = `You are an eBay SEO expert. Optimize this Amazon product title into a high-converting eBay search title.

STEP 1 — Strip: Remove brand names, model numbers, part numbers, and filler marketing words (e.g. "Premium", "Upgraded") that buyers never search for.
STEP 2 — Add: Pull the most buyer-searchable keywords from the features below and add them to reach as close to 80 characters as possible.

Rules:
- Max 80 characters (hard limit)
- No brand names
- No ALL CAPS words
- No special characters except hyphens
- Start with the most important product noun (e.g. "65W USB-C Laptop Charger" not "Charger USB-C 65W")

Raw title: ${rawTitle}
Product features: ${bulletText}

Output only the final optimized title, nothing else.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude title API ${res.status}`);
  const data = await res.json();
  return (data.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 80);
}

// Called from engine.js with pre-scraped data — returns plain text for typing into eBay's editor
async function fromData(ebayTitle, amazonTitle, bullets, imageUrl, apiKey) {
  return callClaude(amazonTitle || ebayTitle, bullets, apiKey);
}

async function titleFromData(ebayTitle, amazonTitle, bullets, apiKey) {
  return callClaudeTitle(ebayTitle, amazonTitle, bullets, apiKey);
}

const Generate = {
  fromData,
  titleFromData,

  // Legacy: scrapes Amazon itself (used by IPC batch handler)
  async forItem(item, apiKey) {
    if (!apiKey) throw new Error('No Anthropic API key set');
    if (!item.asin) throw new Error('No ASIN on item');
    const { title: amazonTitle, bullets, img: imageUrl } = await scrapeAmazonBullets(item.asin);
    if (!amazonTitle && !bullets.length) throw new Error('Could not scrape Amazon product data');
    const descHtml = await callClaude(amazonTitle || item.title, bullets, apiKey);
    return { html: buildTemplate(item.title, imageUrl, descHtml), imageUrl };
  },

  // Called via IPC 'list-generate' (batch mode, future use)
  async run(products, options, apiKey) {
    const results = [];
    for (const p of products) {
      try {
        const r = await this.forItem(p, apiKey);
        results.push({ id: p.id, success: true, ...r });
      } catch (e) {
        results.push({ id: p.id, success: false, error: e.message });
      }
    }
    return results;
  },
};

module.exports = Generate;
