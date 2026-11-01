'use strict';
// SQLite via Node's built-in node:sqlite (Node >= 22.5). No native modules to compile.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./auth');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(dir, 'ghym.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS cities(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  delivery_fee REAL NOT NULL DEFAULT 0 CHECK(delivery_fee >= 0),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  city_id INTEGER NOT NULL REFERENCES cities(id),
  phone1 TEXT NOT NULL,
  phone2 TEXT,
  email TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- DB-level uniqueness, case-insensitive
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_super INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '[]',          -- JSON array: products, categories, cities, orders, settings
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL CHECK(price >= 0),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  discount_percent REAL NOT NULL DEFAULT 0 CHECK(discount_percent >= 0 AND discount_percent <= 100),
  image TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS product_variants(     -- one row per size; products without sizes get "Standard"
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  UNIQUE(product_id, size)
);
CREATE TABLE IF NOT EXISTS cart_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK(qty > 0),
  UNIQUE(user_id, variant_id)
);
CREATE TABLE IF NOT EXISTS wishlist(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  city_id INTEGER REFERENCES cities(id),
  lat REAL NOT NULL, lng REAL NOT NULL,
  distance_km REAL NOT NULL,
  subtotal REAL NOT NULL,
  delivery_fee REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER, name TEXT NOT NULL, size TEXT NOT NULL,
  unit_price REAL NOT NULL, qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
`);

const DEFAULTS = {
  store_name: 'Ghym Store',
  store_lat: '32.8872', store_lng: '13.1913',   // Tripoli. Change in Admin > Settings.
  base_fee: '5', price_per_km: '0.5', road_factor: '1.25',
  pricing_mode: 'highest',                      // distance | city | city_base | highest
  currency: 'LYD'
};
const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? DEFAULTS[k];
const allSettings = () => Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, getSetting(k)]));
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

function tx(fn) {            // simple transaction helper
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function seed() {
  if (!db.prepare('SELECT 1 FROM admins').get()) {
    const u = process.env.ADMIN_USER || 'admin', p = process.env.ADMIN_PASS || 'admingb';
    db.prepare('INSERT INTO admins(username,password_hash,is_super,permissions,created_at) VALUES(?,?,1,?,?)')
      .run(u, hashPassword(p), JSON.stringify(['products', 'categories', 'cities', 'orders', 'settings']), Date.now());
  }
  if (!db.prepare('SELECT 1 FROM cities').get()) {
    const c = db.prepare('INSERT INTO cities(name,delivery_fee) VALUES(?,?)');
    [['Tripoli', 10], ['Misrata', 20], ['Benghazi', 30]].forEach(x => c.run(...x));
  }
  if (!db.prepare('SELECT 1 FROM categories').get()) {
    const c = db.prepare('INSERT INTO categories(name) VALUES(?)');
    ['Clothing', 'Home', 'Accessories'].forEach(x => c.run(x));
  }
  if (!db.prepare('SELECT 1 FROM products').get() && process.env.SEED_SAMPLE !== '0') {
    const cat = n => db.prepare('SELECT id FROM categories WHERE name=?').get(n).id;
    const p = db.prepare('INSERT INTO products(name,description,price,category_id,discount_percent,created_at) VALUES(?,?,?,?,?,?)');
    const v = db.prepare('INSERT INTO product_variants(product_id,size,stock) VALUES(?,?,?)');
    let r = p.run('Cloud Soft Hoodie', 'Brushed cotton hoodie in washed pink. Relaxed fit.', 85, cat('Clothing'), 10, Date.now());
    [['S', 5], ['M', 8], ['L', 3], ['XL', 0]].forEach(([s, n]) => v.run(r.lastInsertRowid, s, n));
    r = p.run('Rose Quartz Mug', 'Matte ceramic mug, 350 ml.', 22, cat('Home'), 0, Date.now());
    v.run(r.lastInsertRowid, 'Standard', 30);
  }
}
seed();

module.exports = { db, tx, getSetting, allSettings, setSetting, DEFAULTS };
