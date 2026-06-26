// src/shared/db.js — JSON file database (no native compilation needed)

const path = require('path');
const fs   = require('fs');
const { app } = require('electron');

function defaultDB() {
  return { orders: [], queue: [], history: [], saved_products: [], scan_log: [], asin_map: [], bank: [], _nextId: 1 };
}

function createDB(resolveFilePath) {
  let _db = null;
  let _dataPath = null;

  function getDB() {
    if (_db) return _db;
    _dataPath = resolveFilePath();
    if (fs.existsSync(_dataPath)) {
      try { _db = JSON.parse(fs.readFileSync(_dataPath, 'utf8')); }
      catch (_) { _db = defaultDB(); }
    } else {
      _db = defaultDB();
      save();
    }
    return _db;
  }

  function save() {
    if (!_dataPath) return;
    fs.writeFileSync(_dataPath, JSON.stringify(_db, null, 2), 'utf8');
  }

  function nextId() {
    const id = getDB()._nextId++;
    save();
    return id;
  }

  return {
    async init() {
      getDB();
      console.log('[DB] JSON database ready at', _dataPath);
    },

    run(sql, params = []) {
      const db = getDB();
      const s = sql.trim().toUpperCase();

      if (s.startsWith('INSERT INTO')) {
        const tableMatch = sql.match(/INSERT INTO\s+(\w+)/i);
        const table = tableMatch?.[1];
        if (!table || !db[table]) return { lastInsertRowid: null };
        const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
        const cols = colMatch?.[1].split(',').map(c => c.trim()) || [];
        const row = { id: nextId() };
        cols.forEach((c, i) => { if (params[i] !== undefined) row[c] = params[i]; });
        row.created_at = row.created_at || new Date().toISOString();
        row.updated_at = row.updated_at || new Date().toISOString();
        if (sql.toUpperCase().includes('INSERT OR IGNORE')) {
          const existing = db[table].find(r => r.asin === row.asin);
          if (existing) return { lastInsertRowid: existing.id };
        }
        db[table].push(row);
        save();
        return { lastInsertRowid: row.id };
      }

      if (s.startsWith('UPDATE')) {
        const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
        const table = tableMatch?.[1];
        if (!table || !db[table]) return { changes: 0 };
        const whereMatch = sql.match(/WHERE\s+(.+)$/i);
        const whereStr = whereMatch?.[1] || '';
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
        const setStr = setMatch?.[1] || '';

        const sets = {};
        setStr.split(',').forEach(part => {
          const m = part.trim().match(/(\w+)\s*=\s*\?/);
          if (m) sets[m[1]] = null;
        });
        const setKeys = Object.keys(sets);
        const setCols = setKeys.length;
        const whereCol = whereStr.match(/(\w+)\s*=\s*\?/)?.[1];
        const whereVal = params[setCols];

        let changed = 0;
        db[table].forEach(row => {
          if (whereCol && String(row[whereCol]) !== String(whereVal)) return;
          setKeys.forEach((k, i) => { if (params[i] !== undefined) row[k] = params[i]; });
          row.updated_at = new Date().toISOString();
          changed++;
        });
        if (changed) save();
        return { changes: changed };
      }

      if (s.startsWith('DELETE')) {
        const tableMatch = sql.match(/DELETE FROM\s+(\w+)/i);
        const table = tableMatch?.[1];
        if (!table || !db[table]) return { changes: 0 };
        const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
        const col = whereMatch?.[1];
        const val = params[0];
        const before = db[table].length;
        if (col) db[table] = db[table].filter(r => String(r[col]) !== String(val));
        else db[table] = [];
        save();
        return { changes: before - db[table].length };
      }

      return { changes: 0 };
    },

    get(sql, params = []) { return this.all(sql, params)[0] || null; },

    all(sql, params = []) {
      const db = getDB();
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      const table = tableMatch?.[1];
      if (!table || !db[table]) return [];

      let rows = [...db[table]];

      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
      if (whereMatch) {
        const where = whereMatch[1];
        const conditions = where.split(/\s+AND\s+/i);
        let paramIdx = 0;
        for (const cond of conditions) {
          const eqMatch = cond.match(/\(?(\w+)\s*=\s*\?/);
          const isNullMatch = cond.match(/\(?(\w+)\s+IS\s+NULL/i);
          const isEmptyMatch = cond.match(/(\w+)\s*=\s*''/i);
          const neqMatch = cond.match(/(\w+)\s*!=\s*'([^']+)'/i);
          const isNotNullMatch = cond.match(/(\w+)\s+IS\s+NOT\s+NULL/i);

          if (eqMatch) {
            const col = eqMatch[1], val = params[paramIdx++];
            rows = rows.filter(r => String(r[col]) === String(val));
          } else if (isNullMatch) {
            const col = isNullMatch[1];
            rows = rows.filter(r => r[col] == null || r[col] === '');
          } else if (isEmptyMatch) {
            const col = isEmptyMatch[1];
            rows = rows.filter(r => !r[col]);
          } else if (neqMatch) {
            const col = neqMatch[1], val = neqMatch[2];
            rows = rows.filter(r => r[col] !== val);
          } else if (isNotNullMatch) {
            const col = isNotNullMatch[1];
            rows = rows.filter(r => r[col] != null && r[col] !== '');
          }
        }
      }

      const orderMatch = sql.match(/ORDER BY\s+(\w+)\s*(DESC|ASC)?/i);
      if (orderMatch) {
        const col = orderMatch[1];
        const desc = (orderMatch[2] || 'ASC').toUpperCase() === 'DESC';
        rows.sort((a, b) => {
          if (a[col] < b[col]) return desc ? 1 : -1;
          if (a[col] > b[col]) return desc ? -1 : 1;
          return 0;
        });
      }

      const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1]));
      return rows;
    },

    query(sql, params = []) { return this.all(sql, params); },

    upsertOrder(order) {
      const db = getDB();
      const existing = db.orders.find(o => o.order_id === order.order_id);
      if (existing) {
        const { fulfill_status, amazon_order_id, tracking_number, carrier, message_sent, ...safe } = order;
        for (const k of Object.keys(safe)) {
          if (safe[k] === '' || safe[k] === null || safe[k] === undefined) delete safe[k];
        }
        Object.assign(existing, safe, { updated_at: new Date().toISOString() });
      } else {
        db.orders.unshift({ id: nextId(), ...order, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
      save();
    },

    updateOrder(orderId, patch) {
      const db = getDB();
      const row = db.orders.find(o => o.order_id === orderId);
      if (row) { Object.assign(row, patch, { updated_at: new Date().toISOString() }); save(); }
    },

    getOrders() { return [...getDB().orders].sort((a,b) => b.created_at > a.created_at ? 1 : -1); },
    getQueue()  { return [...getDB().queue].sort((a,b) => b.created_at > a.created_at ? 1 : -1); },
    getHistory(){ return [...getDB().history].sort((a,b) => b.created_at > a.created_at ? 1 : -1); },
    getAsinMap(){ return getDB().asin_map; },

    addToQueue(product) {
      const db = getDB();
      if (product.asin && (db.bank || []).find(b => b.asin === product.asin)) {
        return { skipped: true, reason: 'already_banked' };
      }
      db.queue.push({ id: nextId(), ...product, created_at: new Date().toISOString() });
      save();
      return { skipped: false };
    },

    clearQueue() { getDB().queue = []; save(); },

    updateQueueItem(id, patch) {
      const db = getDB();
      const row = db.queue.find(q => q.id === id);
      if (row) { Object.assign(row, patch, { updated_at: new Date().toISOString() }); save(); }
    },

    removeQueueItems(ids) {
      const db = getDB();
      db.queue = db.queue.filter(q => !ids.includes(q.id));
      save();
    },

    addToBank(item) {
      const db = getDB();
      if (!item.asin) return;
      if (db.bank.find(b => b.asin === item.asin)) return;
      db.bank.push({ id: nextId(), asin: item.asin, ebay_item_id: item.ebay_item_id || '', title: item.title || '', our_price: item.our_price || null, banked_at: new Date().toISOString() });
      save();
    },

    isInBank(asin) {
      if (!asin) return false;
      return !!(getDB().bank || []).find(b => b.asin === asin);
    },

    getBank() { return [...(getDB().bank || [])].sort((a, b) => b.banked_at > a.banked_at ? 1 : -1); },

    mapAsin(listingId, asin, title, opts = {}) {
      const db = getDB();
      const existing = db.asin_map.find(m => m.listing_id === listingId);
      const patch = { asin, title, source: opts.source || 'amazon', ali_item_id: opts.ali_item_id || null };
      if (existing) { Object.assign(existing, patch); }
      else db.asin_map.push({ id: nextId(), listing_id: listingId, ...patch, mapped_at: new Date().toISOString() });
      save();
    },

    lookupAsin(listingId) {
      return getDB().asin_map.find(m => m.listing_id === listingId)?.asin || null;
    },

    saveCompetitorProducts(seller, products) {
      const db = getDB();
      db.competitor_products = (db.competitor_products || []).filter(p => p.seller !== seller);
      db.competitor_products.push(...products);
      save();
    },

    getCompetitorProducts() { return getDB().competitor_products || []; },

    deleteCompetitorProducts(seller) {
      const db = getDB();
      db.competitor_products = (db.competitor_products || []).filter(p => p.seller !== seller);
      save();
    },

    saveScoutResults(payload) {
      const db = getDB();
      db.scout_results = { ...payload, saved_at: new Date().toISOString() };
      save();
    },

    getScoutResults() { return getDB().scout_results || null; }
  };
}

// ── Default instance (acc1, backward-compatible) ───────────────
const DB = createDB(() => path.join(app.getPath('userData'), 'zayndrop-data-acc1.json'));

// ── Multi-account factory ──────────────────────────────────────
const _accountDBs = {};
DB.forAccount = function(accountId) {
  if (!accountId || accountId === 'acc1') return DB;
  if (_accountDBs[accountId]) return _accountDBs[accountId];
  const inst = createDB(() => path.join(app.getPath('userData'), `zayndrop-data-${accountId}.json`));
  _accountDBs[accountId] = inst;
  return inst;
};

module.exports = DB;
