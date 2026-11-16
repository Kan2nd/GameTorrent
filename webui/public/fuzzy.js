/*
 * Typo-tolerant title matching, shared by the browser (Library filter) and the server (Search tab).
 * One file, no dependencies: it is a plain <script> in the page and a require() on the server.
 *
 *   Fuzzy.score('pokemon emerad', 'Pokémon Emerald (USA) GBA')  ->  0.8   (0 = not a match)
 *   Fuzzy.rank(items, 'legend of zelda', (item) => item.title)  ->  matches, best first
 *
 * What it forgives: capital letters, accents, punctuation, "&" vs "and", plural or possessive
 * 's' ("legend" finds "Legends", "zeldas" finds "Zelda's"), a prefix ("poke" finds "Pokemon"),
 * and one typo in a word of 4+ letters (two in 8+): a missing, extra, wrong or swapped letter.
 * Words must still ALL match (a query of four or more words may miss one), so it narrows a list
 * instead of returning everything.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fuzzy = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // combining accent marks, built from code points so the source stays plain ASCII
  var MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');

  var APOS = new RegExp("['" + String.fromCharCode(0x2019) + "`]", 'g');

  var STOP = { the: 1, of: 1, and: 1, a: 1, an: 1, in: 1, on: 1, to: 1, for: 1 };

  /** Lower case, no accents, "&" -> "and", apostrophes dropped, everything else that is not a letter or digit -> space. */
  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(MARKS, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(APOS, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Plural / possessive 's' removed from words long enough that it is not part of the word ("pass", "bus"). */
  function stem(w) {
    return (w.length > 3 && w.slice(-1) === 's' && w.slice(-2) !== 'ss') ? w.slice(0, -1) : w;
  }

  /** Words of a text, without filler words ("the", "of"...) unless that would leave nothing. */
  function tokens(s) {
    var all = normalize(s).split(' ').filter(Boolean);
    var kept = all.filter(function (w) { return !STOP[w]; });
    return kept.length ? kept : all;
  }

  /** Edit distance with swapped neighbours counting as one; gives up (returns max + 1) once it must exceed `max`. */
  function distance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev2 = null;
    var prev = [];
    var i; var j;
    for (j = 0; j <= b.length; j++) prev.push(j);
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur.push(v);
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  function allowedTypos(len) { return len >= 8 ? 2 : len >= 4 ? 1 : 0; }

  /** How well one query word matches one title word: 1 exact ... 0 none. */
  function wordScore(q, t) {
    if (q === t) return 1;
    var qs = stem(q); var ts = stem(t);
    if (qs === ts) return 0.95;
    if (qs.length >= 3 && (t.indexOf(qs) === 0 || ts.indexOf(qs) === 0)) return 0.85;   // "poke" -> "pokemon", "legend" -> "legends"
    var typos = allowedTypos(qs.length);
    if (typos && distance(qs, ts, typos) <= typos) return 0.7;
    if (typos && t.length > qs.length && distance(qs, t.slice(0, qs.length + 1), typos) <= typos && qs.length >= 5) return 0.6;  // typo inside the start of a longer word
    return 0;
  }

  /** 0 when `text` does not match `query`, otherwise 0..1 (higher = closer). */
  function score(query, text) {
    var q = tokens(query);
    if (!q.length) return 1;                       // nothing typed: everything matches
    var nt = normalize(text);
    var t = tokens(text);
    if (!t.length) return 0;
    var total = 0;
    var missed = 0;
    for (var i = 0; i < q.length; i++) {
      var best = 0;
      for (var j = 0; j < t.length; j++) {
        var s = wordScore(q[i], t[j]);
        if (s > best) best = s;
        if (best === 1) break;
      }
      if (!best && q[i].length >= 3 && nt.indexOf(q[i]) !== -1) best = 0.6;   // inside a glued-together word
      if (!best && /^[0-9]+$/.test(q[i])) return 0;   // a number must match: "Country 2" is not "Country 3"
      if (!best) missed++;
      total += best;
    }
    if (missed > (q.length >= 4 ? 1 : 0)) return 0;
    // 0.85 for the words, then small bonuses so a closer title wins a tie: the phrase as typed, at the start, and few extra words.
    var s2 = (total / q.length) * 0.85;
    var nq = normalize(query);
    if (nq && nt.indexOf(nq) !== -1) s2 += 0.07;
    if (nq && nt.indexOf(nq) === 0) s2 += 0.04;
    s2 += 0.04 * Math.min(1, q.length / t.length);
    return Math.min(1, s2);
  }

  /** The items that match `query`, best first (ties keep their original order). */
  function rank(items, query, getText) {
    var text = getText || function (x) { return String(x); };
    if (!tokens(query).length) return items.slice();
    var scored = [];
    items.forEach(function (item, i) {
      var s = score(query, text(item));
      if (s > 0) scored.push({ item: item, s: s, i: i });
    });
    scored.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); });
    return scored.map(function (x) { return x.item; });
  }

  /**
   * Queries worth sending to an indexer that only matches whole words, for a search that came back thin:
   * the query with plural/possessive 's' removed, each of the two most distinctive (longest) words alone,
   * and the start of the longest word (so "emerad" can still reach "Emerald" on indexers that match prefixes).
   * The results are filtered again with score(), so a broad query cannot flood the list with strangers.
   */
  function fallbackQueries(query) {
    var q = tokens(query).map(stem);
    var norm = normalize(query);
    var out = [];
    function add(x) { if (x && x !== norm && out.indexOf(x) === -1) out.push(x); }
    add(q.join(' '));
    var longest = q.filter(function (w) { return w.length >= 4; }).sort(function (a, b) { return b.length - a.length; });
    if (q.length > 1) longest.slice(0, 2).forEach(add);
    if (longest.length && longest[0].length >= 5) add(longest[0].slice(0, Math.max(4, longest[0].length - 2)));
    return out.slice(0, 4);
  }

  return { normalize: normalize, tokens: tokens, stem: stem, distance: distance, score: score, rank: rank, fallbackQueries: fallbackQueries };
}));
