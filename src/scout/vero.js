// src/scout/vero.js — VeRO (brand protection) filter
// List sourced from EcomSniper's VeroListNew.txt (5,831 brands)

const fs = require('fs');
const path = require('path');

let brands = null;

function load() {
  if (brands) return brands;
  const file = path.join(__dirname, '../../assets/vero.txt');
  brands = fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 2);
  return brands;
}

const Vero = {
  // Returns the matched brand name if the title contains a protected brand, else null
  check(title) {
    if (!title) return null;
    const t = ` ${title.toLowerCase()} `;
    for (const b of load()) {
      // Word-boundary-ish match to avoid "apple" matching "pineapple"
      if (t.includes(` ${b} `) || t.includes(` ${b},`) || t.includes(` ${b}.`) || t.includes(`(${b})`)) {
        return b;
      }
    }
    return null;
  },

  filter(products) {
    const kept = [], removed = [];
    for (const p of products) {
      const hit = this.check(p.title);
      if (hit) removed.push({ ...p, veroBrand: hit });
      else kept.push(p);
    }
    return { kept, removed };
  }
};

module.exports = Vero;
