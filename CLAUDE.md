# ZaynDrop — Project Context for Claude Code
# Read this at the start of every session

## Who I am
Zayn — eBay-to-Amazon dropshipper, multiple eBay accounts, selling 65W USB-C laptop chargers
and other products sourced from Amazon. Windows user, work computer has IT restrictions.

## What we've built
Three Chrome extensions + one Electron desktop app:

### 1. DropFlow (ebay-extension/)
eBay listing automator. Retro lime-green popup (▲ logo, DM Mono font, #c8f04a accent).
- Queue tab: add ASINs manually, bulk import ZIK Analytics CSV, auto-fetch eBay prices
- Generate tab: Claude API (needs anthropic-dangerous-direct-browser-access header) generates titles/descriptions
- Accounts tab: multi-account posting, post queue, bulk reprice
- Monitor tab: price monitoring, auto-reprice, stock check
- Templates tab: per-category Claude prompts
- History tab: saved listings, CSV export
- Full dashboard opens in separate Chrome tab via ⬡ button
- ZIK CSV format: ASIN, eBay title, Amazon title, eBay price, Amazon price
- bulk-import.js detects ZIK format, passes force=true to addToQueue (bypasses dedup)
- Per-item render callback so products appear one by one during import

### 2. FlowScout (flowscout/)
Product research tool. Amber terminal aesthetic (Space Mono, #f0a832 accent).
- Hunt tab: keyword search, eBay+Amazon background scraping, sortable results table
- Niche Radar: scans 8 niches, ranks by avg opportunity score
- AI Picks: sends top 30 to Claude, returns STRONG BUY/BUY/WATCH/SKIP with reasoning
- Sniper: monitors keywords, alerts on high-score or underpriced listings
- Saved tab, Log tab
- VeRO filter (vero-filter.js): ~150 protected brands filtered from all results
- Hunt.run() uses bg-scrape via background.js which opens background tabs
- All results go through Scorer.scoreAll() — 0-100 score
- → DropFlow button sends products to dropflow_queue in chrome.storage

### 3. FlowFill (flowfill/)
Order fulfillment. Teal aesthetic (#00d4aa accent, IBM Plex Mono).
- Mini popup with Address Bridge (📋 COPY from eBay / 📌 PASTE to Amazon)
- Full dashboard opens in Chrome tab
- Scrapes eBay Seller Hub orders: tr.order-info.orderid_XX-XXXXX-XXXXX rows
- eBay order detail is in iframe (mesh.ebay.com) — scraper uses all_frames:true
- Address Bridge: stores buyer data in DB.get('clipboardBuyer'), fills Amazon address form
- Full scan pipeline (7 steps): scrape eBay → scrape Amazon → match → fulfill → track → mark shipped → message buyers
- Amazon pagination: startIndex=0,10,20... (/your-orders/orders?startIndex=N)
- eBay filter URLs:
  - All: https://www.ebay.com/sh/ord/?filter=status:ALL_ORDERS
  - Awaiting shipment: https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT
  - Awaiting payment: https://www.ebay.com/sh/ord/?filter=status:AWAITING_PAYMENT
  - Paid & shipped: https://www.ebay.com/sh/ord/?filter=status:PAID_SHIPPED
- Buyer message template with {{buyerName}} {{itemTitle}} {{trackingNumber}} {{carrier}} {{trackingUrl}} variables
- CORS fix: all Anthropic API calls need 'anthropic-dangerous-direct-browser-access': 'true' header

### 4. ZaynDrop (zayndrop/)
Electron desktop app — replaces all three extensions long term.
- Separate windows: Home (launcher), Fill (working), Scout (fully built), List (fully built)
- Pure JSON database (no SQLite — avoids native compilation on Windows)
- Puppeteer for browser automation — reads iframes natively, no extension restrictions
- Fill pipeline mirrors FlowFill's 7 steps but using Puppeteer
- Puppeteer uses its OWN profile dir (userData/puppeteer-profile) — NOT Chrome's profile
- Work computer has IT restrictions blocking Puppeteer — needs personal machine to test
- Node v22 required (v24 breaks Electron)
- Setup: cd zayndrop && npm install && npm start

## Current status (as of 2026-06-26)
- All 3 extensions working, installed in Chrome
- zayndrop v2.1+ fully operational: Home, Fill, Scout, List, Walter all working
- Fill pipeline: verified live end-to-end multiple sessions
- Scout: fully built — Hunt, Market Radar, Keyword Hunter, Competitors tab (with overlay), AI Picks
- List: fully built — ASIN match, pricing, eBay prelist wizard with photos/specifics, auto-submit, verify
- Walter (AI agent): fully built and scheduled — see Walter section below
- Desktop shortcut launches app. Run scripts in repo root: walter.js, fulfill-run.js, run-ship-message.js, verify-orders.js, debug-*.js
- Active ASIN map: 30 eBay listings mapped to Amazon ASINs (not just 2 — the store is diverse)
- Product range is broad: laptop chargers, Roku remotes, garden tools, vitamin supplements,
  kitchen supplies, outdoor gear, phone accessories, irrigation parts, and more
- Key recurring ASINs in asin_map (as of 2026-06-26):
  - B0F4J6PQ3L — VJYUIJAY 65W USB-C Laptop Charger (listing 406967786269)
  - B0DLSRTWN2 — Gotellx 2-Pack Roku Remote (multiple listings: 406967786735, 406970325885, etc.)
  - B09VS7XF7R — Dzytnsy 65W USB C Laptop Charger (listing 406917717922)
  - B0CKMJ2Z8M — Mason Jar Lids (older listing, may be inactive)
  - Many others across garden, health, kitchen, outdoor categories
- Queue: 1,316 items total — 497 pending, 452 drafted, 314 ready, 41 no_match, 8 post_error, 4 posted
- Orders: 136 total — 61 shipped, 44 ordered, 28 pending, 3 unset
- NOTE: The "bank" feature (DB.bank) is not currently in use — bank array is empty/undefined

## Fill pipeline notes (hard-won, 2026-06)
- Puppeteer uses its own profile (userData/puppeteer-profile), NOT Chrome's — Chrome
  locks its profile while running. Cookie copying doesn't work (Windows DPAPI encryption);
  log in once via Login Setup button, sessions persist. Lock files (SingletonLock etc.)
  are cleared on each launch.
- eBay "Ship to" block puts city / "," / state / zip on SEPARATE lines — parser in
  scrapeOrderAddress handles this; debug dumps go to userData/address-debug.txt
- Amazon checkout ("Chewbacca" pipeline) is a multi-step wizard that resumes at a random
  step (pay/address/review). fulfillOrder runs a state machine: detect page → act → loop.
- Amazon address form: state field is a hidden native <select>
  (#address-ui-widgets-enterAddressStateOrRegion-dropdown-nativeId) — set value directly
  + dispatch change. Submit is span#checkout-primary-continue-button-id > input[type=submit]
  (no text label). Don't click the fake a-dropdown UI (first one is the Country dropdown).
- Safety guard: Place Order is only clicked if buyer name AND zip are on the review page.
- Failed checkout attempts dump to userData/checkout-debug.txt
- Real Amazon order IDs are 112-... (from order history), NOT 106-... (purchase session IDs
  on thank-you page). Always scrape real IDs from order history.
- Must use page.mouse.click() at bounding box coordinates, not element.click() — eBay/Amazon
  silently swallow .click() calls.
- double-purchase guard: upsertOrder never overwrites pipeline state; fulfill skips orders
  with amazon_order_id/tracking/message_sent. Only awaiting_ship status imports as 'pending'.
- debug-checkout.js / debug-form-probe.js in repo root: standalone checkout debuggers
  (stop before placing order)
- Ship+Message uses eBay awaiting-shipment list as ground truth (not DB status alone)

## Scout notes (hard-won, 2026-06)
- VeRO filter: 5,831 brands from EcomSniper's VeroListNew.txt (assets/vero.txt)
- Competitor username resolution: store display names → visit /str/slug → extract real
  username from /usr/ links. pullCompetitor auto-retries once after resolving display name.
- Overlay: floating amber panel injected into eBay pages via Puppeteer. Detects seller via
  URL _ssn → /usr/ links → /str/ slug → feedback_profile → seller card (priority order).
  PULL PRODUCTS button triggers comp-pull IPC.
- AI Picks uses claude-sonnet-4-6, sends top 40 with full demand context (sold30d, sold7d,
  margin, signalSource). Competitor products have strongest signal: "competitor:<seller>".
- Results persist in DB (saveScoutResults/getScoutResults) on every run.
- Keyword Hunter: probes both markets per keyword, 96 niche files in assets/product_ideas,
  🎲 dice picks random keywords from niche files.

## List notes (hard-won, 2026-06)
- eBay prelist wizard state machine: category page ("Provide a category") → condition →
  listing form. States handled in postItems loop in src/list/engine.js.
- Category picker: finds elements with " > " in text (path format), clicks first, then Done.
- Condition picker: tries radio inputs first (first line of label text), then visible
  clickables. Matches "new", "new with tags", "brand new" etc. (first line only — eBay
  condition options have multi-line text with title + description).
- Amazon photos: extract hiRes URLs via regex on /dp/ page HTML, download to temp
  (os.tmpdir()/zayndrop-imgs/<asin>/), upload via fileInput.uploadFile().
- Item specifics: "Apply all" button → "Suggested: X" links → Unbranded for empty Brand
  selects → combobox type-and-pick for required fields from error banner.
- Combobox pattern: find label → walk up DOM (5 levels) → find trigger button/[role=combobox]
  → click → type → pick from [role=listbox] [role=option]. Dumps HTML to post-debug.txt if
  opener fails. Hair clips category still has Brand/Color combobox issue — check post-debug.txt.
- Auto-submit (default ON in UI): clicks "List it", waits 24s for thank-you page, captures
  eBay item id. Items with required-field errors stay as 'drafted'.
- ■ STOP button: sets stopped=true flag in engine.js, checked between items in postItems.
- ^ verify button (drafted/posted rows): searches own eBay store by title, reports:
    ✓ LIVE & unique (1 match), ✕ NOT LISTED (0 matches), ✕ NOT FOUND (item ID missing),
    ⚠ DUPLICATES (2+ matches). Always shows a toast — never silent. Also logs to List Log.
- Pricing: undercutCents (default 5¢) below lowest eBay price; min price floor = (cost + profitFloor) / 0.87
- ASIN matching: up to 6 Amazon candidates, cheapest auto-selected, review modal for manual pick.
- zayndrop-data.json must be written WITHOUT BOM — PowerShell Set-Content adds BOM;
  use Node.js to read/write if editing manually.

## Key technical decisions
- Manifest V3 — no inline scripts in HTML, all JS in external files
- chrome.storage.local for all extension data
- DB.addToQueue(product, force=true) bypasses ASIN dedup on bulk imports
- VeRO filtering applied before scoring in FlowScout
- ZaynDrop uses electron-store for settings, JSON file for database
- Puppeteer uses its OWN profile dir (userData/puppeteer-profile) — sharing Chrome's
  User Data folder fails when Chrome is running (profile lock)
- All mouse interactions via page.mouse.click() at bounding box coords (not element.click())

## Folder structure
zayndrop/
  src/
    main.js            — Electron main process, all IPC handlers
    preload.js         — Secure bridge, exposes window.zayn API
    shared/db.js       — JSON file database
    fill/pipeline.js   — Puppeteer fulfillment engine (7-step pipeline)
    scout/
      hunt.js          — Amazon search scraper, VeRO filter, 0-100 scoring
      radar.js         — Competitor scans, Movers & Shakers, keyword radar
      analyze.js       — Claude AI Picks (claude-sonnet-4-6)
      overlay.js       — Floating overlay injected into Puppeteer eBay pages
      vero.js          — VeRO brand filter (5,831 brands)
    list/
      engine.js        — ASIN match, pricing, eBay prelist wizard, verify
  windows/
    home.html          — Launcher hub (includes Walter status panel)
    fill.html          — Order fulfillment dashboard
    scout.html         — Hunt / Competitors tabs
    list.html          — Queue, ASIN match, pricing, post, verify
    agent.html         — Walter dedicated window (live log, stats, run controls)
  assets/
    vero.txt           — 5,831 VeRO brands
    product_ideas/     — 96 niche keyword files for Keyword Hunter
  package.json         — electron@31, puppeteer@21, electron-store@8, nodemailer
  walter.js            — Walter autonomous agent (see Walter section)
  test-post.js         — Standalone eBay listing post tester (no auto-submit)
  fulfill-run.js       — Standalone fulfill runner
  run-ship-message.js  — Standalone ship+message runner
  verify-orders.js     — Standalone order verifier
  debug-checkout.js    — Amazon checkout debugger (stops before Place Order)
  debug-form-probe.js  — Amazon form field probe

## Walter — autonomous business intelligence agent (built 2026-06-26)
Walter is a standalone Node.js agent (walter.js) that runs on a schedule and acts as an
autonomous employee watching the business. NOT part of the Electron process — runs separately.

### What Walter does
- Reads zayndrop-data-acc1.json directly (no Electron needed)
- Builds daily business context: yesterday's orders, profit, pending count, asin_map count, queue
- NOTE: Walter currently counts "active listings" from db.bank which is unused — shows 0.
  True listing count is db.asin_map.length (30). Walter should be updated to read asin_map.
- Calls Claude (claude-sonnet-4-6) to generate a business digest: key numbers, patterns, today's priority
- Runs AI Picks on saved scout results (or fresh Amazon hunt with --hunt flag)
- Saves HTML digest to userData/daily-digest.html
- Sends email digest via Gmail (requires ZAYN_EMAIL_PASS env var — Gmail App Password)
- Shows Windows balloon notification on completion or failure
- Writes live status to userData/agent-status.json (UI polls this for real-time log)
- Logs each run to userData/agent-log.json (30-run history)

### Running Walter
- Manual: `node walter.js`
- Fresh Amazon hunt: `node walter.js --hunt`
- From app: Home screen ▶ Run button, or open Walter window (↗ Open) and click ▶ Run / ⬡ Hunt

### Windows Task Scheduler (auto runs)
- "ZaynDrop Walter" — daily at 7AM (standard run, saved scout results)
- "ZaynDrop Walter Hunt" — Sunday 6AM (fresh Puppeteer Amazon scrape, updates DB)

### Walter UI in the app
- Home screen: pulsing dot (grey=idle, teal pulse=running, solid teal=done, red=error),
  last run stats (fulfilled/profit/pending/scouted), ▶ Run + ↗ Open buttons
- windows/agent.html: dedicated Walter window — live scrolling log, 4 stat boxes,
  ▶ Run / ⬡ Hunt / ↗ Digest buttons, run history view

### IPC handlers (main.js)
- agent-get-log: reads agent-log.json
- agent-get-status: reads agent-status.json (live during run)
- agent-run: spawns walter.js as detached child process (supports { hunt: true })
- open-digest: shell.openPath(daily-digest.html)
- open-agent: opens windows/agent.html in new BrowserWindow

### Walter hunt keywords (top of walter.js, edit freely)
- '65w usb c laptop charger', 'roku remote replacement',
  'usb c charger 65w pd', 'laptop charger fast charge'

### Email setup
Set Windows env var ZAYN_EMAIL_PASS to a Gmail App Password (16 chars).
Get one: myaccount.google.com → Security → 2-Step Verification → App passwords → "Walter"
Without this, digest saves to file only (no email sent — non-fatal).

### userData files written by Walter
- agent-status.json — live run state: { running, started_at, finished_at, error, lines[] }
- agent-log.json    — run history (last 30 runs)
- daily-digest.html — latest HTML digest (open in any browser)

## Built and verified (2026-06-10/11/12)
- Fill: full pipeline live-verified — fulfill (with quantity), tracking pull, ship,
  message. Ship+Message uses eBay awaiting-shipment list as ground truth.
  ASIN auto-map (buyer-name matching). Double-purchase + double-message guards.
- Scout: Hunt (Amazon search + filters + VeRO 5,831 brands), Market Radar
  (competitor sold scans + Movers & Shakers + eBay velocity), Keyword Hunter
  (both-markets demand probe, 96 niche files in assets/product_ideas),
  Competitors tab (seller watchlist, in-browser overlay with PULL PRODUCTS,
  username auto-resolution from store slugs), AI Picks (claude-sonnet-4-6),
  results persist in DB.
- List: queue from Scout multi-select, bulk ASIN match (cheapest candidates +
  review modal), bulk pricing (undercut cents + $2-after-fees profit floor),
  POST drives eBay prelist wizard (state machine: category page → condition →
  form), uploads Amazon hi-res photos, fills price + item specifics (Apply all /
  Suggested links / Unbranded / combobox type-and-pick). Auto-submit toggle in
  UI (default ON): clicks "List it", verifies live, captures eBay item id;
  blocked-required-fields items stay drafted. ■ STOP button for bulk runs.
  ^ verify button on drafted/posted rows. Verified live 2026-06-11.
- Desktop shortcut launches app (electron.exe).

## Known issues / pending fixes
- Hair clips category: Brand/Color combobox fields still failing — post-debug.txt dump
  triggered on failure for diagnosis. Needs fix to combobox opener in engine.js.

## What to build next
1. Fix Brand/Color combobox for categories that require it (read post-debug.txt)
2. Claude-generated titles/descriptions for listings (DropFlow Generate port)
3. Walter learning memory layer — observation logger + weekly pattern extractor so
   Walter's recommendations get smarter over time based on actual sales data
4. Multi-account support
5. Auto-update system, package as .exe installer

## Anthropic API
- Model: claude-sonnet-4-6 (claude-sonnet-4-20250514 was removed from the API — 404s as of 2026-06)
- All browser calls need: 'anthropic-dangerous-direct-browser-access': 'true'
- Key stored in electron-store as 'anthropicKey'

## Notes
- Never store passwords or API keys in code or chat
- eBay uses tr.order-info rows, item titles in .item-title elements
- Amazon order cards: .order-card.js-order-card, ASINs in /dp/ links
- Word overlap matching (>0.45 threshold) used for eBay→Amazon order matching
- ZaynDrop sessions persist in Chrome profile — login once, stays logged in
- Pricing formula: undercutCents below eBay lowest; floor = (amazonCost + profitFloor) / 0.87
