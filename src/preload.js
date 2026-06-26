// src/preload.js — secure IPC bridge

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zayn', {
  // Settings
  getSettings:  ()         => ipcRenderer.invoke('get-settings'),
  saveSetting:  (k, v)     => ipcRenderer.invoke('save-settings', { [k]: v }),
  getSetting:   (k)        => ipcRenderer.invoke('get-setting', k),

  // Navigation
  openScout: () => ipcRenderer.invoke('open-scout'),
  openList:  () => ipcRenderer.invoke('open-list'),
  openFill:  () => ipcRenderer.invoke('open-fill'),
  openHome:  () => ipcRenderer.invoke('open-home'),
  openDev:   () => ipcRenderer.invoke('open-dev'),

  // Fill
  fillStartScan:    (opts)          => ipcRenderer.invoke('fill-start-scan', opts),
  fillStop:         ()              => ipcRenderer.invoke('fill-stop'),
  fillShipMessage:  ()              => ipcRenderer.invoke('fill-ship-message'),
  fillStartAutomation:  (opts)      => ipcRenderer.invoke('fill-start-automation', opts),
  fillStopAutomation:   ()          => ipcRenderer.invoke('fill-stop-automation'),
  fillAutomationStatus: ()          => ipcRenderer.invoke('fill-automation-status'),
  fillOpenBrowser:  ()              => ipcRenderer.invoke('fill-open-browser'),
  fillCloseBrowser: ()              => ipcRenderer.invoke('fill-close-browser'),
  fillCheckLogin:   ()              => ipcRenderer.invoke('fill-check-login'),
  fillGetOrders:    ()              => ipcRenderer.invoke('fill-get-orders'),
  fillUpdateOrder:  (id, patch, accountId) => ipcRenderer.invoke('fill-update-order', { id, patch, accountId }),
  fillSaveTracking: (o)             => ipcRenderer.invoke('fill-save-tracking', o),
  fillGetAsinMap:    ()              => ipcRenderer.invoke('fill-get-asin-map'),
  fillSyncOrders:    (o)             => ipcRenderer.invoke('fill-sync-orders', o),
  fillAutoMapAsins:  ()              => ipcRenderer.invoke('fill-auto-map-asins'),
  fillMapAsin:       (o)            => ipcRenderer.invoke('fill-map-asin', o),
  fillDeleteAsinMap: (o)            => ipcRenderer.invoke('fill-delete-asin-map', o),
  fillFulfillSingle: (orderId, accountId) => ipcRenderer.invoke('fill-fulfill-single', { orderId, accountId }),
  fillSyncTracking:           (opts) => ipcRenderer.invoke('fill-sync-tracking', opts),
  fillSyncTrackingAliExpress: (opts) => ipcRenderer.invoke('fill-sync-tracking-aliexpress', opts),
  fillVerifyShipped:          (opts) => ipcRenderer.invoke('fill-verify-shipped', opts),
  fillSetAutoSync:            (o)    => ipcRenderer.invoke('fill-set-auto-sync', o),
  fillGetAutoSync:            ()     => ipcRenderer.invoke('fill-get-auto-sync'),

  // List
  listQueue:          ()   => ipcRenderer.invoke('list-queue'),
  listAddItems:       (i)  => ipcRenderer.invoke('list-add-items', i),
  listUpdateItem:     (a)  => ipcRenderer.invoke('list-update-item', a),
  listRemoveItems:    (i)  => ipcRenderer.invoke('list-remove-items', i),
  listMatchAsins:     (i)  => ipcRenderer.invoke('list-match-asins', i),
  listPriceItems:     (a)  => ipcRenderer.invoke('list-price-items', a),
  listPostItems:      (i)  => ipcRenderer.invoke('list-post-items', i),
  listVerifyItem:     (id) => ipcRenderer.invoke('list-verify-item', id),
  listStop:           ()   => ipcRenderer.invoke('list-stop'),
  listTestTitle:      ()   => ipcRenderer.invoke('list-test-title'),
  listRefresh:        (o)  => ipcRenderer.invoke('list-refresh', o),
  listMarkPosted:     (ids) => ipcRenderer.invoke('list-mark-posted', ids),
  listAutoRun:        (a)   => ipcRenderer.invoke('list-auto-run', a),
  listGetQueue:       ()   => ipcRenderer.invoke('list-get-queue'),
  listGetHistory:     ()   => ipcRenderer.invoke('list-get-history'),
  listAddToQueue:     (p)  => ipcRenderer.invoke('list-add-to-queue', p),
  listClearQueue:     ()   => ipcRenderer.invoke('list-clear-queue'),
  listSaveToHistory:  (l)  => ipcRenderer.invoke('list-save-to-history', l),
  listGenerate:       (a)  => ipcRenderer.invoke('list-generate', a),
  listFetchEbayPrices:(a)  => ipcRenderer.invoke('list-fetch-ebay-prices', a),

  // Scout
  scoutHunt:        (a) => ipcRenderer.invoke('scout-hunt', a),
  scoutAnalyze:     (a) => ipcRenderer.invoke('scout-analyze', a),
  scoutGetSaved:    ()  => ipcRenderer.invoke('scout-get-saved'),
  scoutSaveProduct: (p) => ipcRenderer.invoke('scout-save-product', p),
  scoutSendToList:  (p) => ipcRenderer.invoke('scout-send-to-list', p),
  radarRun:         (o) => ipcRenderer.invoke('radar-run', o),
  radarKeywords:    (o) => ipcRenderer.invoke('radar-keywords', o),
  radarRandomNiches:(n) => ipcRenderer.invoke('radar-random-niches', n),
  scoutSaveResults: (p) => ipcRenderer.invoke('scout-save-results', p),
  scoutLoadResults: ()  => ipcRenderer.invoke('scout-load-results'),
  radarGetSellers:  ()  => ipcRenderer.invoke('radar-get-sellers'),
  compOverlayStart: (o) => ipcRenderer.invoke('comp-overlay-start', o),
  compOverlayStop:  ()  => ipcRenderer.invoke('comp-overlay-stop'),
  compSetParams:    (o) => ipcRenderer.invoke('comp-set-params', o),
  compPull:         (o) => ipcRenderer.invoke('comp-pull', o),
  compGetProducts:  ()  => ipcRenderer.invoke('comp-get-products'),
  compDeleteSeller: (s) => ipcRenderer.invoke('comp-delete-seller', s),
  radarSaveSellers: (s) => ipcRenderer.invoke('radar-save-sellers', s),

  // Accounts
  accountsGet:           ()        => ipcRenderer.invoke('accounts-get'),
  accountsSave:          (accs)    => ipcRenderer.invoke('accounts-save', accs),
  accountsAdd:           (acc)     => ipcRenderer.invoke('accounts-add', acc),
  accountsRemove:        (id)      => ipcRenderer.invoke('accounts-remove', id),
  accountsBrowserStatus: ()        => ipcRenderer.invoke('accounts-browser-status'),

  // Sauce
  saucePurge:  ()    => ipcRenderer.invoke('sauce-purge'),
  sauceRelist: (o)   => ipcRenderer.invoke('sauce-relist', o),
  sauceStop:   ()    => ipcRenderer.invoke('sauce-stop'),

  // Updater
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  updaterCheck:   () => ipcRenderer.invoke('updater-check'),

  // Agent
  agentGetLog:    ()         => ipcRenderer.invoke('agent-get-log'),
  agentGetStatus: ()         => ipcRenderer.invoke('agent-get-status'),
  agentRun:       (opts)     => ipcRenderer.invoke('agent-run', opts),
  openDigest:     ()         => ipcRenderer.invoke('open-digest'),
  openAgent:      ()         => ipcRenderer.invoke('open-agent'),

  // DB direct
  db_run: (a) => ipcRenderer.invoke('db-run', a),
  db_all: (a) => ipcRenderer.invoke('db-all', a),
  db_get: (a) => ipcRenderer.invoke('db-get', a),

  // Event listeners
  on: (channel, cb) => {
    const allowed = [
      'scan-log', 'fill-progress', 'hunt-progress',
      'fetch-progress', 'fill-order-updated', 'comp-updated', 'list-progress', 'sauce-log', 'account-status',
      'update-downloaded'
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => cb(data));
    }
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel)
});
