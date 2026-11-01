'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// scrypt password hashing: "salt:hash" (hex). Constant-time compare on verify.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'hex');
  return want.length === hash.length && crypto.timingSafeEqual(hash, want);
}

// Signed token (HMAC-SHA256), format: base64url(payload).base64url(sig)
function secret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const f = path.join(dir, '.secret');
  try { return fs.readFileSync(f, 'utf8'); } catch (_) {}
  fs.mkdirSync(dir, { recursive: true });
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = secret();
const b64 = b => Buffer.from(b).toString('base64url');
function sign(payload, ttlSec = 60 * 60 * 24 * 7) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch (_) { return null; }
}
module.exports = { hashPassword, verifyPassword, sign, verify };
