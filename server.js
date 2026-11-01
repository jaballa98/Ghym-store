'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, tx, allSettings, setSetting, DEFAULTS } = require('./lib/db');
const { hashPassword, verifyPassword, sign, verify } = require('./lib/auth');
const { quote } = require('./lib/delivery');
const V = require('./lib/validate');

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const PERMS = ['products', 'categories', 'cities', 'orders', 'settings'];
const now = () => Date.now();

/* ---------- tiny framework ---------- */
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, extra) => new HttpError(400, m, extra);
const routes = [];
const route = (method, p, handler, guard) => routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, guard });

const attempts = new Map();   // naive login throttle: 10 failures / 15 min per IP+kind
function throttle(ip, kind) {
  const k = ip + kind, a = (attempts.get(k) || []).filter(t => now() - t < 15 * 60000);
  if (a.length >= 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  return () => { a.push(now()); attempts.set(k, a); };
}

function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 3e6) { rej(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return res({}); try { res(JSON.parse(Buffer.concat(chunks))); } catch (_) { rej(bad('Invalid JSON')); } });
  });
}

/* ---------- guards ---------- */
const needUser = ctx => {
  const p = verify(ctx.token);
  if (!p || p.t !== 'user') throw new HttpError(401, 'Please sign up or log in first.', { auth_required: true });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.id);
  if (!u) throw new HttpError(401, 'Account not found.', { auth_required: true });
  ctx.user = u;
};
const needAdmin = perm => ctx => {
  const p = verify(ctx.token);
  if (!p || p.t !== 'admin') throw new HttpError(401, 'Admin sign in required.');
  const a = db.prepare('SELECT * FROM admins WHERE id=?').get(p.id);
  if (!a) throw new HttpError(401, 'Admin account not found.');
  a.permissions = JSON.parse(a.permissions);
  if (perm === 'super' && !a.is_super) throw new HttpError(403, 'Only the main admin can do this.');
  if (perm && perm !== 'super' && !a.is_super && !a.permissions.includes(perm)) throw new HttpError(403, `Your account does not have the "${perm}" privilege.`);
  ctx.admin = a;
};
const publicUser = u => ({ id: u.id, first_name: u.first_name, last_name: u.last_name, city_id: u.city_id, phone1: u.phone1, phone2: u.phone2, email: u.email, lat: u.lat, lng: u.lng, username: u.username });
const publicAdmin = a => ({ id: a.id, username: a.username, is_super: !!a.is_super, permissions: typeof a.permissions === 'string' ? JSON.parse(a.permissions) : a.permissions });

/* ---------- product helpers ---------- */
const eff = p => Math.round(p.price * (1 - p.discount_percent / 100) * 100) / 100;
function loadProducts(where = '', args = [], adminView = false) {
  const rows = db.prepare(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id ${where} ORDER BY p.id DESC`).all(...args);
  const vs = db.prepare('SELECT id, product_id, size, stock FROM product_variants').all();
  return rows.filter(p => adminView || p.active).map(p => {
    const variants = vs.filter(v => v.product_id === p.id);
    return { ...p, active: !!p.active, final_price: eff(p), variants, total_stock: variants.reduce((a, v) => a + v.stock, 0) };
  });
}
function saveVariants(productId, list) {
  const clean = new Map();
  for (const v of Array.isArray(list) ? list : []) {
    const size = String(v.size || '').trim().slice(0, 20), stock = Math.floor(+v.stock);
    if (!size) continue;
    if (!(stock >= 0)) throw bad(`Stock for size "${size}" must be 0 or more.`);
    clean.set(size.toLowerCase(), { size, stock });
  }
  if (!clean.size) clean.set('standard', { size: 'Standard', stock: 0 });
  const existing = db.prepare('SELECT id,size FROM product_variants WHERE product_id=?').all(productId);
  for (const e of existing) if (!clean.has(e.size.toLowerCase())) db.prepare('DELETE FROM product_variants WHERE id=?').run(e.id);
  for (const { size, stock } of clean.values()) {
    const e = existing.find(x => x.size.toLowerCase() === size.toLowerCase());
    if (e) db.prepare('UPDATE product_variants SET size=?, stock=? WHERE id=?').run(size, stock, e.id);
    else db.prepare('INSERT INTO product_variants(product_id,size,stock) VALUES(?,?,?)').run(productId, size, stock);
  }
}
function productInput(b) {
  const name = String(b.name || '').trim();
  if (name.length < 2) throw bad('Product name is required.');
  const price = +b.price; if (!(price >= 0)) throw bad('Price must be 0 or more.');
  const disc = +(b.discount_percent || 0); if (!(disc >= 0 && disc <= 100)) throw bad('Discount must be between 0 and 100.');
  const cat = b.category_id ? +b.category_id : null;
  if (cat && !db.prepare('SELECT 1 FROM categories WHERE id=?').get(cat)) throw bad('Unknown category.');
  const image = String(b.image || ''); if (image && !/^data:image\/(png|jpe?g|webp);base64,/.test(image) && !/^https?:\/\//.test(image)) throw bad('Image must be an uploaded photo or an http(s) link.');
  return { name, description: String(b.description || '').slice(0, 2000), price, discount_percent: disc, category_id: cat, image, active: b.active === false ? 0 : 1 };
}

/* ---------- PUBLIC ---------- */
route('GET', '/api/config', () => ({
  settings: (({ store_name, store_lat, store_lng, currency, pricing_mode }) => ({ store_name, store_lat: +store_lat, store_lng: +store_lng, currency, pricing_mode }))(allSettings()),
  cities: db.prepare('SELECT id,name,delivery_fee FROM cities WHERE active=1 ORDER BY name').all(),
  categories: db.prepare('SELECT id,name FROM categories ORDER BY name').all()
}));
route('GET', '/api/products', ctx => {
  const w = [], a = [];
  if (ctx.query.get('category')) { w.push('p.category_id=?'); a.push(+ctx.query.get('category')); }
  if (ctx.query.get('q')) { w.push('(p.name LIKE ? OR p.description LIKE ?)'); const q = `%${ctx.query.get('q')}%`; a.push(q, q); }
  return loadProducts(w.length ? 'WHERE ' + w.join(' AND ') : '', a);
});
route('GET', '/api/products/:id', ctx => { const p = loadProducts('WHERE p.id=?', [+ctx.params.id])[0]; if (!p) throw new HttpError(404, 'Product not found.'); return p; });
route('GET', '/api/username-available', ctx => {
  const u = ctx.query.get('u') || '';
  if (!V.isUsername(u)) return { available: false, reason: 'invalid' };
  return { available: !db.prepare('SELECT 1 FROM users WHERE username=?').get(u) };
});
route('POST', '/api/delivery/quote', ctx => {
  const lat = +ctx.body.lat, lng = +ctx.body.lng;
  if (!V.isLat(lat) || !V.isLng(lng)) throw bad('Pick a valid location on the map.');
  return quote(lat, lng, ctx.body.city_id ? +ctx.body.city_id : null);
});

/* ---------- AUTH (customers) ---------- */
route('POST', '/api/auth/register', ctx => {
  const b = ctx.body;
  const errors = V.validateRegistration(b,
    id => !!db.prepare('SELECT 1 FROM cities WHERE id=? AND active=1').get(id),
    u => !!db.prepare('SELECT 1 FROM users WHERE username=?').get(u));
  if (Object.keys(errors).length) throw bad('Please fix the highlighted fields.', { errors });
  let id;
  try {
    id = db.prepare(`INSERT INTO users(first_name,last_name,city_id,phone1,phone2,email,lat,lng,username,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.first_name.trim(), b.last_name.trim(), +b.city_id, V.cleanPhone(b.phone1), b.phone2 ? V.cleanPhone(b.phone2) : null,
        b.email.trim().toLowerCase(), +b.lat, +b.lng, b.username, hashPassword(b.password), now()).lastInsertRowid;
  } catch (e) {                       // race: UNIQUE constraint is the final authority
    if (/UNIQUE/i.test(e.message)) throw bad('Please fix the highlighted fields.', { errors: { username: 'That username is already taken.' } });
    throw e;
  }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  return { status: 201, body: { token: sign({ t: 'user', id }), user: publicUser(u) } };   // auto-login
});
route('POST', '/api/auth/login', ctx => {
  const fail = throttle(ctx.ip, 'user');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(ctx.body.username || ''));
  if (!u || !verifyPassword(String(ctx.body.password || ''), u.password_hash)) { fail(); throw new HttpError(401, 'Wrong username or password.'); }
  return { token: sign({ t: 'user', id: u.id }), user: publicUser(u) };
});
route('GET', '/api/me', ctx => ({ user: publicUser(ctx.user) }), needUser);
route('PATCH', '/api/me/location', ctx => {
  const lat = +ctx.body.lat, lng = +ctx.body.lng;
  if (!V.isLat(lat) || !V.isLng(lng)) throw bad('Invalid location.');
  db.prepare('UPDATE users SET lat=?, lng=? WHERE id=?').run(lat, lng, ctx.user.id);
  return { ok: true };
}, needUser);

/* ---------- CART & WISHLIST (customers only) ---------- */
function cartView(userId) {
  const items = db.prepare(`SELECT ci.id, ci.qty, v.id AS variant_id, v.size, v.stock, p.id AS product_id, p.name, p.image, p.price, p.discount_percent
    FROM cart_items ci JOIN product_variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.user_id=? ORDER BY ci.id`).all(userId)
    .map(i => ({ ...i, unit_price: eff(i), line_total: Math.round(eff(i) * i.qty * 100) / 100 }));
  return { items, subtotal: Math.round(items.reduce((a, i) => a + i.line_total, 0) * 100) / 100 };
}
route('GET', '/api/cart', ctx => cartView(ctx.user.id), needUser);
route('POST', '/api/cart', ctx => {
  const v = db.prepare('SELECT v.*, p.active FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=?').get(+ctx.body.variant_id);
  if (!v || !v.active) throw new HttpError(404, 'Product not available.');
  const qty = Math.max(1, Math.floor(+ctx.body.qty || 1));
  const cur = db.prepare('SELECT qty FROM cart_items WHERE user_id=? AND variant_id=?').get(ctx.user.id, v.id)?.qty || 0;
  if (cur + qty > v.stock) throw bad(v.stock ? `Only ${v.stock} left in size ${v.size}.` : `Size ${v.size} is sold out.`);
  db.prepare('INSERT INTO cart_items(user_id,variant_id,qty) VALUES(?,?,?) ON CONFLICT(user_id,variant_id) DO UPDATE SET qty=qty+excluded.qty').run(ctx.user.id, v.id, qty);
  return cartView(ctx.user.id);
}, needUser);
route('PATCH', '/api/cart/:id', ctx => {
  const row = db.prepare('SELECT ci.id, v.stock FROM cart_items ci JOIN product_variants v ON v.id=ci.variant_id WHERE ci.id=? AND ci.user_id=?').get(+ctx.params.id, ctx.user.id);
  if (!row) throw new HttpError(404, 'Cart item not found.');
  const qty = Math.floor(+ctx.body.qty);
  if (!(qty >= 0)) throw bad('Invalid quantity.');
  if (qty === 0) db.prepare('DELETE FROM cart_items WHERE id=?').run(row.id);
  else if (qty > row.stock) throw bad(`Only ${row.stock} in stock.`);
  else db.prepare('UPDATE cart_items SET qty=? WHERE id=?').run(qty, row.id);
  return cartView(ctx.user.id);
}, needUser);
route('DELETE', '/api/cart/:id', ctx => { db.prepare('DELETE FROM cart_items WHERE id=? AND user_id=?').run(+ctx.params.id, ctx.user.id); return cartView(ctx.user.id); }, needUser);

route('GET', '/api/wishlist', ctx => {
  const ids = db.prepare('SELECT product_id FROM wishlist WHERE user_id=?').all(ctx.user.id).map(r => r.product_id);
  return { ids, products: ids.length ? loadProducts(`WHERE p.id IN (${ids.map(() => '?').join(',')})`, ids) : [] };
}, needUser);
route('POST', '/api/wishlist/:id', ctx => {
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(+ctx.params.id)) throw new HttpError(404, 'Product not found.');
  db.prepare('INSERT OR IGNORE INTO wishlist(user_id,product_id) VALUES(?,?)').run(ctx.user.id, +ctx.params.id);
  return { ok: true };
}, needUser);
route('DELETE', '/api/wishlist/:id', ctx => { db.prepare('DELETE FROM wishlist WHERE user_id=? AND product_id=?').run(ctx.user.id, +ctx.params.id); return { ok: true }; }, needUser);

/* ---------- CHECKOUT & ORDERS ---------- */
route('POST', '/api/checkout', ctx => {
  const lat = +ctx.body.lat, lng = +ctx.body.lng;
  if (!V.isLat(lat) || !V.isLng(lng)) throw bad('Pick your delivery spot on the map.');
  const cityId = ctx.body.city_id ? +ctx.body.city_id : ctx.user.city_id;
  return tx(() => {
    const cart = cartView(ctx.user.id);
    if (!cart.items.length) throw bad('Your cart is empty.');
    for (const i of cart.items) {                      // re-check stock inside the transaction
      const cur = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(i.variant_id);
      if (!cur || cur.stock < i.qty) throw bad(`"${i.name}" (${i.size}) is no longer available in that quantity.`);
    }
    const q = quote(lat, lng, cityId);                 // fee is always computed on the server
    const total = Math.round((cart.subtotal + q.delivery_fee) * 100) / 100;
    const oid = db.prepare('INSERT INTO orders(user_id,city_id,lat,lng,distance_km,subtotal,delivery_fee,total,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(ctx.user.id, cityId, lat, lng, q.distance_km, cart.subtotal, q.delivery_fee, total, now()).lastInsertRowid;
    for (const i of cart.items) {
      db.prepare('INSERT INTO order_items(order_id,product_id,name,size,unit_price,qty) VALUES(?,?,?,?,?,?)').run(oid, i.product_id, i.name, i.size, i.unit_price, i.qty);
      db.prepare('UPDATE product_variants SET stock=stock-? WHERE id=?').run(i.qty, i.variant_id);
    }
    db.prepare('DELETE FROM cart_items WHERE user_id=?').run(ctx.user.id);
    return { status: 201, body: { order_id: Number(oid), subtotal: cart.subtotal, delivery_fee: q.delivery_fee, distance_km: q.distance_km, total } };
  });
}, needUser);
const ordersFor = (where, args) => db.prepare(`SELECT o.*, u.first_name, u.last_name, u.phone1, u.phone2, u.username, c.name AS city FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN cities c ON c.id=o.city_id ${where} ORDER BY o.id DESC`).all(...args)
  .map(o => ({ ...o, items: db.prepare('SELECT name,size,unit_price,qty FROM order_items WHERE order_id=?').all(o.id) }));
route('GET', '/api/orders', ctx => ordersFor('WHERE o.user_id=?', [ctx.user.id]), needUser);

/* ---------- ADMIN ---------- */
route('POST', '/api/admin/login', ctx => {
  const fail = throttle(ctx.ip, 'admin');
  const a = db.prepare('SELECT * FROM admins WHERE username=?').get(String(ctx.body.username || ''));
  if (!a || !verifyPassword(String(ctx.body.password || ''), a.password_hash)) { fail(); throw new HttpError(401, 'Wrong username or password.'); }
  return { token: sign({ t: 'admin', id: a.id }, 60 * 60 * 12), admin: publicAdmin(a) };
});
route('GET', '/api/admin/me', ctx => ({ admin: publicAdmin(ctx.admin) }), needAdmin());

// cities
route('GET', '/api/admin/cities', () => db.prepare('SELECT * FROM cities ORDER BY name').all(), needAdmin('cities'));
const cityInput = b => {
  const name = String(b.name || '').trim(), fee = +b.delivery_fee;
  if (name.length < 2) throw bad('City name is required.');
  if (!(fee >= 0)) throw bad('Delivery price must be 0 or more.');
  return { name, fee, active: b.active === false ? 0 : 1 };
};
const uniq = (fn) => { try { return fn(); } catch (e) { if (/UNIQUE/i.test(e.message)) throw bad('That name already exists.'); throw e; } };
route('POST', '/api/admin/cities', ctx => { const c = cityInput(ctx.body); return { status: 201, body: { id: Number(uniq(() => db.prepare('INSERT INTO cities(name,delivery_fee,active) VALUES(?,?,?)').run(c.name, c.fee, c.active)).lastInsertRowid) } }; }, needAdmin('cities'));
route('PUT', '/api/admin/cities/:id', ctx => { const c = cityInput(ctx.body); uniq(() => db.prepare('UPDATE cities SET name=?, delivery_fee=?, active=? WHERE id=?').run(c.name, c.fee, c.active, +ctx.params.id)); return { ok: true }; }, needAdmin('cities'));
route('DELETE', '/api/admin/cities/:id', ctx => {
  if (db.prepare('SELECT 1 FROM users WHERE city_id=?').get(+ctx.params.id)) throw bad('Customers live in this city. Hide it instead of deleting it.');
  db.prepare('DELETE FROM cities WHERE id=?').run(+ctx.params.id); return { ok: true };
}, needAdmin('cities'));

// categories
route('POST', '/api/admin/categories', ctx => { const n = String(ctx.body.name || '').trim(); if (n.length < 2) throw bad('Category name is required.'); return { status: 201, body: { id: Number(uniq(() => db.prepare('INSERT INTO categories(name) VALUES(?)').run(n)).lastInsertRowid) } }; }, needAdmin('categories'));
route('PUT', '/api/admin/categories/:id', ctx => { const n = String(ctx.body.name || '').trim(); if (n.length < 2) throw bad('Category name is required.'); uniq(() => db.prepare('UPDATE categories SET name=? WHERE id=?').run(n, +ctx.params.id)); return { ok: true }; }, needAdmin('categories'));
route('DELETE', '/api/admin/categories/:id', ctx => { db.prepare('DELETE FROM categories WHERE id=?').run(+ctx.params.id); return { ok: true }; }, needAdmin('categories'));   // products become uncategorised

// products
route('GET', '/api/admin/products', () => loadProducts('', [], true), needAdmin('products'));
route('POST', '/api/admin/products', ctx => tx(() => {
  const p = productInput(ctx.body);
  const id = Number(db.prepare('INSERT INTO products(name,description,price,category_id,discount_percent,image,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(p.name, p.description, p.price, p.category_id, p.discount_percent, p.image, p.active, now()).lastInsertRowid);
  saveVariants(id, ctx.body.variants);
  return { status: 201, body: { id } };
}), needAdmin('products'));
route('PUT', '/api/admin/products/:id', ctx => tx(() => {
  const id = +ctx.params.id; if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw new HttpError(404, 'Product not found.');
  const p = productInput(ctx.body);
  db.prepare('UPDATE products SET name=?,description=?,price=?,category_id=?,discount_percent=?,image=?,active=? WHERE id=?').run(p.name, p.description, p.price, p.category_id, p.discount_percent, p.image, p.active, id);
  saveVariants(id, ctx.body.variants);
  return { ok: true };
}), needAdmin('products'));
route('DELETE', '/api/admin/products/:id', ctx => { db.prepare('DELETE FROM products WHERE id=?').run(+ctx.params.id); return { ok: true }; }, needAdmin('products'));

// orders
route('GET', '/api/admin/orders', () => ordersFor('', []), needAdmin('orders'));
route('PATCH', '/api/admin/orders/:id', ctx => {
  const s = String(ctx.body.status || ''); if (!['new', 'confirmed', 'delivered', 'cancelled'].includes(s)) throw bad('Unknown status.');
  tx(() => {
    const o = db.prepare('SELECT status FROM orders WHERE id=?').get(+ctx.params.id); if (!o) throw new HttpError(404, 'Order not found.');
    if (s === 'cancelled' && o.status !== 'cancelled') {                       // return stock
      for (const i of db.prepare('SELECT product_id,size,qty FROM order_items WHERE order_id=?').all(+ctx.params.id))
        db.prepare('UPDATE product_variants SET stock=stock+? WHERE product_id=? AND size=?').run(i.qty, i.product_id, i.size);
    }
    if (o.status === 'cancelled' && s !== 'cancelled') throw bad('A cancelled order cannot be reopened.');
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(s, +ctx.params.id);
  });
  return { ok: true };
}, needAdmin('orders'));

// settings (store location + pricing formula)
route('GET', '/api/admin/settings', () => allSettings(), needAdmin('settings'));
route('PUT', '/api/admin/settings', ctx => {
  const b = ctx.body, out = {};
  const num = (k, min, max) => { if (b[k] === undefined) return; const n = +b[k]; if (!(n >= min && n <= max)) throw bad(`${k} must be between ${min} and ${max}.`); out[k] = n; };
  num('store_lat', -90, 90); num('store_lng', -180, 180); num('base_fee', 0, 1e6); num('price_per_km', 0, 1e6); num('road_factor', 1, 3);
  if (b.pricing_mode !== undefined) { if (!['distance', 'city', 'city_base', 'highest'].includes(b.pricing_mode)) throw bad('Unknown pricing mode.'); out.pricing_mode = b.pricing_mode; }
  if (b.store_name !== undefined) out.store_name = String(b.store_name).trim().slice(0, 60) || DEFAULTS.store_name;
  if (b.currency !== undefined) out.currency = String(b.currency).trim().slice(0, 6) || DEFAULTS.currency;
  tx(() => Object.entries(out).forEach(([k, v]) => setSetting(k, v)));
  return allSettings();
}, needAdmin('settings'));

// staff (main admin only)
route('GET', '/api/admin/staff', () => db.prepare('SELECT id,username,is_super,permissions,created_at FROM admins ORDER BY id').all().map(publicAdmin), needAdmin('super'));
route('POST', '/api/admin/staff', ctx => {
  const u = String(ctx.body.username || '').trim(), pw = String(ctx.body.password || '');
  if (!V.isUsername(u)) throw bad('Username: 3 to 30 characters, start with a letter, use letters, numbers, _ or .');
  if (pw.length < 8) throw bad('Password must be at least 8 characters.');
  const perms = (Array.isArray(ctx.body.permissions) ? ctx.body.permissions : []).filter(p => PERMS.includes(p));
  const id = Number(uniq(() => db.prepare('INSERT INTO admins(username,password_hash,is_super,permissions,created_at) VALUES(?,?,0,?,?)').run(u, hashPassword(pw), JSON.stringify(perms), now())).lastInsertRowid);
  return { status: 201, body: { id } };
}, needAdmin('super'));
route('PUT', '/api/admin/staff/:id', ctx => {
  const t = db.prepare('SELECT * FROM admins WHERE id=?').get(+ctx.params.id); if (!t) throw new HttpError(404, 'Not found.');
  if (t.is_super) throw bad('The main admin always has full access.');
  const perms = (Array.isArray(ctx.body.permissions) ? ctx.body.permissions : []).filter(p => PERMS.includes(p));
  db.prepare('UPDATE admins SET permissions=? WHERE id=?').run(JSON.stringify(perms), t.id);
  if (ctx.body.password) { if (String(ctx.body.password).length < 8) throw bad('Password must be at least 8 characters.'); db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashPassword(String(ctx.body.password)), t.id); }
  return { ok: true };
}, needAdmin('super'));
route('DELETE', '/api/admin/staff/:id', ctx => {
  const t = db.prepare('SELECT * FROM admins WHERE id=?').get(+ctx.params.id); if (!t) throw new HttpError(404, 'Not found.');
  if (t.is_super) throw bad('The main admin cannot be deleted.');
  db.prepare('DELETE FROM admins WHERE id=?').run(t.id); return { ok: true };
}, needAdmin('super'));

/* ---------- server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com; connect-src 'self'"
};
const send = (res, status, body, headers = {}) => { const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body); res.writeHead(status, { ...SEC, ...headers }); res.end(b); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!r) return send(res, url.pathname.startsWith('/api/') && routes.some(x => x.re.test(url.pathname)) ? 405 : 404, { error: 'Not found' }, { 'Content-Type': 'application/json' });
      const ctx = { params: r.re.exec(url.pathname).groups || {}, query: url.searchParams, body: {}, ip: req.socket.remoteAddress, token: (req.headers.authorization || '').replace(/^Bearer /, '') };
      if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await readBody(req);
      if (r.guard) r.guard(ctx);
      let out = r.handler(ctx), status = 200;
      if (out && out.status && out.body) { status = out.status; out = out.body; }
      return send(res, status, out, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    }
    let f = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
    send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) }, { 'Content-Type': 'application/json' });
    console.error(e); send(res, 500, { error: 'Something went wrong on the server.' }, { 'Content-Type': 'application/json' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`Ghym Store running on http://localhost:${PORT}`));
module.exports = server;
