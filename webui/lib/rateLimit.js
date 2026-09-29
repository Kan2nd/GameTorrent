'use strict';

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_HITS = 5;

// Store requests: { [ip]: [timestamp1, timestamp2, ...] }
const requests = {};

// Clean up old requests periodically
setInterval(() => {
  const now = Date.now();
  for (const ip in requests) {
    requests[ip] = requests[ip].filter(t => now - t < WINDOW_MS);
    if (requests[ip].length === 0) {
      delete requests[ip];
    }
  }
}, WINDOW_MS);

function downloadRateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requests[ip]) {
    requests[ip] = [];
  }
  
  // Filter old requests
  requests[ip] = requests[ip].filter(t => now - t < WINDOW_MS);
  
  if (requests[ip].length >= MAX_HITS) {
    return res.status(429).json({ error: 'Too many downloads, please try again in a minute.' });
  }
  
  requests[ip].push(now);
  next();
}

module.exports = { downloadRateLimiter };
