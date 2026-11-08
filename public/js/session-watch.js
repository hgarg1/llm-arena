/*
 * Session watcher: notices when the visitor's login has ended (idle timeout, cookie cleared, signed out in another
 * tab, admin "force logout") and responds with a short animation instead of a broken page:
 *
 *   - public page    -> the page morphs into its signed-out version in place (no reload, scroll position kept)
 *   - protected page -> a brief "taking you to sign in" moment, then sign-in with a way back to this page
 *
 * It asks GET /auth/session, a read-only endpoint that never extends the session, and only acts on an explicit
 * `authenticated: false`. Network errors, 5xx and odd responses never sign anyone out.
 *
 * The core (createWatcher / classifyProbe) has no DOM dependency so it can be unit tested; `autostart` wires it up.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SessionWatch = api;
    if (root.document) api.autostart(root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    endpoint: '/auth/session',
    loginUrl: '/auth/login',
    pollMs: 60000,          // background re-check cadence while the tab is visible
    minGapMs: 4000,         // never ask more often than this (unless forced by a sign-out signal)
    initialDelayMs: 1500,   // first check after page load (skipped if another tab checked moments ago)
    freshMs: 45000,         // a check by any tab within this window is reused on page load
    expiryGraceMs: 1000,    // check this long after the expected expiry
    maxBackoffMs: 300000,   // ceiling when the status endpoint is failing
    animationMs: 1400,      // minimum time the "session ended" moment is shown
    redirectDelayMs: 900    // pause on "taking you to sign in" before navigating
  };

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) for (var k in arguments[i]) if (Object.prototype.hasOwnProperty.call(arguments[i], k)) target[k] = arguments[i][k];
    return target;
  }

  /**
   * Decides what to do with the fresh copy of the current page fetched without a login:
   *  - 401/403, or redirected to a different path -> the page needs a login ("protected")
   *  - 200 on the same path                       -> the page is public, so it can be morphed in place
   *  - anything else                              -> unknown: fall back to a plain reload
   */
  function classifyProbe(info, currentPath) {
    if (info.status === 401 || info.status === 403) return 'protected';
    if (info.redirected) {
      var path;
      try { path = new URL(info.url, 'http://x.invalid').pathname; } catch (e) { return 'failed'; }
      return path !== currentPath ? 'protected' : 'failed';
    }
    if (!info.ok) return 'failed';
    if (!/text\/html/i.test(info.contentType || '')) return 'failed';
    return 'public';
  }

  function createWatcher(opts) {
    var cfg = assign({}, DEFAULTS, opts.config || {});
    var env = opts.env;
    var s = { phase: 'active', timer: null, inflight: null, lastCheckAt: -Infinity, failures: 0, expiresLocal: null };

    function clear() { if (s.timer) { env.clearTimeout(s.timer); s.timer = null; } }
    function wait(ms) { return new Promise(function (resolve) { env.setTimeout(resolve, ms); }); }

    function loginHref() {
      return cfg.loginUrl + '?next=' + encodeURIComponent(env.currentPath());
    }

    function nextDelay() {
      if (s.failures) return Math.min(cfg.maxBackoffMs, cfg.pollMs * Math.pow(2, s.failures - 1));
      var delay = cfg.pollMs;
      if (s.expiresLocal != null) delay = Math.min(delay, Math.max(500, s.expiresLocal - env.now() + cfg.expiryGraceMs));
      return delay;
    }

    function schedule(delay) {
      clear();
      s.timer = env.setTimeout(function () { s.timer = null; trigger('timer'); }, Math.max(250, delay));
    }

    function remember() {
      if (!env.storage) return;
      try { env.storage.set('sw:ok', JSON.stringify({ t: env.now(), exp: s.expiresLocal })); } catch (e) { /* storage unavailable */ }
    }

    function fallbackReload() {
      s.phase = 'ended';
      env.ui.redirecting();
      return wait(cfg.redirectDelayMs).then(function () { env.reload(); return 'reloaded'; });
    }

    function expire(reason) {
      s.phase = 'ending';
      clear();
      if (env.channel) env.channel.post({ type: 'ended' });
      env.ui.ending();
      return Promise.all([
        env.probe().then(function (info) { return { kind: classifyProbe(info, env.pathname()), html: info.html }; }, function () { return { kind: 'failed' }; }),
        wait(cfg.animationMs)
      ]).then(function (parts) {
        var outcome = parts[0];
        if (outcome.kind === 'public') {
          return Promise.resolve().then(function () { return env.swap(outcome.html); }).then(function () {
            s.phase = 'ended';
            env.ui.signedOut(loginHref());
            return 'swapped';
          }, fallbackReload);
        }
        if (outcome.kind === 'protected') {
          s.phase = 'ended';
          env.ui.redirecting();
          return wait(cfg.redirectDelayMs).then(function () { env.navigate(loginHref()); return 'redirected'; });
        }
        return fallbackReload();
      });
    }

    function check(reason, force) {
      if (s.inflight) return s.inflight;
      var sinceLast = env.now() - s.lastCheckAt;
      if (!force && sinceLast < cfg.minGapMs) { schedule(cfg.minGapMs - sinceLast + 50); return Promise.resolve('throttled'); }
      s.lastCheckAt = env.now();
      var sentAt = env.now();
      s.inflight = Promise.resolve()
        .then(function () { return env.fetch(cfg.endpoint, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }); })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('status ' + (res && res.status));
          return res.json();
        })
        .then(function (data) {
          if (!data || typeof data.authenticated !== 'boolean') throw new Error('unexpected response');
          return { data: data };
        })
        // Any failure to get a trustworthy answer (network, HTTP error, bad JSON, wrong shape) lands here and is
        // counted and retried; it is never treated as a logout, and it can never stop the watcher.
        .catch(function () { return { error: true }; })
        .then(function (outcome) {
          if (outcome.error) {
            s.failures += 1;
            schedule(nextDelay());
            return 'error';
          }
          var data = outcome.data;
          s.failures = 0;
          if (data.authenticated === false) return expire(reason);
          var remaining = data.expiresAt && data.serverTime ? Date.parse(data.expiresAt) - Date.parse(data.serverTime) : NaN;
          // Measured against the server's own clock so a wrong device clock cannot cause early or late checks.
          s.expiresLocal = isFinite(remaining) ? sentAt + remaining : null;
          remember();
          schedule(nextDelay());
          return 'active';
        })
        .then(function (result) { s.inflight = null; return result; }, function (err) { s.inflight = null; throw err; });
      return s.inflight;
    }

    /** Entry point for every signal (timer, tab focus, network back, 401 seen, other tab...). */
    function trigger(reason, force) {
      if (s.phase !== 'active') return Promise.resolve('ignored');
      // A hidden tab neither polls nor animates; it re-checks the moment it becomes visible.
      if (!env.isVisible() && reason !== 'visible') return Promise.resolve('deferred');
      return check(reason, force);
    }

    function start() {
      var fresh = null;
      if (env.storage) {
        try { fresh = JSON.parse(env.storage.get('sw:ok') || 'null'); } catch (e) { fresh = null; }
      }
      if (fresh && typeof fresh.t === 'number' && env.now() - fresh.t < cfg.freshMs) {
        s.expiresLocal = typeof fresh.exp === 'number' ? fresh.exp : null;
        schedule(nextDelay());
      } else {
        schedule(cfg.initialDelayMs + env.random() * 1500);
      }
    }

    function stop() { clear(); s.phase = 'stopped'; }

    function onBroadcast(message) {
      if (message && (message.type === 'ended' || message.type === 'logout')) trigger('broadcast', true);
    }

    return { start: start, stop: stop, trigger: trigger, onBroadcast: onBroadcast, loginHref: loginHref, state: s, config: cfg };
  }

  // ---------------------------------------------------------------- UI

  var LOCK = '<svg class="sw-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<rect x="5" y="11" width="14" height="9.5" rx="2.2"></rect><path class="sw-shackle" d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>';
  var CHECK = '<svg class="sw-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5.5 12.5l4.2 4.2L18.5 7.8"></path></svg>';
  var RING = '<svg class="sw-ring" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle class="sw-ring-track" cx="24" cy="24" r="21"></circle><circle class="sw-ring-arc" cx="24" cy="24" r="21"></circle></svg>';

  function createUi(doc) {
    var toast = null, veil = null, dismissTimer = null;

    function build() {
      if (toast) return;
      veil = doc.createElement('div');
      veil.className = 'sw-veil';
      veil.hidden = true;
      toast = doc.createElement('div');
      toast.className = 'sw-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.hidden = true;
      toast.innerHTML =
        '<div class="sw-icon">' + RING + LOCK + CHECK + '</div>' +
        '<div class="sw-text"><strong class="sw-title"></strong><span class="sw-sub"></span></div>' +
        '<a class="sw-action" hidden>Sign in</a>' +
        '<button type="button" class="sw-close" aria-label="Dismiss" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>' +
        '<div class="sw-bar" aria-hidden="true"></div>';
      doc.body.appendChild(veil);
      doc.body.appendChild(toast);
      toast.querySelector('.sw-close').addEventListener('click', hide);
      toast.addEventListener('mouseenter', pauseDismiss);
      toast.addEventListener('mouseleave', armDismiss);
      toast.addEventListener('focusin', pauseDismiss);
      toast.addEventListener('focusout', armDismiss);
    }

    function show(state, title, sub) {
      build();
      toast.hidden = false;
      toast.setAttribute('data-state', state);
      toast.querySelector('.sw-title').textContent = title;
      toast.querySelector('.sw-sub').textContent = sub;
      // restart the enter animation each time
      toast.classList.remove('is-in');
      void toast.offsetWidth;
      toast.classList.add('is-in');
    }

    function pauseDismiss() { if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; } }
    function armDismiss() {
      pauseDismiss();
      if (toast && toast.getAttribute('data-state') === 'done') dismissTimer = setTimeout(hide, 9000);
    }
    function hide() {
      pauseDismiss();
      if (!toast) return;
      toast.classList.add('is-out');
      setTimeout(function () { if (toast) { toast.hidden = true; toast.classList.remove('is-out', 'is-in'); } }, 260);
    }

    return {
      ending: function () { show('ending', 'Your session has ended', 'Updating the page…'); },
      redirecting: function () {
        show('ending', 'Your session has ended', 'Taking you to sign in…');
        veil.hidden = false;
        void veil.offsetWidth;
        veil.classList.add('is-on');
      },
      signedOut: function (href) {
        show('done', 'You’ve been signed out', 'Sign in again to pick up where you left off.');
        var action = toast.querySelector('.sw-action');
        action.href = href;
        action.hidden = false;
        toast.querySelector('.sw-close').hidden = false;
        armDismiss();
      },
      element: function () { return toast; }
    };
  }

  // ---------------------------------------------------------------- browser wiring

  function autostart(win) {
    var doc = win.document;
    if (win.__sessionWatchStarted) return null;
    var script = doc.currentScript;
    if (script && script.getAttribute('data-signed-in') !== 'true') return null; // only watch pages rendered for a signed-in user
    win.__sessionWatchStarted = true;

    var config = {};
    if (script) {
      if (script.getAttribute('data-endpoint')) config.endpoint = script.getAttribute('data-endpoint');
      if (script.getAttribute('data-login')) config.loginUrl = script.getAttribute('data-login');
    }
    var nativeFetch = win.fetch ? win.fetch.bind(win) : null;
    if (!nativeFetch) return null;
    var reduced = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var ui = createUi(doc);

    var channel = null;
    try {
      if (win.BroadcastChannel) {
        var bc = new win.BroadcastChannel('llm-arena-session');
        channel = { post: function (m) { try { bc.postMessage(m); } catch (e) { /* closed */ } }, listen: function (fn) { bc.onmessage = function (e) { fn(e.data); }; } };
      }
    } catch (e) { channel = null; }
    var storage = null;
    try {
      var ls = win.localStorage;
      ls.setItem('sw:probe', '1'); ls.removeItem('sw:probe');
      storage = { get: function (k) { return ls.getItem(k); }, set: function (k, v) { ls.setItem(k, v); } };
      if (!channel) channel = { post: function (m) { try { ls.setItem('sw:event', JSON.stringify({ m: m, t: Date.now() })); } catch (e) { /* ignore */ } }, listen: function () { /* via storage event below */ } };
    } catch (e) { storage = null; }

    function probe() {
      return nativeFetch(win.location.href, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html', 'X-Session-Watch': '1' } }).then(function (res) {
        var info = { ok: res.ok, status: res.status, redirected: res.redirected, url: res.url, contentType: res.headers.get('content-type') || '' };
        return classifyProbe(info, win.location.pathname) === 'public' ? res.text().then(function (html) { info.html = html; return info; }) : info;
      });
    }

    function swap(html) {
      var parsed = new win.DOMParser().parseFromString(html, 'text/html');
      var selector = 'body > .relative.flex.min-h-screen';
      var current = doc.querySelector(selector);
      var next = parsed.querySelector(selector);
      if (!current || !next) throw new Error('page layout not found');
      Array.prototype.forEach.call(next.querySelectorAll('script'), function (el) { el.parentNode.removeChild(el); }); // page scripts already ran once
      var apply = function () {
        if (win.Alpine) Array.prototype.forEach.call(current.children, function (el) { win.Alpine.destroyTree(el); });
        current.replaceChildren.apply(current, Array.prototype.map.call(next.childNodes, function (n) { return doc.importNode(n, true); }));
        var title = parsed.querySelector('title');
        if (title) doc.title = title.textContent;
        var fresh = parsed.querySelector('meta[name="csrf-token"]');
        var meta = doc.querySelector('meta[name="csrf-token"]');
        if (fresh && meta) meta.setAttribute('content', fresh.getAttribute('content'));
        if (win.Alpine) Array.prototype.forEach.call(current.children, function (el) { win.Alpine.initTree(el); });
        win.dispatchEvent(new win.Event('scroll')); // let the navigation re-measure
      };
      if (doc.startViewTransition && !reduced) return doc.startViewTransition(apply).updateCallbackDone;
      apply();
      return Promise.resolve();
    }

    var watcher = createWatcher({
      config: config,
      env: {
        fetch: nativeFetch,
        now: function () { return Date.now(); },
        random: Math.random,
        setTimeout: function (fn, ms) { return win.setTimeout(fn, ms); },
        clearTimeout: function (id) { win.clearTimeout(id); },
        isVisible: function () { return doc.visibilityState !== 'hidden'; },
        currentPath: function () { return win.location.pathname + win.location.search; },
        pathname: function () { return win.location.pathname; },
        channel: channel,
        storage: storage,
        ui: ui,
        probe: probe,
        swap: swap,
        navigate: function (url) { win.location.assign(url); },
        reload: function () { win.location.reload(); }
      }
    });

    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') watcher.trigger('visible'); });
    win.addEventListener('focus', function () { watcher.trigger('focus'); });
    win.addEventListener('online', function () { watcher.trigger('online', true); });
    win.addEventListener('pageshow', function (e) { if (e.persisted) watcher.trigger('pageshow', true); });
    if (channel) channel.listen(function (m) { watcher.onBroadcast(m); });
    win.addEventListener('storage', function (e) {
      if (e.key === 'sw:event' && e.newValue) { try { watcher.onBroadcast(JSON.parse(e.newValue).m); } catch (err) { /* ignore */ } }
    });
    // Signing out here should be reflected in every other open tab straight away.
    doc.addEventListener('submit', function (e) {
      var form = e.target;
      if (form && form.getAttribute && form.getAttribute('action') === '/auth/logout' && channel) channel.post({ type: 'logout' });
    }, true);

    // Any 401 from the app's own requests is a strong hint the login ended: verify immediately.
    win.fetch = function (input) {
      var result = nativeFetch.apply(null, arguments);
      return result.then(function (res) {
        try {
          if (res.status === 401) {
            var url = new URL(typeof input === 'string' ? input : (input && input.url) || '', win.location.href);
            if (url.origin === win.location.origin && url.pathname !== config.endpoint) watcher.trigger('http-401', true);
          }
        } catch (e) { /* never interfere with the app's own request */ }
        return res;
      });
    };

    watcher.start();
    return watcher;
  }

  return { DEFAULTS: DEFAULTS, classifyProbe: classifyProbe, createWatcher: createWatcher, createUi: createUi, autostart: autostart };
});
