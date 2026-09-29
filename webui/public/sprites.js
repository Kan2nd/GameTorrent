/*
 * Pixel-art sprites, drawn as ASCII grids and rendered as crisp inline SVG.
 *
 * 'X' paints in currentColor (so an icon takes its text colour and can
 * change on hover/active); every other letter maps to a palette colour
 * below. Rows may be ragged — missing cells are simply transparent.
 *
 *   static HTML :  <span class="sprite" data-sprite="cart"></span>  (filled by render())
 *   JS strings  :  Sprites.html('invader', 'sprite-xl')
 */
(function (root) {
  'use strict';

  var PALETTE = {
    X: 'currentColor',
    b: 'var(--cart, #8f86c9)',
    d: 'var(--cart-dark, #6a61a8)',
    l: 'var(--magenta, #ff3ea5)',
    y: 'var(--yellow, #ffe14d)',
    g: 'var(--gold, #e8b830)',
    c: 'var(--cyan, #3de8ff)',
    w: '#ffffff',
    k: '#000000'
  };

  var SPRITES = {
    // Multi-colour cartridge — the logo / favicon.
    cartLogo: [
      '..bbbbbbbb..',
      '.bbbbbbbbbb.',
      'bbbbbbbbbbbb',
      'bblllllllldb',
      'bblyllllllbb',
      'bblyyllllldb',
      'bblyyyllllbb',
      'bblyyllllldb',
      'bblyllllllbb',
      'bblllllllldb',
      'bbbbbbbbbbbb',
      '.bbbbbbbbbb.',
      '..gg.gg.gg..',
      '..gg.gg.gg..'
    ],
    cart: [
      '.XXXXXX.',
      'XXXXXXXX',
      'X......X',
      'X......X',
      'XXXXXXXX',
      'XXXXXXXX',
      '.X.XX.X.',
      '.X.XX.X.'
    ],
    download: [
      '...XX...',
      '...XX...',
      '...XX...',
      '...XX...',
      '.XXXXXX.',
      '..XXXX..',
      '...XX...',
      'XXXXXXXX'
    ],
    search: [
      '.XXXX...',
      'X....X..',
      'X....X..',
      'X....X..',
      '.XXXXX..',
      '.....XX.',
      '......XX'
    ],
    list: [
      'XX.XXXXX',
      'XX.XXXXX',
      '........',
      'XX.XXXXX',
      'XX.XXXXX',
      '........',
      'XX.XXXXX',
      'XX.XXXXX'
    ],
    pad: [
      '.XXXXXXXX.',
      'XX.XXXXXXX',
      'X...XXXX.X',
      'XX.XXXX.XX',
      'XXXXXXXXXX',
      '.XX....XX.'
    ],
    heart: [
      '.XX..XX.',
      'XXXXXXXX',
      'XXXXXXXX',
      'XXXXXXXX',
      '.XXXXXX.',
      '..XXXX..',
      '...XX...'
    ],
    star: [
      '...XX...',
      '...XX...',
      'XXXXXXXX',
      '.XXXXXX.',
      '..XXXX..',
      '.XXXXXX.',
      '.XX..XX.',
      '.X....X.'
    ],
    check: [
      '........',
      '.......X',
      '......XX',
      'X....XX.',
      'XX..XX..',
      '.XXXX...',
      '..XX....',
      '........'
    ],
    cross: [
      'XX....XX',
      'XXX..XXX',
      '.XXXXXX.',
      '..XXXX..',
      '..XXXX..',
      '.XXXXXX.',
      'XXX..XXX',
      'XX....XX'
    ],
    lock: [
      '..XXXX..',
      '.X....X.',
      '.X....X.',
      'XXXXXXXX',
      'XXXXXXXX',
      'XXX..XXX',
      'XXX..XXX',
      'XXXXXXXX'
    ],
    play: [
      'XX......',
      'XXXX....',
      'XXXXXX..',
      'XXXXXXXX',
      'XXXXXX..',
      'XXXX....',
      'XX......'
    ],
    bolt: [
      '....XXX.',
      '...XXX..',
      '..XXX...',
      '.XXXXXX.',
      '...XXX..',
      '..XXX...',
      '..XX....',
      '.X......'
    ],
    // Classic invader — empty states.
    invader: [
      '..X.....X..',
      '...X...X...',
      '..XXXXXXX..',
      '.XX.XXX.XX.',
      'XXXXXXXXXXX',
      'X.XXXXXXX.X',
      'X.X.....X.X',
      '...XX.XX...'
    ]
  };

  function svg(name) {
    var rows = SPRITES[name];
    if (!rows) return '';
    var w = 0;
    rows.forEach(function (r) { if (r.length > w) w = r.length; });
    var h = rows.length;
    var byColor = {};
    rows.forEach(function (row, y) {
      var x = 0;
      while (x < row.length) {
        var ch = row[x];
        if (ch === '.' || ch === ' ') { x++; continue; }
        var run = 1;
        while (x + run < row.length && row[x + run] === ch) run++;
        (byColor[ch] = byColor[ch] || []).push('M' + x + ' ' + y + 'h' + run + 'v1h-' + run + 'z');
        x += run;
      }
    });
    var paths = Object.keys(byColor).map(function (ch) {
      return '<path style="fill:' + (PALETTE[ch] || 'currentColor') + '" d="' + byColor[ch].join('') + '"/>';
    }).join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h +
      '" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' + paths + '</svg>';
  }

  function html(name, cls) {
    return '<span class="sprite' + (cls ? ' ' + cls : '') + '">' + svg(name) + '</span>';
  }

  /** Fills every <... data-sprite="name"> under `scope` (default: the whole document). */
  function render(scope) {
    (scope || document).querySelectorAll('[data-sprite]').forEach(function (el) {
      el.innerHTML = svg(el.getAttribute('data-sprite'));
    });
  }

  var api = { svg: svg, html: html, render: render, SPRITES: SPRITES, PALETTE: PALETTE };
  root.Sprites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { render(); });
    else render();
  }
})(typeof window !== 'undefined' ? window : globalThis);
