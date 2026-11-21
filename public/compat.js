'use strict';
/*
 * Compatibility for older smart-TV browsers (Tizen, webOS, Android TV, Fire TV
 * builds based on Chrome 38-60). Loaded before everything else:
 *  - fills in fetch, Array.prototype.find, Element.closest/matches/remove
 *  - swaps to a pre-resolved stylesheet when CSS custom properties are missing
 *  - shows any startup error on screen (with the browser version) instead of a
 *    blank page, so problems on a TV can be reported without developer tools
 */
(function () {
  var AP = Array.prototype;
  if (!AP.find) {
    AP.find = function (fn, self) { for (var i = 0; i < this.length; i++) if (fn.call(self, this[i], i, this)) return this[i]; return undefined; };
  }
  var EP = window.Element && Element.prototype;
  if (EP) {
    if (!EP.matches) EP.matches = EP.webkitMatchesSelector || EP.msMatchesSelector || function () { return false; };
    if (!EP.closest) {
      EP.closest = function (sel) { var el = this; while (el && el.nodeType === 1) { if (el.matches(sel)) return el; el = el.parentNode; } return null; };
    }
    if (!EP.remove) EP.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  }

  // Minimal fetch on top of XMLHttpRequest: method, headers, body, json(), text(), ok, status.
  if (!window.fetch && window.Promise) {
    window.fetch = function (url, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(opts.method || 'GET', url, true);
        xhr.withCredentials = opts.credentials === 'include';
        var hd = opts.headers || {};
        Object.keys(hd).forEach(function (k) { xhr.setRequestHeader(k, hd[k]); });
        xhr.onload = function () {
          var text = xhr.responseText;
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status,
            text: function () { return Promise.resolve(text); },
            json: function () { return new Promise(function (ok, bad) { try { ok(JSON.parse(text)); } catch (e) { bad(e); } }); },
            headers: { get: function (n) { return xhr.getResponseHeader(n); } },
          });
        };
        xhr.onerror = function () { reject(new TypeError('Network request failed')); };
        xhr.ontimeout = xhr.onerror;
        xhr.send(opts.body === undefined ? null : opts.body);
      });
    };
  }

  // ---------- performance tier: full (PC) / lite (phones) / basic (TVs, old or weak devices) ----------
  (function () {
    var ua = navigator.userAgent;
    var tv = /SmartTV|SMART-TV|Tizen|Web0S|webOS|NetCast|BRAVIA|HbbTV|AFT[A-Z]|CrKey|Android TV|GoogleTV|Roku|VIDAA|Opera TV|Colt\//i.test(ua);
    var chrome = /Chrome\/(\d+)/.exec(ua);
    var oldEngine = (chrome && Number(chrome[1]) < 90) || !(window.CSS && CSS.supports && CSS.supports('aspect-ratio', '1'));
    var cores = navigator.hardwareConcurrency || 2;
    var mem = navigator.deviceMemory || 4;
    var saveData = !!(navigator.connection && navigator.connection.saveData);
    var reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    var touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    var tier = 'full';
    if (tv || oldEngine || cores <= 2 || mem <= 2 || saveData) tier = 'basic';
    else if (touch || cores <= 4 || mem <= 4 || reduced) tier = 'lite';
    var auto = tier;
    try { var pick = localStorage.getItem('lumio-fx'); if (pick === 'full' || pick === 'lite' || pick === 'basic') tier = pick; } catch (e) { /* storage blocked */ }
    document.documentElement.className += ' fx-' + tier;
    window.LumioTier = tier;
    window.LumioAutoTier = auto;
    /** Switch tier at runtime (Settings, or automatically when the device can't keep up). */
    window.LumioSetTier = function (t, remember) {
      if (remember !== undefined) { try { if (remember) localStorage.setItem('lumio-fx', remember); else localStorage.removeItem('lumio-fx'); } catch (e) { /* storage blocked */ } }
      var el = document.documentElement;
      el.className = el.className.replace(/\bfx-(full|lite|basic)\b/g, '').replace(/\s+/g, ' ') + ' fx-' + t;
      window.LumioTier = t;
    };
  })();

  // No CSS variables (Chrome < 49, old WebKit)? Use the server's pre-resolved stylesheet.
  var cssVars = window.CSS && CSS.supports && CSS.supports('--a', '0');
  if (!cssVars) {
    var link = document.querySelector('link[href="/style.css"]');
    if (link) link.setAttribute('href', '/style.legacy.css');
    document.documentElement.className += ' legacy';
  }

  // Flexbox "gap" (Chrome 84+). Older TV browsers get equivalent margins via .no-flex-gap.
  function detectFlexGap() {
    var f = document.createElement('div');
    f.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    f.appendChild(document.createElement('div'));
    f.appendChild(document.createElement('div'));
    (document.body || document.documentElement).appendChild(f);
    var ok = f.scrollHeight === 1;
    f.parentNode.removeChild(f);
    if (!ok) document.documentElement.className += ' no-flex-gap';
  }
  if (document.body) detectFlexGap(); else document.addEventListener('DOMContentLoaded', detectFlexGap);

  function showError(msg) {
    var box = document.getElementById('lumio-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'lumio-error';
      box.className = 'boot-error';
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = '';
    var h = document.createElement('strong'); h.textContent = 'Lumio couldn’t start on this browser';
    var p = document.createElement('p'); p.textContent = msg;
    var ua = document.createElement('p'); ua.className = 'ua'; ua.textContent = navigator.userAgent;
    box.appendChild(h); box.appendChild(p); box.appendChild(ua);
  }
  // Tell the server (it logs this only while diagnostics are on; never shown to others).
  function report(msg) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/diag', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({ msg: String(msg).slice(0, 800), page: location.pathname }));
    } catch (e2) { /* diagnostics are best effort */ }
  }
  /** Lumio's own startup failures (caught by try/catch, so the real message is known). */
  window.LumioFail = function (where, err) {
    var msg = where + ': ' + ((err && err.message) || err) + (err && err.stack ? ' | ' + String(err.stack).split('\n').slice(0, 3).join(' / ') : '');
    report(msg);
    showError(msg);
  };
  window.LumioShowError = showError;
  window.LumioReport = report;
  window.addEventListener('error', function (e) {
    if (!e) return;
    var ours = e.filename && e.filename.indexOf(location.origin + '/') === 0;
    // TV browsers inject their own scripts; their errors arrive as a bare "Script error."
    // with no file. Log them for diagnosis, but don't alarm the viewer.
    if (!ours) { report('foreign: ' + (e.message || 'unknown')); return; }
    report(e.message + ' (' + e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno + ')');
    showError(e.message + ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')');
  });
  if (!window.Promise) {
    document.addEventListener('DOMContentLoaded', function () { showError('This browser is too old for Lumio (no Promise support). Try the TV’s app store for a newer browser, or cast from a phone.'); });
  }
})();
