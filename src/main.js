// src/main.js — zayndrop main process

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const Store = require('electron-store');
const DB = require('./shared/db');
const FillPipeline = require('./fill/pipeline');

const store = new Store();
const isDev = process.argv.includes('--dev');

// ── Auto-updater ───────────────────────────────────────────────
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null; // silence update logs

autoUpdater.on('update-downloaded', () => {
  const win = windows.home;
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-downloaded');
  }
});

autoUpdater.on('error', (err) => {
  console.log('[updater] error:', err?.message);
});

// ── Window registry ────────────────────────────────────────────
const windows = {};

function createWindow(name, options = {}) {
  if (windows[name] && !windows[name].isDestroyed()) {
    windows[name].focus();
    return windows[name];
  }

  const defaults = {
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0d0f',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#13151a',
      symbolColor: '#00d4aa',
      height: 36
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    show: false,
    ...options
  };

  const win = new BrowserWindow(defaults);
  windows[name] = win;

  win.loadFile(path.join(__dirname, `../windows/${name}.html`));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    if (isDev) win.webContents.openDevTools();
  });

  // Force show after 3 seconds if ready-to-show never fires
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
      win.focus();
    }
  }, 3000);

  win.on('closed', () => { delete windows[name]; });

  return win;
}

// ── App windows ────────────────────────────────────────────────
function openHome()   { createWindow('home',  { width: 520, height: 460, resizable: true }); }
function openScout()  { createWindow('scout', { width: 1300, height: 860, title: 'zayndrop Scout' }); }
function openList()   { createWindow('list',  { width: 1200, height: 800, title: 'zayndrop List' }); }
function openFill()   { createWindow('fill',  { width: 1200, height: 840, title: 'zayndrop Fill' }); }
function openDev()    { createWindow('dev',   { width: 1100, height: 800, title: 'zayndrop Dev Console' }); }

// ── Tray ───────────────────────────────────────────────────────
let tray = null;

function createTray() {
  try {
    const iconPath = path.join(__dirname, '../assets/tray.png');
    const icon = require('fs').existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
      : nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('zayndrop');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'zayndrop', enabled: false },
      { type: 'separator' },
      { label: 'Home',   click: openHome },
      { label: 'Scout',  click: openScout },
      { label: 'List',   click: openList },
      { label: 'Fill',   click: openFill },
      { label: 'Dev',    click: openDev },
      { type: 'separator' },
      { label: 'Quit zayndrop', click: () => app.quit() }
    ]));
    tray.on('double-click', openHome);
  } catch (err) {
    console.warn('[zayndrop] Tray creation failed:', err.message);
    // Continue without tray
  }
}

// ── App lifecycle ──────────────────────────────────────────────
app.whenReady().then(async () => {
  // Check for updates 5s after launch (not in dev mode)
  if (!isDev) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);

  try {
    // ── Migrate legacy data files to per-account structure ─────────
    const fs = require('fs');
    const userData = app.getPath('userData');
    const legacyDB  = path.join(userData, 'zayndrop-data.json');
    const acc1DB    = path.join(userData, 'zayndrop-data-acc1.json');
    if (fs.existsSync(legacyDB) && !fs.existsSync(acc1DB)) {
      fs.copyFileSync(legacyDB, acc1DB);
      console.log('[zayndrop] Migrated zayndrop-data.json → zayndrop-data-acc1.json');
    }
    const legacyProfile = path.join(userData, 'puppeteer-profile');
    const acc1Profile   = path.join(userData, 'profiles', 'acc1');
    fs.mkdirSync(path.join(userData, 'profiles'), { recursive: true });
    if (fs.existsSync(legacyProfile) && !fs.existsSync(acc1Profile)) {
      try {
        fs.renameSync(legacyProfile, acc1Profile);
        console.log('[zayndrop] Migrated puppeteer-profile → profiles/acc1');
      } catch (e) {
        // rename fails on Windows when a Chrome/Puppeteer process still has the folder open.
        // Create a junction (symlink equivalent on Windows) so both paths work,
        // or fall back to an empty dir if that also fails.
        console.warn('[zayndrop] rename failed — trying junction link');
        try {
          fs.symlinkSync(legacyProfile, acc1Profile, 'junction');
          console.log('[zayndrop] Created junction: profiles/acc1 → puppeteer-profile');
        } catch (_) {
          fs.mkdirSync(acc1Profile, { recursive: true });
          console.warn('[zayndrop] Junction failed — created empty acc1 profile (re-login required)');
        }
      }
    } else if (!fs.existsSync(acc1Profile)) {
      fs.mkdirSync(acc1Profile, { recursive: true });
    }

    // ── Seed default accounts (acc1 + acc2) ──────────────────────
    const acc2Profile = path.join(userData, 'profiles', 'acc2');
    fs.mkdirSync(acc2Profile, { recursive: true });

    let existingAccounts = store.get('accounts');
    if (!existingAccounts) {
      existingAccounts = [
        { id: 'acc1', name: 'Account 1', ebayUsername: store.get('ebayUsername') || '', amazonEmail: '', profileDir: path.join(userData, 'profiles', 'acc1'), active: true },
        { id: 'acc2', name: 'Account 2', ebayUsername: '', amazonEmail: '', profileDir: acc2Profile, active: true },
      ];
      store.set('accounts', existingAccounts);
    } else if (!existingAccounts.find(a => a.id === 'acc2')) {
      existingAccounts.push({ id: 'acc2', name: 'Account 2', ebayUsername: '', amazonEmail: '', profileDir: acc2Profile, active: true });
      store.set('accounts', existingAccounts);
    }

    await DB.init();
    createTray();
    openHome();
    startAutoTrackingSync();
  } catch (err) {
    console.error('[zayndrop] Startup error:', err);
    const { dialog } = require('electron');
    dialog.showErrorBox('zayndrop Startup Error', err.stack || err.message || String(err));
  }
});

// ── Auto tracking sync ─────────────────────────────────────────
let _autoSyncTimer = null;
const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function startAutoTrackingSync() {
  if (_autoSyncTimer) clearInterval(_autoSyncTimer);
  if (!store.get('autoSyncTracking')) return;
  _autoSyncTimer = setInterval(async () => {
    const fillWin = windows.fill;
    const emit = (event, data) => {
      if (fillWin && !fillWin.isDestroyed()) fillWin.webContents.send(event, data);
    };
    const accounts = store.get('accounts') || [{ id: 'acc1' }];
    for (const acc of accounts) {
      emit('scan-log', { type: 'heading', text: `⟳ Auto tracking sync — ${acc.name || acc.id}` });
      try {
        await FillPipeline.syncTrackingFromAmazon(emit, acc.id);
      } catch (e) {
        emit('scan-log', { type: 'error', text: `[${acc.id}] Auto sync error: ${e.message}` });
      }
    }
  }, AUTO_SYNC_INTERVAL_MS);
}

ipcMain.handle('fill-set-auto-sync', (_, { enabled }) => {
  store.set('autoSyncTracking', !!enabled);
  startAutoTrackingSync();
  return { enabled: !!enabled };
});
ipcMain.handle('fill-get-auto-sync', () => ({ enabled: !!store.get('autoSyncTracking') }));

// ── Verify shipped ─────────────────────────────────────────────
ipcMain.handle('fill-verify-shipped', async (_, opts = {}) => {
  const accountId = opts?.accountId || 'acc1';
  return FillPipeline.verifyShipped((event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) windows.fill.webContents.send(event, data);
  }, accountId);
});

app.on('window-all-closed', () => {
  // On Windows, keep running in tray when all windows closed
  // Don't call app.quit() here
});

app.on('before-quit', () => {
  const accounts = store.get('accounts') || [{ id: 'acc1' }];
  for (const acc of accounts) FillPipeline.stop(acc.id);
});

// ── IPC handlers ───────────────────────────────────────────────

// Settings
ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('save-settings', (_, settings) => { store.set(settings); return true; });
ipcMain.handle('get-setting', (_, key) => store.get(key));

// ── Account registry ───────────────────────────────────────────
ipcMain.handle('accounts-get', () => store.get('accounts') || []);
ipcMain.handle('accounts-save', (_, accounts) => { store.set('accounts', accounts); return true; });
ipcMain.handle('accounts-add', (_, acc) => {
  const accounts = store.get('accounts') || [];
  if (!acc.id) acc.id = 'acc' + (Date.now());
  if (!acc.profileDir) acc.profileDir = path.join(app.getPath('userData'), 'profiles', acc.id);
  // Ensure profile dir exists
  require('fs').mkdirSync(acc.profileDir, { recursive: true });
  accounts.push(acc);
  store.set('accounts', accounts);
  return acc;
});
ipcMain.handle('accounts-remove', (_, accountId) => {
  const accounts = (store.get('accounts') || []).filter(a => a.id !== accountId);
  store.set('accounts', accounts);
  return true;
});
ipcMain.handle('accounts-browser-status', () => {
  const Pipeline = require('./fill/pipeline');
  const accounts = store.get('accounts') || [];
  return accounts.map(a => ({ id: a.id, browserOpen: Pipeline.isBrowserOpen(a.id) }));
});

// Window navigation
ipcMain.handle('open-scout', openScout);
ipcMain.handle('open-list',  openList);
ipcMain.handle('open-fill',  openFill);
ipcMain.handle('open-home',  openHome);
ipcMain.handle('open-dev',   openDev);

// ── Sauce ──────────────────────────────────────────────────────
let sauceStopped = false;

function sauceEmit(type, text) {
  if (windows.dev && !windows.dev.isDestroyed()) windows.dev.webContents.send('sauce-log', { type, text });
}

async function sauceSelectAllAndAction(page, actionLabel, emit) {
  // Select all checkbox in Seller Hub table header
  await page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"][id*="select-all"], th input[type="checkbox"], .select-all-checkbox input');
    if (cb) cb.click();
  });
  await new Promise(r => setTimeout(r, 1000));

  const selected = await page.evaluate(() => {
    return [...document.querySelectorAll('input[type="checkbox"]:checked')].length;
  });
  if (!selected) return 0;
  emit('info', `  ✓ selected ${selected} listings`);

  // Click Actions dropdown
  const actionsBtn = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, span[role="button"]')]
      .find(e => /^actions$/i.test((e.textContent || '').trim()) && e.offsetParent);
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
    return false;
  });
  if (!actionsBtn) { emit('error', '  ✕ Actions button not found'); return 0; }
  await new Promise(r => setTimeout(r, 800));

  // Click the target action in the dropdown
  const clicked = await page.evaluate((label) => {
    const opt = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, a')]
      .find(e => e.offsetParent && new RegExp(label, 'i').test((e.textContent || '').trim()));
    if (opt) { opt.click(); return true; }
    return false;
  }, actionLabel);
  if (!clicked) { emit('error', `  ✕ "${actionLabel}" option not found in Actions menu`); return 0; }
  await new Promise(r => setTimeout(r, 1500));

  // Confirm modal if present
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(e => /confirm|yes|end|submit/i.test((e.textContent || '').trim()) && e.offsetParent);
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 2000));
  return selected;
}

ipcMain.handle('sauce-purge', async () => {
  sauceStopped = false;
  const Pipeline = require('./fill/pipeline');
  try {
    const page = await Pipeline.newPage();
    try {
      sauceEmit('info', '⌕ Loading Seller Hub active listings...');
      await page.goto('https://www.ebay.com/sh/lst/active?limit=200', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 3000));

      let totalEnded = 0;
      while (!sauceStopped) {
        const count = await page.evaluate(() => {
          return document.querySelectorAll('input[type="checkbox"][name*="item"], tbody input[type="checkbox"]').length;
        });
        if (!count) { sauceEmit('ok', `☠ No more active listings found.`); break; }

        const ended = await sauceSelectAllAndAction(page, 'End', sauceEmit);
        if (!ended) break;
        totalEnded += ended;
        sauceEmit('info', `  ↻ ${totalEnded} ended so far, reloading...`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));
      }
      return { success: true, ended: totalEnded };
    } finally { await page.close().catch(() => {}); }
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('sauce-relist', async (_, { delay = 1200 } = {}) => {
  sauceStopped = false;
  const Pipeline = require('./fill/pipeline');
  try {
    const page = await Pipeline.newPage();
    try {
      // Step 1: End all active listings
      sauceEmit('info', '⌕ Step 1/2 — ending all active listings...');
      await page.goto('https://www.ebay.com/sh/lst/active?limit=200', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 3000));

      let totalEnded = 0;
      while (!sauceStopped) {
        const count = await page.evaluate(() =>
          document.querySelectorAll('input[type="checkbox"][name*="item"], tbody input[type="checkbox"]').length);
        if (!count) break;
        const ended = await sauceSelectAllAndAction(page, 'End', sauceEmit);
        if (!ended) break;
        totalEnded += ended;
        sauceEmit('info', `  ${totalEnded} ended, reloading...`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));
      }
      sauceEmit('ok', `✓ ${totalEnded} listings ended. Starting relist...`);

      if (sauceStopped) return { success: false, error: 'stopped by user' };

      // Step 2: Relist from Ended listings
      sauceEmit('info', '⌕ Step 2/2 — relisting from Ended...');
      await page.goto('https://www.ebay.com/sh/lst/ended?limit=200', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 3000));

      let totalRelisted = 0;
      while (!sauceStopped) {
        const count = await page.evaluate(() =>
          document.querySelectorAll('input[type="checkbox"][name*="item"], tbody input[type="checkbox"]').length);
        if (!count) break;
        const relisted = await sauceSelectAllAndAction(page, 'Relist', sauceEmit);
        if (!relisted) break;
        totalRelisted += relisted;
        sauceEmit('info', `  ${totalRelisted} relisted, reloading...`);
        await new Promise(r => setTimeout(r, delay));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));
      }
      return { success: true, relisted: totalRelisted };
    } finally { await page.close().catch(() => {}); }
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('sauce-stop', () => { sauceStopped = true; return { success: true }; });

// DB
ipcMain.handle('updater-install', () => autoUpdater.quitAndInstall());
ipcMain.handle('updater-check',   () => autoUpdater.checkForUpdates().catch(() => {}));

ipcMain.handle('agent-get-log', () => {
  const logPath = path.join(app.getPath('userData'), 'agent-log.json');
  try { return JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { return []; }
});

ipcMain.handle('agent-get-status', () => {
  const statusPath = path.join(app.getPath('userData'), 'agent-status.json');
  try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { return null; }
});

ipcMain.handle('agent-run', (_, { hunt = false } = {}) => {
  const { spawn } = require('child_process');
  const scriptPath = path.join(__dirname, '..', 'walter.js');
  const args = [scriptPath];
  if (hunt) args.push('--hunt');
  const child = spawn(process.execPath, args, {
    detached: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  child.unref();
  return { started: true };
});

ipcMain.handle('open-digest', () => {
  const digestPath = path.join(app.getPath('userData'), 'daily-digest.html');
  if (fs.existsSync(digestPath)) shell.openPath(digestPath);
});

ipcMain.handle('open-agent', () => {
  if (windows.agent && !windows.agent.isDestroyed()) { windows.agent.focus(); return; }
  windows.agent = new BrowserWindow({
    width: 620, height: 560, minWidth: 500, minHeight: 400,
    backgroundColor: '#0c0d0f', title: 'ZaynDrop Agent',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  windows.agent.setMenuBarVisibility(false);
  windows.agent.loadFile(path.join(__dirname, '..', 'windows', 'agent.html'));
  windows.agent.on('closed', () => { windows.agent = null; });
});

ipcMain.handle('db-query', async (_, { sql, params }) => DB.query(sql, params));
ipcMain.handle('db-run',   async (_, { sql, params, accountId }) => DB.forAccount(accountId || 'acc1').run(sql, params));
ipcMain.handle('db-all',   async (_, { sql, params }) => DB.all(sql, params));
ipcMain.handle('db-get',   async (_, { sql, params }) => DB.get(sql, params));

// ── Fill pipeline IPC ──────────────────────────────────────────
ipcMain.handle('fill-start-scan', async (_, options) => {
  const accountId = options?.accountId || 'acc1';
  return FillPipeline.runScan(options, (event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) {
      windows.fill.webContents.send(event, data);
    }
  }, accountId);
});

ipcMain.handle('fill-ship-message', async (_, opts = {}) => {
  const accountId = opts?.accountId || 'acc1';
  return FillPipeline.runShipAndMessage((event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) {
      windows.fill.webContents.send(event, data);
    }
  }, accountId);
});

ipcMain.handle('fill-stop', (_, opts = {}) => {
  const accountId = opts?.accountId || 'acc1';
  stopFillAutomation();
  return FillPipeline.stop(accountId);
});

// ── Fill automation loop — runs the scan pipeline on a timer until stopped ──
let automationTimer = null;
let automationRunning = false;

function stopFillAutomation() {
  automationRunning = false;
  if (automationTimer) { clearTimeout(automationTimer); automationTimer = null; }
}

ipcMain.handle('fill-start-automation', async (_, options) => {
  if (automationRunning) return { success: true, already: true };
  automationRunning = true;
  const accountIds = options?.accountIds || [options?.accountId || 'acc1'];
  const emit = (event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) windows.fill.webContents.send(event, data);
  };
  const intervalMs = (options.intervalMinutes || 5) * 60000;

  const cycle = async () => {
    if (!automationRunning) return;
    for (const accountId of accountIds) {
      if (!automationRunning) break;
      emit('scan-log', { type: 'heading', text: `⬡ [${accountId}] Starting cycle...` });
      try {
        await FillPipeline.runScan({ ...options, accountId }, emit, accountId);
      } catch (e) {
        emit('scan-log', { type: 'error', text: `[${accountId}] Cycle failed: ${e.message}` });
      }
    }
    if (automationRunning) {
      emit('scan-log', { type: 'info', text: `⏱ next cycle in ${options.intervalMinutes || 5}m` });
      automationTimer = setTimeout(cycle, intervalMs);
    }
  };
  cycle();
  return { success: true };
});

ipcMain.handle('fill-stop-automation', () => {
  stopFillAutomation();
  const accounts = store.get('accounts') || [{ id: 'acc1' }];
  accounts.forEach(a => FillPipeline.stop(a.id));
  return { success: true };
});

ipcMain.handle('fill-automation-status', () => ({ running: automationRunning }));
ipcMain.handle('fill-open-browser',  (_, opts = {}) => FillPipeline.openForLogin(opts?.accountId || 'acc1'));
ipcMain.handle('fill-close-browser', (_, opts = {}) => FillPipeline.closeBrowser(opts?.accountId || 'acc1'));
ipcMain.handle('fill-check-login',   (_, opts = {}) => FillPipeline.checkLoginStatus(opts?.accountId || 'acc1'));

ipcMain.handle('fill-get-orders', (_, opts = {}) => DB.forAccount(opts?.accountId || 'acc1').getOrders());

ipcMain.handle('fill-update-order', async (_, { id, patch, accountId }) => {
  const db = DB.forAccount(accountId || 'acc1');
  const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(patch), id];
  return db.run(`UPDATE orders SET ${sets}, updated_at = datetime('now') WHERE id = ?`, vals);
});

ipcMain.handle('fill-sync-orders', async (_, opts = {}) => {
  const accountId = opts?.accountId || 'acc1';
  return FillPipeline.syncOrders((event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) windows.fill.webContents.send(event, data);
  }, accountId);
});
ipcMain.handle('fill-auto-map-asins', async (_, opts = {}) => {
  const accountId = opts?.accountId || 'acc1';
  return FillPipeline.autoMapAsins((event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) {
      windows.fill.webContents.send(event, data);
    }
  }, accountId);
});
ipcMain.handle('fill-get-asin-map',    (_, opts = {}) => DB.forAccount(opts?.accountId || 'acc1').getAsinMap());
ipcMain.handle('fill-map-asin', (_, { listingId, asin, title, source, aliItemId, accountId }) => {
  DB.forAccount(accountId || 'acc1').mapAsin(listingId, asin, title, { source: source || 'amazon', ali_item_id: aliItemId || null });
  return true;
});
ipcMain.handle('fill-delete-asin-map', (_, { listingId, accountId })              => DB.forAccount(accountId || 'acc1').run('DELETE FROM asin_map WHERE listing_id = ?', [listingId]));

ipcMain.handle('fill-fulfill-single', async (_, { orderId, accountId } = {}) => {
  const acct = accountId || 'acc1';
  const db = DB.forAccount(acct);
  const order = db.getOrders().find(o => o.order_id === orderId);
  if (!order) return { success: false, error: 'Order not found' };

  // Guard: already ordered/shipped in DB
  if (order.amazon_order_id) return { success: false, error: `Already ordered — Amazon #${order.amazon_order_id}` };
  if (order.tracking_number) return { success: false, error: `Already shipped — tracking: ${order.tracking_number}` };

  const asinMap = db.getAsinMap();
  const entry = asinMap.find(m => m.listing_id === (order.item_id || order.listing_id));

  if (entry?.source === 'aliexpress' && entry?.ali_item_id) {
    return FillPipeline.fulfillOrderAliExpress(order, entry.ali_item_id, acct);
  }

  const asin = entry?.asin || order.asin;
  if (!asin) return { success: false, error: `No ASIN mapped for listing ${order.item_id || order.listing_id}` };

  // Live Amazon duplicate check before placing
  const dupCheck = await FillPipeline.checkAmazonDuplicate(order, asin, acct);
  if (dupCheck.isDuplicate) {
    if (dupCheck.existingOrderId) db.updateOrder(order.order_id, { amazon_order_id: dupCheck.existingOrderId, fulfill_status: 'ordered' });
    return { success: false, error: `Already ordered on Amazon${dupCheck.existingOrderId ? ` (#${dupCheck.existingOrderId})` : ''} — DB updated` };
  }

  return FillPipeline.fulfillOrder(order, asin, acct);
});

ipcMain.handle('fill-sync-tracking-aliexpress', async (_, opts = {}) => {
  const acct = opts?.accountId || 'acc1';
  const emit = (event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) windows.fill.webContents.send(event, data);
  };
  return FillPipeline.syncTrackingFromAliExpress(emit, acct);
});

ipcMain.handle('fill-sync-tracking', async (_, opts = {}) => {
  const acct = opts?.accountId || 'acc1';
  const emit = (event, data) => {
    if (windows.fill && !windows.fill.isDestroyed()) windows.fill.webContents.send(event, data);
  };
  return FillPipeline.syncTrackingFromAmazon(emit, acct);
});

ipcMain.handle('fill-save-tracking', async (_, { orderId, trackingNumber, carrier, accountId }) => {
  const db = DB.forAccount(accountId || 'acc1');
  await db.run(
    `UPDATE orders SET tracking_number = ?, carrier = ?, fulfill_status = 'shipped', updated_at = datetime('now') WHERE order_id = ?`,
    [trackingNumber, carrier, orderId]
  );
  return true;
});

// ── List pipeline IPC ──────────────────────────────────────────
const listEmit = (event, data) => {
  if (windows.list && !windows.list.isDestroyed()) windows.list.webContents.send(event, data);
};
ipcMain.handle('list-queue',        (_, opts = {}) => DB.forAccount(opts?.accountId || 'acc1').getQueue());
ipcMain.handle('list-add-items',    (_, items) => {
  let added = 0, banked = 0;
  for (const it of items) {
    const r = DB.addToQueue(it);
    if (r && r.skipped) banked++; else added++;
  }
  return { added, banked };
});
ipcMain.handle('list-update-item',  (_, { id, patch }) => { DB.updateQueueItem(id, patch); return true; });
ipcMain.handle('list-remove-items', (_, ids)  => { DB.removeQueueItems(ids); return true; });
ipcMain.handle('list-mark-posted',  (_, ids)  => {
  for (const id of ids) {
    const item = DB.getQueue().find(q => q.id === id);
    if (item) {
      DB.updateQueueItem(id, { status: 'posted' });
      DB.addToBank(item);
    }
  }
  return true;
});
ipcMain.handle('list-match-asins',  async (_, ids, opts = {}) => {
  const accountId = (Array.isArray(ids) ? opts?.accountId : ids?.accountId) || 'acc1';
  const realIds = Array.isArray(ids) ? ids : ids?.ids || [];
  const Engine = require('./list/engine');
  return Engine.matchAsins(realIds, (p) => listEmit('list-progress', p), accountId);
});
ipcMain.handle('list-price-items',  async (_, payload) => {
  const accountId = payload?.accountId || 'acc1';
  const Engine = require('./list/engine');
  return Engine.priceItems(payload.ids, payload.options, (p) => listEmit('list-progress', p), accountId);
});
ipcMain.handle('list-stop', () => { const Engine = require('./list/engine'); return Engine.stop(); });
ipcMain.handle('list-test-title', async () => {
  const Store = require('electron-store');
  const apiKey = new Store().get('anthropicKey');
  if (!apiKey) return { ok: false, error: 'No Anthropic API key set in Settings' };
  try {
    const Generate = require('./list/generate');
    const title = await Generate.titleFromData(
      '65W USB-C Laptop Charger Fast Charging Power Adapter',
      'VJYUIJAY 65W USB Type-C Laptop Charger Compatible with HP Dell Lenovo',
      ['65W fast charging', 'USB-C PD', 'Compatible with HP, Dell, Lenovo, Acer', 'Foldable plug', 'LED indicator'],
      apiKey
    );
    return { ok: true, title, keyPrefix: apiKey.slice(0, 8) + '...' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('list-refresh', async (_, payload) => {
  const Engine = require('./list/engine');
  const { days = 30, limit = 10, accountId = 'acc1' } = payload || {};
  return Engine.refreshListings({ days, limit }, (p) => listEmit('list-progress', p), accountId);
});
ipcMain.handle('list-auto-run', async (_, payload) => {
  const accountId = payload?.accountId || 'acc1';
  const Engine = require('./list/engine');
  return Engine.autoRun(payload.ids, payload.options, (p) => listEmit('list-progress', p), accountId);
});
ipcMain.handle('list-verify-item',  async (_, id) => {
  const Engine = require('./list/engine');
  return Engine.verifyListing(id, (p) => listEmit('list-progress', p));
});
ipcMain.handle('list-post-items',   async (_, payload) => {
  const Engine = require('./list/engine');
  const ids = Array.isArray(payload) ? payload : payload.ids;
  const options = Array.isArray(payload) ? {} : (payload.options || {});
  const accountId = Array.isArray(payload) ? 'acc1' : (payload.accountId || 'acc1');
  return Engine.postItems(ids, options, (p) => listEmit('list-progress', p), accountId);
});
ipcMain.handle('list-get-queue',   () => DB.all('SELECT * FROM queue ORDER BY created_at DESC'));
ipcMain.handle('list-get-history', () => DB.all('SELECT * FROM history ORDER BY created_at DESC'));

ipcMain.handle('list-add-to-queue', async (_, product) => {
  return DB.run(
    `INSERT INTO queue (asin, title, ebay_title, amazon_title, amazon_price, ebay_lowest_price, estimated_profit, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
    [product.asin, product.title, product.ebayTitle, product.amazonTitle,
     product.amazonPrice, product.ebayLowestPrice, product.estimatedProfit]
  );
});

ipcMain.handle('list-clear-queue', () => DB.run('DELETE FROM queue'));

ipcMain.handle('list-save-to-history', async (_, listing) => {
  return DB.run(
    `INSERT INTO history (asin, title, our_price, ebay_lowest_price, amazon_price, description, ebay_item_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [listing.asin, listing.title, listing.ourPrice, listing.ebayLowestPrice,
     listing.amazonPrice, listing.description, listing.ebayItemId]
  );
});

ipcMain.handle('list-generate', async (_, { products, options }) => {
  const Generate = require('./list/generate');
  return Generate.run(products, options, store.get('anthropicKey'));
});

ipcMain.handle('list-fetch-ebay-prices', async (_, { products }) => {
  const EbayFetch = require('./list/ebay-fetch');
  return EbayFetch.fetchAll(products, (progress) => {
    if (windows.list && !windows.list.isDestroyed()) {
      windows.list.webContents.send('fetch-progress', progress);
    }
  });
});

// ── Scout IPC ──────────────────────────────────────────────────
ipcMain.handle('scout-hunt', async (_, { keywords, options }) => {
  const Scout = require('./scout/hunt');
  return Scout.hunt(keywords, options, (progress) => {
    if (windows.scout && !windows.scout.isDestroyed()) {
      windows.scout.webContents.send('hunt-progress', progress);
    }
  });
});

ipcMain.handle('radar-run', async (_, opts) => {
  const Radar = require('./scout/radar');
  return Radar.run(opts, (p) => {
    if (windows.scout && !windows.scout.isDestroyed()) {
      windows.scout.webContents.send('hunt-progress', p);
    }
  });
});
ipcMain.handle('radar-keywords', async (_, { keywords }) => {
  const Radar = require('./scout/radar');
  return Radar.keywordRadar(keywords, (p) => {
    if (windows.scout && !windows.scout.isDestroyed()) {
      windows.scout.webContents.send('hunt-progress', p);
    }
  });
});
ipcMain.handle('radar-random-niches', (_, count) => {
  const Radar = require('./scout/radar');
  return Radar.randomNicheKeywords(count || 6);
});
ipcMain.handle('scout-save-results', (_, payload) => { DB.saveScoutResults(payload); return true; });
ipcMain.handle('scout-load-results', ()            => DB.getScoutResults());

// Competitor tab
ipcMain.handle('comp-overlay-start', async (_, opts) => {
  const Overlay = require('./scout/overlay');
  return Overlay.start(opts, (seller) => {
    if (windows.scout && !windows.scout.isDestroyed()) {
      windows.scout.webContents.send('comp-updated', { seller });
    }
  });
});
ipcMain.handle('comp-overlay-stop', () => { const Overlay = require('./scout/overlay'); return Overlay.stop(); });
ipcMain.handle('comp-set-params',   (_, opts) => { const Overlay = require('./scout/overlay'); Overlay.setParams(opts); return true; });
ipcMain.handle('comp-pull', async (_, { seller, options }) => {
  const dbg = require('./shared/debug-log');
  // #region agent log
  dbg({ runId: 'post-fix', hypothesisId: 'E', location: 'main.js:comp-pull:entry', message: 'comp-pull IPC', data: { seller, options } });
  // #endregion
  const Radar = require('./scout/radar');
  const res = await Radar.pullCompetitor(seller, options, (p) => {
    if (windows.scout && !windows.scout.isDestroyed()) {
      windows.scout.webContents.send('hunt-progress', p);
    }
  });
  // #region agent log
  dbg({ runId: 'post-fix', hypothesisId: 'E', location: 'main.js:comp-pull:exit', message: 'comp-pull done', data: { seller, success: res.success, captcha: res.captcha, productCount: res.products?.length, raw: res.raw } });
  // #endregion
  if (res.success) DB.saveCompetitorProducts(seller, res.products);
  return res;
});
ipcMain.handle('comp-get-products',    ()            => DB.getCompetitorProducts());
ipcMain.handle('comp-delete-seller',   (_, seller)   => { DB.deleteCompetitorProducts(seller); return true; });

ipcMain.handle('radar-get-sellers',  ()           => store.get('radarSellers') || []);
ipcMain.handle('radar-save-sellers', (_, sellers) => { store.set('radarSellers', sellers); return true; });

ipcMain.handle('scout-analyze', async (_, { products }) => {
  const Analyze = require('./scout/analyze');
  return Analyze.run(products, store.get('anthropicKey'));
});

ipcMain.handle('scout-get-saved',    () => DB.all('SELECT * FROM saved_products ORDER BY created_at DESC'));
ipcMain.handle('scout-save-product', async (_, p) => {
  return DB.run(
    `INSERT OR IGNORE INTO saved_products (asin, title, price, sold_count, score, source, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [p.asin, p.title, p.price, p.soldCount, p.score?.total, p.source, p.url]
  );
});
ipcMain.handle('scout-send-to-list', async (_, products) => {
  for (const p of products) {
    await DB.run(
      `INSERT INTO queue (asin, title, amazon_price, status, created_at) VALUES (?, ?, ?, 'pending', datetime('now'))`,
      [p.asin, p.title, p.price]
    );
  }
  return { success: true, count: products.length };
});
