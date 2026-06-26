// #region agent log
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, '../../debug-1c14bd.log');
function dbg(payload) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ sessionId: '1c14bd', timestamp: Date.now(), ...payload }) + '\n');
  } catch (_) {}
}
module.exports = dbg;
// #endregion
