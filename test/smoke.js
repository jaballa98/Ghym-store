'use strict';
process.env.DB_FILE = ':memory:'; process.env.DATA_DIR = require('os').tmpdir() + '/ghym-test';
const assert = require('assert');
const server = require('../server');
const { haversineKm } = require('../lib/delivery');

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const call = async (m, p, body, token) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  let n = 0; const ok = (c, m) => { assert(c, m); console.log('  ok', ++n, m); };

  const cfg = (await call('GET', '/api/config')).j;
  ok(cfg.cities.length >= 3 && cfg.categories.length >= 3, 'guest can load cities and categories');
  const prods = (await call('GET', '/api/products')).j;
  ok(prods.length >= 2, 'guest can browse products');
  const hoodie = prods.find(p => p.name.includes('Hoodie'));
  ok(Math.abs(hoodie.final_price - 76.5) < 0.001, 'percentage discount applied (85 - 10% = 76.50)');

  let r = await call('POST', '/api/cart', { variant_id: hoodie.variants[0].id, qty: 1 });
  ok(r.s === 401 && r.j.auth_required, 'guest cannot add to cart (401 auth_required)');
  r = await call('POST', '/api/wishlist/' + hoodie.id);
  ok(r.s === 401, 'guest cannot add to wishlist');

  const reg = { first_name: 'Sara', last_name: 'Ali', city_id: cfg.cities[0].id, phone1: '0912345678', phone2: '', email: 'sara@gmail.com', lat: 32.9, lng: 13.2, username: 'Sara_A', password: 'secret123', confirm_password: 'secret123' };
  r = await call('POST', '/api/auth/register', { ...reg, email: 'sara@yahoo.com', confirm_password: 'nope', lat: null });
  ok(r.s === 400 && r.j.errors.email && r.j.errors.confirm_password && r.j.errors.location, 'registration rejects non-Gmail/iCloud email, mismatch, missing pin');
  r = await call('POST', '/api/auth/register', reg);
  ok(r.s === 201 && r.j.token, 'registration succeeds and returns a login token');
  const tok = r.j.token;
  r = await call('POST', '/api/auth/register', { ...reg, username: 'sara_a', email: 'other@icloud.com' });
  ok(r.s === 400 && r.j.errors.username, 'duplicate username rejected (case-insensitive)');
  r = await call('GET', '/api/username-available?u=SARA_A');
  ok(r.j.available === false, 'username availability endpoint reports taken');

  r = await call('POST', '/api/cart', { variant_id: hoodie.variants.find(v => v.size === 'XL').id, qty: 1 }, tok);
  ok(r.s === 400, 'cannot add a sold-out size');
  const M = hoodie.variants.find(v => v.size === 'M');
  r = await call('POST', '/api/cart', { variant_id: M.id, qty: 2 }, tok);
  ok(r.s === 200 && r.j.subtotal === 153, 'customer adds 2 × M to cart, subtotal 153.00');
  r = await call('POST', '/api/wishlist/' + hoodie.id, null, tok);
  ok(r.s === 200, 'customer can wishlist');

  // delivery: store Tripoli 32.8872,13.1913 ; customer ~ Misrata 32.3754,15.0925
  const d = haversineKm(32.8872, 13.1913, 32.3754, 15.0925);
  ok(d > 170 && d < 190, 'haversine Tripoli→Misrata ≈ ' + d.toFixed(1) + ' km');
  const misrata = cfg.cities.find(c => c.name === 'Misrata');
  r = await call('POST', '/api/delivery/quote', { lat: 32.3754, lng: 15.0925, city_id: misrata.id });
  const expected = Math.round(Math.max(5 + r.j.distance_km * 0.5, 20) * 100) / 100;
  ok(r.j.delivery_fee === expected, `quote = max(5 + ${r.j.distance_km} km × 0.5, city fee 20) = ${r.j.delivery_fee}`);

  r = await call('POST', '/api/checkout', { lat: 32.3754, lng: 15.0925, city_id: misrata.id }, tok);
  ok(r.s === 201 && r.j.total === Math.round((153 + expected) * 100) / 100, 'checkout total = subtotal + server-computed fee');
  const after = (await call('GET', '/api/products/' + hoodie.id)).j.variants.find(v => v.size === 'M').stock;
  ok(after === 6, 'stock decremented 8 → 6');

  const adm = (await call('POST', '/api/admin/login', { username: 'admin', password: 'admingb' })).j;
  ok(adm.token && adm.admin.is_super, 'main admin can log in');
  ok((await call('POST', '/api/admin/login', { username: 'admin', password: 'wrong' })).s === 401, 'wrong admin password rejected');
  ok((await call('GET', '/api/admin/orders', null, tok)).s === 401, 'customer token cannot use admin API');

  r = await call('POST', '/api/admin/staff', { username: 'staff1', password: 'staffpass1', permissions: ['products'] }, adm.token);
  ok(r.s === 201, 'main admin creates staff with products-only privilege');
  const st = (await call('POST', '/api/admin/login', { username: 'staff1', password: 'staffpass1' })).j;
  ok((await call('GET', '/api/admin/products', null, st.token)).s === 200, 'staff can manage products');
  ok((await call('POST', '/api/admin/cities', { name: 'Sebha', delivery_fee: 40 }, st.token)).s === 403, 'staff blocked from cities (no privilege)');
  ok((await call('GET', '/api/admin/staff', null, st.token)).s === 403, 'staff cannot manage staff');

  r = await call('POST', '/api/admin/cities', { name: 'Sebha', delivery_fee: 40 }, adm.token);
  ok(r.s === 201, 'admin adds city');
  r = await call('PUT', '/api/admin/cities/' + r.j.id, { name: 'Sabha', delivery_fee: 45 }, adm.token);
  ok(r.s === 200, 'admin updates city');
  r = await call('POST', '/api/admin/products', { name: 'Tee', price: 30, discount_percent: 20, category_id: cfg.categories[0].id, variants: [{ size: 'S', stock: 4 }, { size: 'M', stock: 6 }] }, st.token);
  ok(r.s === 201, 'staff adds product with per-size stock');
  r = await call('PATCH', '/api/admin/orders/1', { status: 'cancelled' }, adm.token);
  const back = (await call('GET', '/api/products/' + hoodie.id)).j.variants.find(v => v.size === 'M').stock;
  ok(back === 8, 'cancelling an order returns stock');
  r = await call('DELETE', '/api/admin/staff/' + 1, null, adm.token);
  ok(r.s === 400, 'main admin cannot be deleted');
  console.log('\nAll ' + n + ' checks passed.');
  server.close(); process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
