/**
 * Custom feed management. A "feed" is a remote feed.json matching the same
 * schema as catalog/catalog.json (see catalog/catalog.schema.json) — the
 * BYOC model's "point the app at your own feed" path from docs/ARCHITECTURE.md.
 * Feed URLs are stored in the `feeds` table; their content is fetched fresh (and
 * schema-validated) each time the combined catalog is requested, so an
 * updated remote feed shows up without any action here.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const pipeline = require('../../poc/pipeline');

const SCHEMA_PATH = path.join(pipeline.ROOT, 'catalog', 'catalog.schema.json');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const validate = ajv.compile(schema);

async function loadFeeds() {
  const { rows } = await db.query('select id, url, name, added_at from feeds order by added_at');
  return rows.map((r) => ({ id: r.id, url: r.url, name: r.name, addedAt: r.added_at }));
}

const MAX_FEED_BYTES = 5 * 1024 * 1024;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    // Feeds are third-party URLs fetched from inside the network — same SSRF guard as direct downloads.
    let target;
    try { target = pipeline.assertFetchAllowed(url); } catch (err) { reject(err); return; }
    const lib = target.protocol === 'http:' ? http : https;
    lib.get(target, { timeout: 10000, lookup: pipeline.guardedLookup }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (d) => {
        body += d;
        if (body.length > MAX_FEED_BYTES) { res.destroy(); reject(new Error('Feed is larger than 5 MB — refusing')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Feed at ${url} is not valid JSON: ${err.message}`)); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Feed fetch timed out')); });
  });
}

/** Fetches and schema-validates a feed URL; throws with details if invalid. Does not save it. */
async function fetchAndValidateFeed(url) {
  const data = await fetchJson(url);
  if (!validate(data)) {
    const details = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`Feed does not match catalog schema: ${details}`);
  }
  return data;
}

async function addFeed(url, addedBy) {
  if (typeof url !== 'string' || !url || url.length > 2000) throw new Error('A feed URL is required');
  const feeds = await loadFeeds();
  if (feeds.some((f) => f.url === url)) throw new Error('That feed URL is already added');

  const data = await fetchAndValidateFeed(url); // throws if unreachable/invalid; don't save a broken feed
  const feed = { id: crypto.randomUUID(), url, name: String(data.name || url).slice(0, 200), addedAt: new Date().toISOString() };
  await db.query('insert into feeds (id, url, name, added_by) values ($1, $2, $3, $4)', [feed.id, feed.url, feed.name, addedBy || null]);
  return feed;
}

async function removeFeed(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
  await db.query('delete from feeds where id = $1', [id]);
}

/**
 * Returns the default catalog's games plus every stored feed's games,
 * each tagged with which source it came from. A feed that's currently
 * unreachable/invalid is skipped (with a warning attached) rather than
 * failing the whole catalog view.
 */
async function getCombinedCatalog() {
  const defaultCatalog = pipeline.loadCatalog();
  const games = defaultCatalog.games.map((g) => ({ ...g, feedSource: 'default' }));
  const warnings = [];

  for (const feed of await loadFeeds()) {
    try {
      const data = await fetchAndValidateFeed(feed.url);
      for (const g of data.games) games.push({ ...g, feedSource: feed.name });
    } catch (err) {
      warnings.push(`Feed "${feed.name}" (${feed.url}): ${err.message}`);
    }
  }

  return { games, warnings };
}

module.exports = { loadFeeds, addFeed, removeFeed, getCombinedCatalog, fetchAndValidateFeed };
