'use strict';

const crypto = require('crypto');

// --- Download limiter (per client IP) ---
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_HITS = 5;

// { [ip]: [timestamp1, timestamp2, ...] }
const requests = {};

setInterval(() => {
  const now = Date.now();
  for (const ip in requests) {
    requests[ip] = requests[ip].filter(t => now - t < WINDOW_MS);
    if (requests[ip].length === 0) {
      delete requests[ip];
    }
  }
}, WINDOW_MS).unref();

function downloadRateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!requests[ip]) requests[ip] = [];
  requests[ip] = requests[ip].filter(t => now - t < WINDOW_MS);
  if (requests[ip].length >= MAX_HITS) {
    return res.status(429).json({ error: 'Too many downloads, please try again in a minute.' });
  }
  requests[ip].push(now);
  next();
}

// --- Failed-login limiter, with device cookies ---
//
// The problem it solves (audit 2026-11-04): the old limiter locked a *username* after 5 failures
// from anywhere, so anyone could lock the admin out by typing 5 wrong passwords for "admin".
// Locking by IP instead doesn't work here either: behind VMware NAT every LAN browser arrives as
// the same address (192.0.2.1), and all Tailscale traffic as one in-cluster address — an IP
// lock would hit everyone on that path.
//
// So this follows OWASP's "device cookie" pattern: a browser that has logged in successfully as a
// user gets a signed cookie naming that user. Attempts that carry a valid device cookie for the
// username being tried are counted per DEVICE; attempts without one ("untrusted") are counted per
// USERNAME. An attacker can exhaust the untrusted bucket for "admin", but the real admin's browser
// still gets in. Guessing is still capped: 5 tries per 15 min per username for untrusted clients,
// 5 per device for trusted ones (after which that cookie stops being trusted).
//
// Attempts are counted when they START, not when they fail. Otherwise 100 parallel requests would
// all pass the check before the first (async, scrypt-slow) failure was recorded.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const IP_FLOOD_MAX = 50;              // per IP, untrusted only — a flood guard, not the main limit
const DEVICE_COOKIE = 'gt.dev';
const DEVICE_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const attempts = new Map(); // key -> [timestamps]
let deviceKey = crypto.randomBytes(32);
let cookieSecure = false;

/** Called once at startup; the key is derived from SESSION_SECRET so device cookies survive restarts. */
function configureLoginLimiter({ secret, secure }) {
  deviceKey = crypto.createHash('sha256').update(`gt-device-cookie|${secret}`).digest();
  cookieSecure = !!secure;
}

function recent(key, now) {
  const list = (attempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) attempts.set(key, list); else attempts.delete(key);
  return list;
}

function sign(payload) {
  return crypto.createHmac('sha256', deviceKey).update(payload).digest('base64url');
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** { username, deviceId } if the request carries a validly signed device cookie, else null. */
function readDeviceCookie(req) {
  const raw = readCookie(req, DEVICE_COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [userB64, deviceId, sig] = parts;
  const expected = sign(`${userB64}.${deviceId}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { username: Buffer.from(userB64, 'base64url').toString('utf8'), deviceId };
}

function loginContext(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const username = String((req.body && req.body.username) || '').toLowerCase().slice(0, 64);
  const device = readDeviceCookie(req);
  const trusted = !!device && device.username.toLowerCase() === username;
  const keys = trusted ? [`dev:${device.deviceId}`] : [`user:${username}`, `ip:${ip}`];
  return { ip, username, trusted, deviceId: trusted ? device.deviceId : null, keys };
}

function loginRateLimiter(req, res, next) {
  const now = Date.now();
  const ctx = loginContext(req);
  const over = ctx.trusted
    ? recent(ctx.keys[0], now).length >= LOGIN_MAX_FAILURES
    : recent(`user:${ctx.username}`, now).length >= LOGIN_MAX_FAILURES || recent(`ip:${ctx.ip}`, now).length >= IP_FLOOD_MAX;
  if (over) {
    return res.status(429).json({
      error: ctx.trusted
        ? 'Too many failed logins from this browser — try again in 15 minutes.'
        : 'Too many failed logins for this account from browsers it hasn\'t signed in from before — try again in 15 minutes, or use a browser you\'ve signed in with.',
    });
  }
  // Count the attempt now (see the comment above about parallel requests); a success removes it.
  for (const k of ctx.keys) attempts.set(k, [...recent(k, now), now]);
  req.loginContext = ctx;
  next();
}

/** Failed attempt: already counted on entry, nothing more to do. Kept so callers read clearly. */
function recordLoginFailure() {}

/** Successful login: un-count this attempt, clear this device's failures, (re)issue the device cookie. */
function recordLoginSuccess(req, res, username) {
  const ctx = req.loginContext;
  if (ctx) {
    for (const k of ctx.keys) {
      const list = attempts.get(k) || [];
      list.pop();
      if (list.length) attempts.set(k, list); else attempts.delete(k);
    }
    if (ctx.trusted) attempts.delete(`dev:${ctx.deviceId}`);
  }
  const userB64 = Buffer.from(String(username), 'utf8').toString('base64url');
  const deviceId = (ctx && ctx.trusted && ctx.deviceId) || crypto.randomBytes(16).toString('base64url');
  res.cookie(DEVICE_COOKIE, `${userB64}.${deviceId}.${sign(`${userB64}.${deviceId}`)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure,
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
    path: '/api/login',
  });
}

setInterval(() => { const now = Date.now(); for (const k of [...attempts.keys()]) recent(k, now); }, LOGIN_WINDOW_MS).unref();

// --- Sign-up limiter ---
// Per IP and server-wide. Per IP alone isn't enough here (all LAN browsers share one NAT address,
// so it's closer to "per network path"); the global cap bounds how fast anyone can create
// accounts at all. With SIGNUP_MODE=approval each one still waits for an admin anyway.
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX_PER_IP = 5;
const SIGNUP_MAX_GLOBAL = 30;
const signups = new Map(); // key -> [timestamps]

function recentSignups(key, now) {
  const list = (signups.get(key) || []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  if (list.length) signups.set(key, list); else signups.delete(key);
  return list;
}

function signupRateLimiter(req, res, next) {
  const now = Date.now();
  const ipKey = `ip:${req.ip || 'unknown'}`;
  if (recentSignups(ipKey, now).length >= SIGNUP_MAX_PER_IP || recentSignups('all', now).length >= SIGNUP_MAX_GLOBAL) {
    return res.status(429).json({ error: 'Too many sign-ups right now. Try again in an hour.' });
  }
  for (const k of [ipKey, 'all']) signups.set(k, [...recentSignups(k, now), now]);
  next();
}

setInterval(() => { const now = Date.now(); for (const k of [...signups.keys()]) recentSignups(k, now); }, SIGNUP_WINDOW_MS).unref();

module.exports = { downloadRateLimiter, loginRateLimiter, recordLoginFailure, recordLoginSuccess, configureLoginLimiter, signupRateLimiter };
