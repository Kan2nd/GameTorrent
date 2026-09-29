'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

// Ensure users.json exists. If not, seed it with WEBUI_USER/WEBUI_PASSWORD as admin.
// Only do this if they are actually set (avoids writing a default admin/password).
function ensureUsersFile() {
  if (!fs.existsSync(USERS_PATH)) {
    const defaultUser = process.env.WEBUI_USER;
    const defaultPass = process.env.WEBUI_PASSWORD;
    if (!defaultUser || !defaultPass) return;
    
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const users = [
      {
        username: defaultUser,
        password: hashPassword(defaultPass),
        role: 'admin',
      }
    ];
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPass) {
  if (!storedPass) return false;
  // Graceful fallback if existing users.json still has plaintext passwords
  if (!storedPass.includes(':')) {
    return timingSafeEqualStrings(password || '', storedPass);
  }
  
  const [salt, hash] = storedPass.split(':');
  try {
    const derivedHash = crypto.scryptSync(password || '', salt, 64).toString('hex');
    return timingSafeEqualStrings(hash, derivedHash);
  } catch (err) {
    return false;
  }
}

ensureUsersFile();

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to load users.json:', err.message);
    return [];
  }
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run a comparison of equal-length buffers so failure timing
    // doesn't leak the correct length via an early return
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function authenticateUser(username, password) {
  // Try to ensure users file is created in case it wasn't available at startup 
  // (e.g. if env vars were loaded right before this route was hit)
  ensureUsersFile();
  
  const users = loadUsers();
  const user = users.find((u) => timingSafeEqualStrings(username || '', u.username));
  
  if (user && verifyPassword(password, user.password)) {
    return user;
  }
  return null;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.authenticated && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin privileges required' });
}

module.exports = { authenticateUser, requireAuth, requireAdmin };
