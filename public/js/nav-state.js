/*
 * Scroll behaviour for the site navigation, kept free of the DOM so it can be unit tested.
 * Loaded by views/partials/nav.ejs; also usable from Node (`require`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DEFAULTS = {
    enterAt: 80,     // scrolled further than this: the navigation condenses
    exitAt: 24,      // scrolled back above this: it expands again (the gap prevents flicker near the threshold)
    hideAfter: 200,  // mobile: the slim top bar only hides once the page is scrolled this far
    hideDelta: 10    // mobile: ignore scroll jitter smaller than this many pixels
  };

  function opts(o) {
    var out = {};
    for (var k in DEFAULTS) out[k] = o && o[k] !== undefined ? o[k] : DEFAULTS[k];
    return out;
  }

  /** Hysteresis: condense past `enterAt`, expand only once back above `exitAt`. */
  function nextCondensed(prev, y, o) {
    var c = opts(o);
    if (y < 0) y = 0;
    if (!prev) return y > c.enterAt;
    return y >= c.exitAt;
  }

  /** Mobile top bar: hide while scrolling down, reveal on any upward scroll or near the top. */
  function nextHidden(prevHidden, y, lastY, o) {
    var c = opts(o);
    if (y < 0) y = 0;
    if (y <= c.hideAfter) return false;
    var delta = y - lastY;
    if (Math.abs(delta) < c.hideDelta) return prevHidden;
    return delta > 0;
  }

  /** Same breakpoint the stylesheet uses (Tailwind `lg`). */
  function modeFor(width) {
    return width < 1024 ? 'mobile' : 'desktop';
  }

  return { DEFAULTS: DEFAULTS, nextCondensed: nextCondensed, nextHidden: nextHidden, modeFor: modeFor };
});
