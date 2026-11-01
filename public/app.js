'use strict';
/* Ghym Store frontend: vanilla JS single-page app. Routes: #/ shop, #/wishlist, #/orders, #/checkout, #/admin */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: k => { try { return localStorage.getItem(k) } catch (_) { return null } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch (_) {} } };

const S = { cfg: null, products: [], cat: 0, q: '', user: null, token: store.get('ghym.token'), cart: { items: [], subtotal: 0 }, wish: new Set(),
  admin: null, atoken: store.get('ghym.atoken'), tab: 'products', adminData: {} };
const money = n => (Number(n) || 0).toFixed(2) + ' ' + (S.cfg?.settings.currency || 'LYD');

/* ---------- API ---------- */
async function api(path, { method = 'GET', body, admin } = {}) {
  const t = admin ? S.atoken : S.token;
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.status = r.status; e.errors = j.errors; e.auth = j.auth_required; throw e; }
  return j;
}
function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = m; $('#toasts').append(t); setTimeout(() => t.remove(), 2800); }

/* ---------- overlays ---------- */
function overlay(html, { center = true, onClose } = {}) {
  const L = $('#layer'); L.innerHTML = `<div class="scrim ${center ? 'center' : ''}" id="scrim">${html}</div>`;
  const close = () => { L.innerHTML = ''; removeEventListener('keydown', k); onClose && onClose(); };
  const k = e => e.key === 'Escape' && close(); addEventListener('keydown', k);
  $('#scrim').onclick = e => { if (e.target.id === 'scrim') close(); };
  L.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  return close;
}
function showErrors(form, errors = {}) {
  form.querySelectorAll('.fe').forEach(e => e.textContent = ''); form.querySelectorAll('.invalid').forEach(e => e.classList.remove('invalid'));
  let first = null;
  for (const [k, m] of Object.entries(errors)) {
    const fe = form.querySelector(`[data-err="${k}"]`); if (fe) { fe.textContent = m; first = first || fe; }
    const inp = form.querySelector(`[name="${k}"]`); if (inp) inp.classList.add('invalid');
  }
  first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- map picker (Leaflet + OpenStreetMap tiles) ---------- */
function mountMap(el, { lat, lng, onChange, store: storePt, picked = true }) {
  if (!window.L) { el.innerHTML = '<div class="note" style="margin:12px">The map could not load. Check your internet connection.</div>'; return { set() {}, locate() { return Promise.reject() } }; }
  const map = L.map(el, { scrollWheelZoom: false }).setView([lat, lng], picked ? 13 : 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const pinIcon = L.divIcon({ className: '', html: '<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;background:#b8455f;border:3px solid #fff;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>', iconSize: [26, 26], iconAnchor: [4, 26] });
  const m = L.marker([lat, lng], { draggable: true, icon: pinIcon, opacity: picked ? 1 : .5 }).addTo(map);
  let line = null, storeM = null;
  if (storePt) { storeM = L.circleMarker([storePt.lat, storePt.lng], { radius: 8, color: '#3a2b30', fillColor: '#fabec9', fillOpacity: 1, weight: 3 }).addTo(map).bindTooltip('Store', { permanent: false });
    line = L.polyline([[storePt.lat, storePt.lng], [lat, lng]], { color: '#b8455f', dashArray: '6 8', weight: 2 }).addTo(map); }
  const emit = (la, ln) => { m.setOpacity(1); if (line) line.setLatLngs([[storePt.lat, storePt.lng], [la, ln]]); onChange(+la.toFixed(6), +ln.toFixed(6)); };
  m.on('dragend', () => { const p = m.getLatLng(); emit(p.lat, p.lng); });
  map.on('click', e => { m.setLatLng(e.latlng); emit(e.latlng.lat, e.latlng.lng); });
  setTimeout(() => map.invalidateSize(), 150);
  return {
    set(la, ln, zoom) { m.setLatLng([la, ln]); map.setView([la, ln], zoom || map.getZoom()); emit(la, ln); },
    locate() { return new Promise((res, rej) => { if (!navigator.geolocation) return rej(new Error('Location is not available on this device.'));
      navigator.geolocation.getCurrentPosition(p => { m.setLatLng([p.coords.latitude, p.coords.longitude]); map.setView([p.coords.latitude, p.coords.longitude], 16); emit(p.coords.latitude, p.coords.longitude); res(); },
        () => rej(new Error('Could not get your location. Allow location access or tap the map instead.')), { enableHighAccuracy: true, timeout: 12000 }); }); },
    fit() { if (storePt) map.fitBounds([[storePt.lat, storePt.lng], m.getLatLng()], { padding: [40, 40], maxZoom: 15 }); }
  };
}
const mapBar = id => `<div class="mapbar"><button type="button" class="btn sm" id="${id}">Use my current location</button><span class="hint">Tap the map or drag the pin to your exact door.</span></div>`;

/* ---------- header ---------- */
function drawHeader() {
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light')) === 'dark';
  $('#top').innerHTML = `<div class="bar"><button class="brand" data-go="/" aria-label="Ghym Store home"><img src="/logo.png" alt="Ghym"></button>
    <div class="search" id="sbox"><input type="text" id="q" placeholder="Search products" aria-label="Search products" value="${esc(S.q)}"></div>
    <div class="acts">
      <button class="ibtn" id="theme" aria-label="Switch theme">${dark ? '☀' : '☾'}</button>
      <button class="ibtn" data-go="/wishlist" aria-label="Wishlist">♡<span class="lbl">Wishlist</span>${S.wish.size ? `<span class="badge">${S.wish.size}</span>` : ''}</button>
      ${S.user ? `<button class="ibtn" id="acc">${esc(S.user.first_name)}</button>` : `<button class="ibtn" id="acc">Sign in</button>`}
      <button class="ibtn primary" id="cartb" aria-label="Cart">Cart${S.cart.items.length ? `<span class="badge">${S.cart.items.reduce((a, i) => a + i.qty, 0)}</span>` : ''}</button>
    </div></div>`;
  $('#top').querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#theme').onclick = () => { const r = document.documentElement; r.dataset.theme = dark ? 'light' : 'dark'; store.set('ghym.theme', r.dataset.theme); drawHeader(); };
  $('#acc').onclick = () => S.user ? accountMenu() : authModal('login');
  $('#cartb').onclick = () => requireAuth(cartSheet);
  $('#q').oninput = e => { S.q = e.target.value; if (!isShop()) go('/'); loadProducts(); };
}
const isShop = () => !location.hash || location.hash === '#/' || location.hash === '#';
const go = p => { location.hash = '#' + p; };
function accountMenu() {
  const close = overlay(`<div class="modal form"><h2>Hi, ${esc(S.user.first_name)}</h2><p class="muted" style="margin:0">@${esc(S.user.username)} · ${esc(S.user.email)}</p>
    <button class="btn" data-go="/orders">My orders</button><button class="btn" data-go="/wishlist">Wishlist</button><button class="btn danger" id="out">Log out</button><button class="btn" data-close>Close</button></div>`);
  $('#layer').querySelectorAll('[data-go]').forEach(b => b.onclick = () => { close(); go(b.dataset.go); });
  $('#out').onclick = () => { S.token = null; S.user = null; S.cart = { items: [], subtotal: 0 }; S.wish = new Set(); store.set('ghym.token', null); close(); drawHeader(); route(); toast('Logged out'); };
}

/* ---------- auth gate: guests must sign up before cart or wishlist ---------- */
function requireAuth(then) { if (S.user) return then(); authModal('register', then); }

function authModal(mode = 'register', then) {
  const close = overlay(`<div class="modal wide" id="am"></div>`);
  const draw = m => { mode = m; $('#am').innerHTML = m === 'login' ? loginHTML() : registerHTML(); (m === 'login' ? bindLogin : bindRegister)(); };
  const done = async d => { S.token = d.token; S.user = d.user; store.set('ghym.token', d.token); await loadUserData(); close(); drawHeader(); route(); toast('Welcome, ' + d.user.first_name); then && then(); };

  const loginHTML = () => `<form class="form" id="lf"><h2>Log in</h2><p class="muted" style="margin:0">New here? <a href="#" id="toReg" style="color:var(--deep);font-weight:700">Create an account</a></p>
    <label>Username<input type="text" name="username" autocomplete="username" autocapitalize="none" required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label><div class="err" id="le" role="alert"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Log in</button></div></form>`;
  const bindLogin = () => {
    $('#toReg').onclick = e => { e.preventDefault(); draw('register'); };
    $('#layer').querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    $('#lf').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
      try { await done(await api('/auth/login', { method: 'POST', body: Object.fromEntries(f) })); } catch (x) { $('#le').textContent = x.message; } };
  };
  const registerHTML = () => `<form class="form" id="rf" novalidate><h2>Create your account</h2>
    <p class="muted" style="margin:0">${then ? 'Sign up to save items and order. ' : ''}Already a customer? <a href="#" id="toLog" style="color:var(--deep);font-weight:700">Log in</a></p>
    <div class="two"><label>First name<input type="text" name="first_name" autocomplete="given-name"><span class="fe" data-err="first_name"></span></label>
    <label>Last name<input type="text" name="last_name" autocomplete="family-name"><span class="fe" data-err="last_name"></span></label></div>
    <label>City<select name="city_id"><option value="">Choose your city</option>${S.cfg.cities.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><span class="fe" data-err="city_id"></span></label>
    <div class="two"><label>Phone number 1<input type="tel" name="phone1" autocomplete="tel" inputmode="tel" placeholder="09XXXXXXXX"><span class="fe" data-err="phone1"></span></label>
    <label>Phone number 2 <span class="hint">(optional)</span><input type="tel" name="phone2" inputmode="tel"><span class="fe" data-err="phone2"></span></label></div>
    <label>Email <span class="hint">(Gmail or iCloud)</span><input type="email" name="email" autocomplete="email" autocapitalize="none" placeholder="name@gmail.com"><span class="fe" data-err="email"></span></label>
    <div class="form" style="gap:8px"><b style="font-size:.88rem">Delivery location</b><div class="map" id="rmap"></div>${mapBar('locBtn')}<span class="hint" id="coords">No pin placed yet.</span><span class="fe" data-err="location"></span></div>
    <label>Username<input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"><span class="hint" id="unHint">Letters, numbers, _ or . (3 to 30)</span><span class="fe" data-err="username"></span></label>
    <div class="two"><label>Password<input type="password" name="password" autocomplete="new-password"><span class="fe" data-err="password"></span></label>
    <label>Confirm password<input type="password" name="confirm_password" autocomplete="new-password"><span class="fe" data-err="confirm_password"></span></label></div>
    <div class="err" id="re" role="alert"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create account</button></div></form>`;
  const bindRegister = () => {
    const f = $('#rf'); let pin = null;
    $('#toLog').onclick = e => { e.preventDefault(); draw('login'); };
    $('#layer').querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    const st = S.cfg.settings, map = mountMap($('#rmap'), { lat: st.store_lat, lng: st.store_lng, picked: false, onChange: (la, ln) => { pin = { lat: la, lng: ln }; $('#coords').textContent = `Pinned: ${la}, ${ln}`; f.querySelector('[data-err=location]').textContent = ''; } });
    $('#locBtn').onclick = () => map.locate().catch(x => toast(x.message));
    let t; f.username.oninput = () => { clearTimeout(t); const u = f.username.value; const h = $('#unHint'); if (u.length < 3) return; t = setTimeout(async () => {
      try { const r = await api('/username-available?u=' + encodeURIComponent(u)); h.className = r.available ? 'ok' : 'err'; h.textContent = r.available ? 'Username is available' : (r.reason === 'invalid' ? 'Use letters, numbers, _ or . and start with a letter' : 'That username is taken'); } catch (_) {} }, 350); };
    f.onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(f)); b.lat = pin?.lat ?? null; b.lng = pin?.lng ?? null;
      $('#re').textContent = ''; const btn = f.querySelector('.primary'); btn.disabled = true;
      try { await done(await api('/auth/register', { method: 'POST', body: b })); } catch (x) { showErrors(f, x.errors || {}); $('#re').textContent = x.errors ? '' : x.message; btn.disabled = false; } };
  };
  draw(mode);
}
async function loadUserData() {
  if (!S.token) return;
  try { const [me, cart, w] = await Promise.all([api('/me'), api('/cart'), api('/wishlist')]); S.user = me.user; S.cart = cart; S.wish = new Set(w.ids); }
  catch (e) { if (e.status === 401) { S.token = null; S.user = null; store.set('ghym.token', null); } }
}

/* ---------- shop ---------- */
const thumb = p => p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="mono">${esc((p.name || '?')[0].toUpperCase())}</span>`;
const priceHTML = p => p.discount_percent > 0 ? `${money(p.final_price)}<s>${money(p.price)}</s>` : money(p.price);
async function loadProducts() {
  const qs = new URLSearchParams(); if (S.cat) qs.set('category', S.cat); if (S.q) qs.set('q', S.q);
  try { S.products = await api('/products?' + qs); } catch (_) { S.products = []; }
  if (isShop()) drawGrid();
}
function card(p) {
  const out = p.total_stock <= 0;
  return `<article class="card"><button class="ph" data-open="${p.id}" aria-label="View ${esc(p.name)}">${thumb(p)}${out ? '<span class="tag out">Sold out</span>' : p.discount_percent > 0 ? `<span class="tag sale">-${+p.discount_percent}%</span>` : ''}</button>
    <button class="heart ${S.wish.has(p.id) ? 'on' : ''}" data-wish="${p.id}" aria-label="Save to wishlist" aria-pressed="${S.wish.has(p.id)}">${S.wish.has(p.id) ? '♥' : '♡'}</button>
    <div class="cb"><span class="cat">${esc(p.category || '')}</span><h3>${esc(p.name)}</h3><div class="row"><span class="price num">${priceHTML(p)}</span><button class="btn primary sm" data-open="${p.id}" ${out ? 'disabled' : ''}>${out ? 'Sold out' : 'Add'}</button></div></div></article>`;
}
function bindCards(root) {
  root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => productModal(+b.dataset.open));
  root.querySelectorAll('[data-wish]').forEach(b => b.onclick = () => toggleWish(+b.dataset.wish));
}
function toggleWish(id) {
  requireAuth(async () => {
    try { if (S.wish.has(id)) { await api('/wishlist/' + id, { method: 'DELETE' }); S.wish.delete(id); } else { await api('/wishlist/' + id, { method: 'POST' }); S.wish.add(id); toast('Saved to wishlist'); }
      drawHeader(); route(); } catch (e) { toast(e.message); } });
}
function drawGrid() {
  const g = $('#grid'); if (!g) return;
  g.innerHTML = S.products.length ? S.products.map(card).join('') : `<div class="empty"><h3>Nothing found</h3><p class="muted">Try another word or category.</p></div>`;
  $('#count').textContent = S.products.length + ' item' + (S.products.length === 1 ? '' : 's'); bindCards(g);
}
function shopView() {
  $('#app').innerHTML = `<section class="hero"><h1>Soft finds for everyday life.</h1><p>Browse freely. Create an account when you are ready to save or order.</p>
    <div class="chips" role="group" aria-label="Categories"><button class="chip" data-c="0" aria-pressed="${!S.cat}">All</button>${S.cfg.categories.map(c => `<button class="chip" data-c="${c.id}" aria-pressed="${S.cat === c.id}">${esc(c.name)}</button>`).join('')}</div></section>
    <div class="sec"><h2>Products</h2><span class="muted num" id="count"></span></div><div class="grid" id="grid"></div><p class="muted" style="margin-top:40px;font-size:.85rem">© Ghym Store · <a href="#/admin" style="color:var(--muted)">Staff</a></p>`;
  $('#app').querySelectorAll('[data-c]').forEach(b => b.onclick = () => { S.cat = +b.dataset.c; shopView(); loadProducts(); });
  drawGrid();
}
function productModal(id) {
  const p = S.products.find(x => x.id === id) || S.wishProducts?.find(x => x.id === id); if (!p) return;
  let sel = null;
  const close = overlay(`<div class="modal form"><div class="cols"><div class="ph" style="border-radius:16px">${thumb(p)}</div><div class="form" style="align-content:start"><span class="cat">${esc(p.category || '')}</span><h2>${esc(p.name)}</h2>
    <div class="price num big">${priceHTML(p)}</div><p class="muted" style="margin:0">${esc(p.description)}</p>
    <b style="font-size:.88rem">${p.variants.length === 1 && p.variants[0].size === 'Standard' ? 'Availability' : 'Size'}</b>
    <div class="opts" id="opts">${p.variants.map(v => `<button class="opt" data-v="${v.id}" aria-pressed="false" ${v.stock <= 0 ? 'disabled' : ''}>${esc(v.size)}${v.stock > 0 && v.stock <= 3 ? ` <small>(${v.stock} left)</small>` : ''}</button>`).join('')}</div>
    <div class="err" id="pe"></div><div style="display:flex;gap:8px"><button class="btn primary" id="addc" style="flex:1">Add to cart</button><button class="btn" id="wl" aria-label="Wishlist">${S.wish.has(p.id) ? '♥' : '♡'}</button></div><button class="btn" data-close>Close</button></div></div></div>`);
  const opts = $('#opts'); const only = p.variants.filter(v => v.stock > 0); if (only.length === 1) { sel = only[0].id; opts.querySelector(`[data-v="${sel}"]`).setAttribute('aria-pressed', 'true'); }
  opts.querySelectorAll('.opt').forEach(b => b.onclick = () => { sel = +b.dataset.v; opts.querySelectorAll('.opt').forEach(o => o.setAttribute('aria-pressed', o === b)); $('#pe').textContent = ''; });
  $('#wl').onclick = () => { close(); toggleWish(p.id); };
  $('#addc').onclick = () => { if (!sel) { $('#pe').textContent = 'Choose a size first.'; return; }
    requireAuth(async () => { try { S.cart = await api('/cart', { method: 'POST', body: { variant_id: sel, qty: 1 } }); close(); drawHeader(); toast('Added to cart'); } catch (e) { toast(e.message); } }); };
}

/* ---------- cart ---------- */
function cartSheet() {
  const draw = () => {
    const c = S.cart;
    $('#sb').innerHTML = c.items.length ? c.items.map(i => `<div class="line"><div class="th">${i.image ? `<img src="${esc(i.image)}" alt="">` : esc(i.name[0])}</div><div style="min-width:0"><b style="overflow-wrap:anywhere">${esc(i.name)}</b><div class="muted">${esc(i.size)} · ${money(i.unit_price)}</div>
      <div class="qty"><button data-m="${i.id}" aria-label="Fewer">−</button><span class="num">${i.qty}</span><button data-p="${i.id}" aria-label="More">+</button></div></div><b class="num">${money(i.line_total)}</b></div>`).join('') : `<div class="empty"><h3>Your cart is empty</h3><p class="muted">Add something you like.</p></div>`;
    $('#sf').innerHTML = c.items.length ? `<div class="tot"><span>Subtotal</span><span class="num">${money(c.subtotal)}</span></div><p class="hint" style="margin:0">Delivery fee is shown at checkout.</p><button class="btn primary" id="chk">Checkout</button>` : '';
    const upd = async (id, q) => { try { S.cart = await api('/cart/' + id, { method: 'PATCH', body: { qty: q } }); drawHeader(); draw(); } catch (e) { toast(e.message); } };
    $('#sb').querySelectorAll('[data-m]').forEach(b => b.onclick = () => upd(b.dataset.m, c.items.find(i => i.id == b.dataset.m).qty - 1));
    $('#sb').querySelectorAll('[data-p]').forEach(b => b.onclick = () => upd(b.dataset.p, c.items.find(i => i.id == b.dataset.p).qty + 1));
    $('#chk') && ($('#chk').onclick = () => { close(); go('/checkout'); });
  };
  const close = overlay(`<aside class="sheet" aria-label="Cart"><div class="sh-h"><h2>Your cart</h2><button class="btn sm" data-close>Close</button></div><div class="sh-b" id="sb"></div><div class="sh-f" id="sf"></div></aside>`, { center: false });
  draw();
}

/* ---------- checkout with live delivery quote ---------- */
function checkoutView() {
  if (!S.user) { go('/'); return authModal('register', () => go('/checkout')); }
  if (!S.cart.items.length) { $('#app').innerHTML = `<div class="sec"><h2>Checkout</h2></div><div class="empty"><h3>Your cart is empty</h3><button class="btn primary" data-go="/">Browse products</button></div>`; $('#app').querySelector('[data-go]').onclick = () => go('/'); return; }
  const st = S.cfg.settings; let pt = { lat: S.user.lat, lng: S.user.lng }, cityId = S.user.city_id, q = null;
  $('#app').innerHTML = `<div class="sec"><h2>Checkout</h2></div><div class="cols"><div class="form"><h3>Delivery location</h3>
    <label>City<select id="city">${S.cfg.cities.map(c => `<option value="${c.id}" ${c.id === cityId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <div class="map" id="cmap"></div>${mapBar('loc2')}</div>
    <div class="form" style="align-content:start"><h3>Order summary</h3><div class="tw" style="padding:6px 14px">${S.cart.items.map(i => `<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)"><span>${i.qty} × ${esc(i.name)} <span class="muted">(${esc(i.size)})</span></span><span class="num">${money(i.line_total)}</span></div>`).join('')}</div>
    <div class="quote" id="quote" aria-live="polite"><span class="muted">Calculating delivery fee…</span></div>
    <button class="btn primary" id="place" disabled>Place order (pay on delivery)</button><div class="err" id="ce" role="alert"></div></div></div>`;
  const render = () => {
    if (!q) return; const sub = S.cart.subtotal;
    $('#quote').innerHTML = `<div class="tot"><span>Subtotal</span><span class="num">${money(sub)}</span></div>
      <div class="tot" style="font-weight:600"><span>Distance from store</span><span class="num">${q.distance_km.toFixed(1)} km</span></div>
      <div class="tot" style="font-weight:600"><span>Delivery fee</span><span class="num">${money(q.delivery_fee)}</span></div>
      <div class="tot big" style="border-top:1px solid var(--line);padding-top:8px"><span>Total</span><span class="num">${money(sub + q.delivery_fee)}</span></div>
      <span class="hint">${q.mode === 'distance' ? `Base ${money(q.base_fee)} + ${q.distance_km.toFixed(1)} km × ${money(q.price_per_km)}` : q.mode === 'city' ? `Fixed price for ${esc(q.city)}` : q.mode === 'city_base' ? `${esc(q.city)} fee + ${q.distance_km.toFixed(1)} km × ${money(q.price_per_km)}` : `Base ${money(q.base_fee)} + ${q.distance_km.toFixed(1)} km × ${money(q.price_per_km)}, never below ${esc(q.city || 'city')} price ${money(q.city_fee ?? q.base_fee)}`}</span>`;
    $('#place').disabled = false;
  };
  let t, seq = 0; const requote = () => { clearTimeout(t); $('#place').disabled = true; t = setTimeout(async () => { const my = ++seq;
    try { const r = await api('/delivery/quote', { method: 'POST', body: { ...pt, city_id: cityId } }); if (my === seq) { q = r; render(); } } catch (e) { $('#quote').innerHTML = `<span class="err">${esc(e.message)}</span>`; } }, 200); };
  const map = mountMap($('#cmap'), { lat: pt.lat, lng: pt.lng, store: { lat: st.store_lat, lng: st.store_lng }, onChange: (la, ln) => { pt = { lat: la, lng: ln }; requote(); } });
  $('#loc2').onclick = () => map.locate().catch(x => toast(x.message));
  $('#city').onchange = e => { cityId = +e.target.value; requote(); };
  setTimeout(() => map.fit && map.fit(), 250); requote();
  $('#place').onclick = async () => { $('#place').disabled = true; $('#ce').textContent = '';
    try { const r = await api('/checkout', { method: 'POST', body: { ...pt, city_id: cityId } }); S.cart = { items: [], subtotal: 0 }; drawHeader();
      $('#app').innerHTML = `<div class="empty" style="margin-top:24px"><h2>Order #${r.order_id} received</h2><p class="muted">Total ${money(r.total)} (delivery ${money(r.delivery_fee)} for ${r.distance_km.toFixed(1)} km). We will call you to confirm. Pay when it arrives.</p><button class="btn primary" data-go="/orders">View my orders</button></div>`; $('#app').querySelector('[data-go]').onclick = () => go('/orders');
    } catch (e) { $('#ce').textContent = e.message; $('#place').disabled = false; } };
}

/* ---------- wishlist & orders ---------- */
async function wishlistView() {
  if (!S.user) { go('/'); return authModal('register'); }
  const w = await api('/wishlist'); S.wishProducts = w.products; S.wish = new Set(w.ids);
  $('#app').innerHTML = `<div class="sec"><h2>Wishlist</h2></div><div class="grid" id="wg">${w.products.length ? w.products.map(card).join('') : '<div class="empty"><h3>Nothing saved yet</h3><p class="muted">Tap the heart on any product.</p></div>'}</div>`; bindCards($('#wg'));
}
async function ordersView() {
  if (!S.user) { go('/'); return authModal('register'); }
  const o = await api('/orders');
  $('#app').innerHTML = `<div class="sec"><h2>My orders</h2></div>${o.length ? o.map(x => `<div class="card" style="padding:16px;margin-bottom:12px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>Order #${x.id}</b><span class="pill ${x.status === 'new' ? 'new' : x.status === 'delivered' ? 'ok' : x.status === 'cancelled' ? 'bad' : ''}">${esc(x.status)}</span></div>
    <div class="muted">${new Date(x.created_at).toLocaleString()}</div><div style="margin:8px 0">${x.items.map(i => `${i.qty} × ${esc(i.name)} (${esc(i.size)})`).join('<br>')}</div>
    <div class="muted num">Delivery ${money(x.delivery_fee)} · ${x.distance_km.toFixed(1)} km</div><b class="num">Total ${money(x.total)}</b></div>`).join('') : '<div class="empty"><h3>No orders yet</h3></div>'}`;
}

/* ---------- admin ---------- */
const PERM_LABEL = { products: 'Products', categories: 'Categories', cities: 'Cities & delivery', orders: 'Orders', settings: 'Store settings' };
const can = p => S.admin && (S.admin.is_super || S.admin.permissions.includes(p));
function adminView() {
  $('#sbox').hidden = true;
  if (!S.admin) {
    $('#app').innerHTML = `<form class="modal form" id="af" style="margin:40px auto"><h2>Admin sign in</h2><label>Username<input type="text" name="username" autocomplete="username" autocapitalize="none"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><div class="err" id="ae" role="alert"></div><button class="btn primary">Sign in</button></form>`;
    $('#af').onsubmit = async e => { e.preventDefault(); try { const r = await api('/admin/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); S.atoken = r.token; S.admin = r.admin; store.set('ghym.atoken', r.token); adminView(); } catch (x) { $('#ae').textContent = x.message; } };
    return;
  }
  const tabs = [['products', 'Products'], ['categories', 'Categories'], ['cities', 'Cities'], ['orders', 'Orders'], ['settings', 'Settings']].filter(([k]) => can(k)); if (S.admin.is_super) tabs.push(['staff', 'Staff']);
  if (!tabs.find(t => t[0] === S.tab)) S.tab = tabs[0]?.[0];
  $('#app').innerHTML = `<div class="sec"><h2>Store control</h2><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="muted">@${esc(S.admin.username)}${S.admin.is_super ? ' (main admin)' : ''}</span><button class="btn sm" id="alo">Sign out</button></div></div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${S.tab === k}">${l}</button>`).join('')}</div><div id="ab" style="margin-top:16px"></div>`;
  $('#alo').onclick = () => { S.admin = null; S.atoken = null; store.set('ghym.atoken', null); adminView(); };
  $('#app').querySelectorAll('[data-t]').forEach(b => b.onclick = () => { S.tab = b.dataset.t; adminView(); });
  ({ products: adminProducts, categories: adminCategories, cities: adminCities, orders: adminOrders, settings: adminSettings, staff: adminStaff }[S.tab] || (() => { }))();
}
const arm = (btn, fn) => btn.onclick = () => { if (!btn.classList.contains('armed')) { btn.classList.add('armed'); btn.textContent = 'Confirm'; setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Delete'; }, 3500); return; } fn(); };
const guard = async fn => { try { await fn(); } catch (e) { if (e.status === 401) { S.admin = null; adminView(); } toast(e.message); } };
async function adminProducts() {
  const [list] = await Promise.all([api('/admin/products', { admin: true }), api('/config').then(c => S.cfg = c)]);
  $('#ab').innerHTML = `<div class="sec" style="margin-top:0"><h3>${list.length} products</h3><button class="btn primary" id="np">+ Add product</button></div><div class="tw"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock by size</th><th></th></tr></thead><tbody>${list.map(p => `<tr><td><div class="pn"><div class="th">${thumb(p)}</div><div><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="pill">Hidden</span>'}</div></div></td><td>${esc(p.category || '-')}</td>
    <td class="num">${p.discount_percent ? `${money(p.final_price)} <span class="pill sale" style="background:var(--warn-bg);color:var(--warn)">-${+p.discount_percent}%</span>` : money(p.price)}</td><td>${p.variants.map(v => `${esc(v.size)}: <b class="num">${v.stock}</b>`).join(' · ')}</td>
    <td><div class="acts2"><button class="btn sm" data-e="${p.id}">Edit</button><button class="btn sm danger" data-d="${p.id}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted" style="text-align:center;padding:28px">No products yet.</td></tr>'}</tbody></table></div>`;
  $('#np').onclick = () => productForm(); $('#ab').querySelectorAll('[data-e]').forEach(b => b.onclick = () => productForm(list.find(p => p.id == b.dataset.e)));
  $('#ab').querySelectorAll('[data-d]').forEach(b => arm(b, () => guard(async () => { await api('/admin/products/' + b.dataset.d, { method: 'DELETE', admin: true }); toast('Product deleted'); adminProducts(); })));
}
function resizeImg(file, max = 700) { return new Promise((res, rej) => { const r = new FileReader(); r.onerror = rej; r.onload = () => { const im = new Image(); im.onerror = rej; im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = im.width * k; c.height = im.height * k; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .82)); }; im.src = r.result; }; r.readAsDataURL(file); }); }
function productForm(p = null) {
  let img = p?.image || ''; const vs = p ? p.variants.map(v => ({ ...v })) : [{ size: 'S', stock: 0 }, { size: 'M', stock: 0 }, { size: 'L', stock: 0 }];
  let sized = p ? !(p.variants.length === 1 && p.variants[0].size === 'Standard') : true;
  const close = overlay(`<form class="modal wide form" id="pf"><h2>${p ? 'Edit product' : 'Add product'}</h2>
    <label>Name<input type="text" name="name" value="${esc(p?.name)}" required></label>
    <div class="two"><label>Price (${esc(S.cfg.settings.currency)})<input type="number" name="price" min="0" step="0.01" value="${p?.price ?? ''}" required></label><label>Discount %<input type="number" name="discount_percent" min="0" max="100" step="1" value="${p?.discount_percent || 0}"></label></div>
    <label>Category<select name="category_id"><option value="">No category</option>${S.cfg.categories.map(c => `<option value="${c.id}" ${p?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label>Description<textarea name="description">${esc(p?.description)}</textarea></label>
    <div class="form" style="gap:8px"><div class="checks"><label><input type="checkbox" id="sz" ${sized ? 'checked' : ''}> This product has sizes</label></div><div id="vbox"></div></div>
    <div style="display:flex;gap:12px;align-items:center"><div class="th" style="width:72px;height:72px" id="pv">${img ? `<img src="${esc(img)}" alt="">` : 'Photo'}</div><input type="file" id="pi" accept="image/*"></div>
    <div class="checks"><label><input type="checkbox" name="active" ${p?.active === false ? '' : 'checked'}> Visible in store</label></div><div class="err" id="pe" role="alert"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  const drawV = () => { $('#vbox').innerHTML = sized ? `${vs.map((v, i) => `<div class="vrow"><label>Size<input type="text" data-s="${i}" value="${esc(v.size)}"></label><label>Stock<input type="number" min="0" data-k="${i}" value="${v.stock}"></label><button type="button" class="btn sm danger" data-r="${i}" aria-label="Remove size">✕</button></div>`).join('')}<button type="button" class="btn sm" id="addv" style="justify-self:start">+ Add size</button>` : `<label>Stock<input type="number" min="0" id="one" value="${vs[0]?.size === 'Standard' ? vs[0].stock : 0}"></label>`;
    $('#vbox').querySelectorAll('[data-s]').forEach(i => i.oninput = () => vs[i.dataset.s].size = i.value); $('#vbox').querySelectorAll('[data-k]').forEach(i => i.oninput = () => vs[i.dataset.k].stock = +i.value);
    $('#vbox').querySelectorAll('[data-r]').forEach(b => b.onclick = () => { vs.splice(b.dataset.r, 1); drawV(); }); $('#addv') && ($('#addv').onclick = () => { vs.push({ size: '', stock: 0 }); drawV(); }); };
  $('#sz').onchange = e => { sized = e.target.checked; if (sized && vs[0]?.size === 'Standard') { vs.length = 0; vs.push({ size: 'S', stock: 0 }, { size: 'M', stock: 0 }, { size: 'L', stock: 0 }); } drawV(); }; drawV();
  $('#pi').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { img = await resizeImg(f); $('#pv').innerHTML = `<img src="${img}" alt="">`; } catch (_) { $('#pe').textContent = 'That file is not a readable image.'; } };
  $('#layer').querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  $('#pf').onsubmit = e => { e.preventDefault(); const f = e.target; const variants = sized ? vs : [{ size: 'Standard', stock: +$('#one').value || 0 }];
    guard(async () => { try { await api(p ? '/admin/products/' + p.id : '/admin/products', { method: p ? 'PUT' : 'POST', admin: true, body: { name: f.name.value, price: f.price.value, discount_percent: f.discount_percent.value, category_id: f.category_id.value, description: f.description.value, image: img, active: f.active.checked, variants } }); close(); toast('Product saved'); adminProducts(); } catch (x) { $('#pe').textContent = x.message; } }); };
}
function simpleList(title, rows, cols, addFn, editFn, delPath, reload) {
  $('#ab').innerHTML = `<div class="sec" style="margin-top:0"><h3>${title}</h3><button class="btn primary" id="add">+ Add</button></div><div class="tw"><table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map(r => r.cells.map ? `<tr>${r.cells.map(c => `<td>${c}</td>`).join('')}<td><div class="acts2"><button class="btn sm" data-e="${r.id}">Edit</button><button class="btn sm danger" data-d="${r.id}">Delete</button></div></td></tr>` : '').join('') || `<tr><td colspan="${cols.length + 1}" class="muted" style="text-align:center;padding:24px">Nothing here yet.</td></tr>`}</tbody></table></div>`;
  $('#add').onclick = addFn; $('#ab').querySelectorAll('[data-e]').forEach(b => b.onclick = () => editFn(b.dataset.e));
  $('#ab').querySelectorAll('[data-d]').forEach(b => arm(b, () => guard(async () => { await api(delPath + b.dataset.d, { method: 'DELETE', admin: true }); toast('Deleted'); reload(); })));
}
function miniForm(title, fields, onSave) {
  const close = overlay(`<form class="modal form" id="mf"><h2>${title}</h2>${fields.map(f => `<label>${f.label}<input type="${f.type || 'text'}" name="${f.name}" value="${esc(f.value ?? '')}" ${f.step ? `step="${f.step}"` : ''} ${f.type === 'number' ? 'min="0"' : ''}></label>`).join('')}${fields.some(f => f.name === 'active') ? '' : ''}<div class="err" id="me" role="alert"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  $('#layer').querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  $('#mf').onsubmit = async e => { e.preventDefault(); try { await onSave(Object.fromEntries(new FormData(e.target))); close(); } catch (x) { $('#me').textContent = x.message; } };
}
async function adminCategories() {
  const rows = await api('/config').then(c => (S.cfg = c).categories); const reload = adminCategories;
  simpleList('Categories', rows.map(c => ({ id: c.id, cells: [esc(c.name)] })), ['Name'], () => miniForm('Add category', [{ label: 'Name', name: 'name' }], async b => { await api('/admin/categories', { method: 'POST', admin: true, body: b }); reload(); }),
    id => { const c = rows.find(x => x.id == id); miniForm('Rename category', [{ label: 'Name', name: 'name', value: c.name }], async b => { await api('/admin/categories/' + id, { method: 'PUT', admin: true, body: b }); reload(); }); }, '/admin/categories/', reload);
}
async function adminCities() {
  const rows = await api('/admin/cities', { admin: true }); const reload = adminCities;
  simpleList('Cities and delivery prices', rows.map(c => ({ id: c.id, cells: [esc(c.name), `<span class="num">${money(c.delivery_fee)}</span>`, c.active ? '<span class="pill ok">Shown</span>' : '<span class="pill">Hidden</span>'] })), ['City', 'Delivery price', 'Status'],
    () => miniForm('Add city', [{ label: 'City name', name: 'name' }, { label: 'Delivery price', name: 'delivery_fee', type: 'number', step: '0.01', value: 0 }], async b => { await api('/admin/cities', { method: 'POST', admin: true, body: b }); reload(); }),
    id => { const c = rows.find(x => x.id == id); miniForm('Edit city', [{ label: 'City name', name: 'name', value: c.name }, { label: 'Delivery price', name: 'delivery_fee', type: 'number', step: '0.01', value: c.delivery_fee }, { label: 'Shown to customers (1 = yes, 0 = hide)', name: 'active', type: 'number', value: c.active }], async b => { b.active = b.active !== '0'; await api('/admin/cities/' + id, { method: 'PUT', admin: true, body: b }); reload(); }); }, '/admin/cities/', reload);
}
async function adminOrders() {
  const o = await api('/admin/orders', { admin: true });
  $('#ab').innerHTML = `<div class="tw"><table><thead><tr><th>#</th><th>Customer</th><th>Items</th><th>Delivery</th><th>Total</th><th>Status</th></tr></thead><tbody>${o.map(x => `<tr><td>${x.id}</td><td><b>${esc(x.first_name + ' ' + x.last_name)}</b><br><span class="muted">${esc(x.phone1)}${x.phone2 ? ' / ' + esc(x.phone2) : ''}<br>${esc(x.city || '')}</span><br><a href="https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lng}#map=16/${x.lat}/${x.lng}" target="_blank" rel="noopener" style="color:var(--deep);font-weight:700">Open map pin</a></td>
    <td>${x.items.map(i => `${i.qty}× ${esc(i.name)} (${esc(i.size)})`).join('<br>')}</td><td class="num">${x.distance_km.toFixed(1)} km<br>${money(x.delivery_fee)}</td><td class="num">${money(x.total)}</td>
    <td><select data-s="${x.id}" aria-label="Status" style="min-height:36px">${['new', 'confirmed', 'delivered', 'cancelled'].map(s => `<option ${x.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">No orders yet.</td></tr>'}</tbody></table></div>`;
  $('#ab').querySelectorAll('[data-s]').forEach(s => s.onchange = () => guard(async () => { try { await api('/admin/orders/' + s.dataset.s, { method: 'PATCH', admin: true, body: { status: s.value } }); toast('Status updated'); } catch (e) { adminOrders(); throw e; } }));
}
async function adminSettings() {
  const s = await api('/admin/settings', { admin: true }); let pt = { lat: +s.store_lat, lng: +s.store_lng };
  $('#ab').innerHTML = `<form class="cols" id="sf2"><div class="form"><h3>Store location</h3><div class="map" id="smap"></div>${mapBar('loc3')}<div class="two"><label>Latitude<input type="number" step="any" name="store_lat" value="${s.store_lat}"></label><label>Longitude<input type="number" step="any" name="store_lng" value="${s.store_lng}"></label></div></div>
    <div class="form" style="align-content:start"><h3>Delivery pricing</h3><label>Store name<input type="text" name="store_name" value="${esc(s.store_name)}"></label><label>Currency<input type="text" name="currency" value="${esc(s.currency)}"></label>
    <div class="two"><label>Base fee<input type="number" step="0.01" min="0" name="base_fee" value="${s.base_fee}"></label><label>Price per km<input type="number" step="0.01" min="0" name="price_per_km" value="${s.price_per_km}"></label></div>
    <label>Road factor<input type="number" step="0.01" min="1" max="3" name="road_factor" value="${s.road_factor}"><span class="hint">Roads are longer than a straight line. 1.25 adds 25% to the map distance.</span></label>
    <label>How to combine with city prices<select name="pricing_mode">${[['highest', 'Base + km × price, never below the city price'], ['distance', 'Base + km × price only'], ['city', 'City fixed price only'], ['city_base', 'City price + km × price']].map(([v, l]) => `<option value="${v}" ${s.pricing_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="err" id="se"></div><button class="btn primary">Save settings</button></div></form>`;
  const f = $('#sf2'); const map = mountMap($('#smap'), { lat: pt.lat, lng: pt.lng, onChange: (la, ln) => { f.store_lat.value = la; f.store_lng.value = ln; } });
  $('#loc3').onclick = () => map.locate().catch(x => toast(x.message));
  f.onsubmit = e => { e.preventDefault(); guard(async () => { try { await api('/admin/settings', { method: 'PUT', admin: true, body: Object.fromEntries(new FormData(f)) }); S.cfg = await api('/config'); toast('Settings saved'); } catch (x) { $('#se').textContent = x.message; } }); };
}
async function adminStaff() {
  const rows = await api('/admin/staff', { admin: true });
  const perms = cur => `<div class="checks">${Object.entries(PERM_LABEL).map(([k, l]) => `<label><input type="checkbox" value="${k}" ${cur.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>`;
  $('#ab').innerHTML = `<div class="sec" style="margin-top:0"><h3>Staff accounts</h3><button class="btn primary" id="ns">+ Add staff</button></div><div class="tw"><table><thead><tr><th>Username</th><th>Role</th><th>Privileges</th><th></th></tr></thead><tbody>${rows.map(a => `<tr><td><b>${esc(a.username)}</b></td><td>${a.is_super ? 'Main admin' : 'Staff'}</td><td>${a.is_super ? 'Full access' : a.permissions.map(p => PERM_LABEL[p]).join(', ') || 'None'}</td><td>${a.is_super ? '' : `<div class="acts2"><button class="btn sm" data-e="${a.id}">Edit</button><button class="btn sm danger" data-d="${a.id}">Delete</button></div>`}</td></tr>`).join('')}</tbody></table></div>`;
  const form = (a) => { const close = overlay(`<form class="modal form" id="stf"><h2>${a ? 'Edit ' + esc(a.username) : 'Add staff'}</h2>${a ? '' : '<label>Username<input type="text" name="username" autocapitalize="none"></label>'}<label>${a ? 'New password (leave empty to keep)' : 'Password'}<input type="password" name="password" autocomplete="new-password"></label><b style="font-size:.88rem">Privileges</b>${perms(a?.permissions || [])}<div class="err" id="me"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
    $('#layer').querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    $('#stf').onsubmit = async e => { e.preventDefault(); const f = e.target; const body = { username: f.username?.value, password: f.password.value, permissions: [...f.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value) };
      try { await api(a ? '/admin/staff/' + a.id : '/admin/staff', { method: a ? 'PUT' : 'POST', admin: true, body }); close(); toast('Saved'); adminStaff(); } catch (x) { $('#me').textContent = x.message; } }; };
  $('#ns').onclick = () => form(null); $('#ab').querySelectorAll('[data-e]').forEach(b => b.onclick = () => form(rows.find(a => a.id == b.dataset.e)));
  $('#ab').querySelectorAll('[data-d]').forEach(b => arm(b, () => guard(async () => { await api('/admin/staff/' + b.dataset.d, { method: 'DELETE', admin: true }); toast('Staff deleted'); adminStaff(); })));
}

/* ---------- router ---------- */
async function route() {
  $('#sbox') && ($('#sbox').hidden = false);
  const h = location.hash.replace(/^#/, '') || '/';
  if (h === '/checkout') return checkoutView();
  if (h === '/wishlist') return wishlistView();
  if (h === '/orders') return ordersView();
  if (h === '/admin') return adminView();
  shopView(); loadProducts();
}
addEventListener('hashchange', () => { drawHeader(); route(); scrollTo(0, 0); });
(async function init() {
  const t = store.get('ghym.theme'); if (t) document.documentElement.dataset.theme = t;
  try { S.cfg = await api('/config'); } catch (_) { $('#app').innerHTML = '<div class="empty"><h3>The store could not load</h3><p class="muted">Check your connection and refresh.</p></div>'; return; }
  await loadUserData();
  if (S.atoken) { try { S.admin = (await api('/admin/me', { admin: true })).admin; } catch (_) { S.atoken = null; store.set('ghym.atoken', null); } }
  drawHeader(); route();
})();
