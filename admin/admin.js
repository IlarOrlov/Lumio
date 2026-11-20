'use strict';
/* Lumio admin console. All data is rendered with textContent (no innerHTML). */
(function () {
  var root = document.getElementById('root');
  var csrf = '';
  var status = null;
  var page = 'overview';
  var pollTimer = null;

  // ---------- helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM: allowed under the strict CSP
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function api(path, body) {
    var o = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      o.method = 'POST';
      o.headers['Content-Type'] = 'application/json';
      o.headers['X-Lumio-CSRF'] = csrf;
      o.body = JSON.stringify(body);
    }
    return fetch(path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && path !== '/api/auth') { showLocked(); throw new Error('locked'); }
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }
  function toast(msg, bad) {
    var t = h('div', { class: 'toast ' + (bad ? 'err' : ''), text: msg, role: 'status' });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }
  function bytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB']; var i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 0) + ' ' + u[i];
  }
  function ago(ts) {
    if (!ts) return 'never';
    var d = (Date.now() - ts) / 1000;
    if (d < 90) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    return Math.round(d / 86400) + ' days ago';
  }
  function fmtTime(s) {
    s = Math.floor(s || 0); var hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60);
    return hh ? hh + 'h ' + mm + 'm' : mm + 'm';
  }
  function busy(btn, promise) {
    btn.disabled = true;
    return promise.finally(function () { btn.disabled = false; });
  }
  function toggle(checked, onchange, label) {
    var input = h('input', { type: 'checkbox', checked: checked, 'aria-label': label, onchange: function () { onchange(input.checked, input); } });
    return h('label', { class: 'switch' }, input, h('span'));
  }
  function field(label, input, hint) {
    return h('label', { class: 'f' }, label, input, hint ? h('span', { class: 'hint', text: hint }) : null);
  }
  function refreshStatus() {
    return api('/api/status').then(function (s) { status = s; return s; });
  }

  // ---------- auth ----------
  function showLocked() {
    clearInterval(pollTimer);
    root.textContent = '';
    root.appendChild(h('div', { class: 'center' }, h('div', null,
      h('img', { src: '/icon.svg', width: '64', height: '64', alt: '' }),
      h('h1', { text: 'Lumio Admin is locked' }),
      h('p', { class: 'muted', text: 'For your security the admin console only opens from the Lumio icon on this computer\'s desktop. Double-click it to sign in.' }))));
  }
  function boot() {
    var m = /[#&]key=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
    history.replaceState(null, '', '/');
    var p = m ? api('/api/auth', { token: m[1] }) : api('/api/session');
    p.then(function (d) { csrf = d.csrf; return refreshStatus(); })
      .then(function (s) { if (!s.configured) wizard(); else shell(); })
      .catch(function (e) { if (e.message !== 'locked') showLocked(); });
  }

  // ---------- folder picker ----------
  function pickFolder(start) {
    return new Promise(function (resolve) {
      var listEl = h('div', { class: 'body' });
      var pathEl = h('div', { class: 'mono ellipsis' });
      var info = h('span', { class: 'hint' });
      var current = null;
      var useBtn = h('button', { class: 'btn primary', onclick: function () { close(current.path); } }, 'Use this folder');
      function close(v) { modal.remove(); resolve(v || null); }
      function load(p) {
        api('/api/fs?path=' + encodeURIComponent(p || '')).then(function (d) {
          current = d;
          pathEl.textContent = d.path;
          info.textContent = d.videos ? d.videos + ' video file(s) directly in this folder' : 'Videos in sub-folders are found too';
          listEl.textContent = '';
          if (d.parent) listEl.appendChild(h('button', { class: 'dir', onclick: function () { load(d.parent); } }, '⬆', h('span', { text: '.. (up one level)' })));
          d.dirs.forEach(function (name) {
            listEl.appendChild(h('button', { class: 'dir', onclick: function () { load(d.path.replace(/\/$/, '') + '/' + name); } }, '📁', h('span', { class: 'ellipsis', text: name })));
          });
          if (!d.dirs.length) listEl.appendChild(h('p', { class: 'muted small', text: 'No sub-folders here.' }));
        }).catch(function (e) { toast(e.message, true); });
      }
      var modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', onclick: function (e) { if (e.target === modal) close(); } },
        h('div', { class: 'dialog' },
          h('header', null, h('div', { class: 'row between' }, h('strong', { text: 'Choose a folder' }),
            h('button', { class: 'btn sm', onclick: function () { load(current && current.home); } }, '🏠 Home')), pathEl, info),
          listEl,
          h('footer', null, h('button', { class: 'btn', onclick: function () { close(); } }, 'Cancel'), useBtn)));
      document.body.appendChild(modal);
      load(start);
    });
  }

  // ---------- setup wizard ----------
  function wizard() {
    var st = { step: 0, password: '', dirs: [], port: 8443, https: true, publicHost: '' };
    function render() {
      root.textContent = '';
      var bar = h('div', { class: 'steps-bar' }, [0, 1, 2].map(function (i) { return h('span', { class: i <= st.step ? 'on' : '' }); }));
      var body;
      var err = h('p', { class: 'err', role: 'alert' });
      if (st.step === 0) {
        var p1 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '256' });
        var p2 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '256' });
        body = [h('h2', { text: '1. Household password' }),
          h('p', { class: 'muted', text: 'Everyone in your home uses this password once per device. Make it long; a short sentence works well.' }),
          h('div', { class: 'grid2' }, field('Password (min 12 characters)', p1), field('Repeat password', p2)), err,
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: function () {
            if (p1.value.length < 12) { err.textContent = 'Use at least 12 characters.'; return; }
            if (p1.value !== p2.value) { err.textContent = 'The passwords don\'t match.'; return; }
            st.password = p1.value; st.step = 1; render();
          } }, 'Next →'))];
      } else if (st.step === 1) {
        var list = h('div', { class: 'list' }, st.dirs.map(function (d, i) {
          return h('div', { class: 'item' }, h('span', { class: 'mono grow ellipsis', text: d }),
            h('button', { class: 'btn sm danger', onclick: function () { st.dirs.splice(i, 1); render(); } }, 'Remove'));
        }));
        body = [h('h2', { text: '2. Where are your movies and series?' }),
          h('p', { class: 'muted', text: 'Pick the folders that contain your MKV / MP4 files. Sub-folders are included automatically.' }),
          st.dirs.length ? list : h('p', { class: 'hint', text: 'No folders yet.' }),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: function () {
            pickFolder(st.dirs[0]).then(function (p) { if (p && st.dirs.indexOf(p) < 0) { st.dirs.push(p); render(); } });
          } }, '📁 Add folder…')), err,
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: function () { st.step = 0; render(); } }, '← Back'),
            h('button', { class: 'btn primary', onclick: function () {
              if (!st.dirs.length) { err.textContent = 'Add at least one folder.'; return; }
              st.step = 2; render();
            } }, 'Next →'))];
      } else {
        var host = h('input', { type: 'text', value: st.publicHost, placeholder: 'e.g. 192.168.1.20' });
        var port = h('input', { type: 'number', value: String(st.port), min: '1024', max: '65535' });
        var finish = h('button', { class: 'btn primary', onclick: function () {
          st.publicHost = host.value.trim(); st.port = Number(port.value);
          busy(finish, api('/api/password', { password: st.password })
            .then(function () { return api('/api/config', { mediaDirs: st.dirs, port: st.port, https: true, publicHost: st.publicHost }); })
            .then(function (r) { if (r.error) throw new Error(r.error); return refreshStatus(); })
            .then(function () { st.password = ''; shell(); toast('Lumio is running!'); })
            .catch(function (e) { err.textContent = e.message; }));
        } }, 'Finish setup ✓');
        body = [h('h2', { text: '3. How devices reach Lumio' }),
          h('p', { class: 'muted', text: 'Lumio runs inside this virtual machine. Phones and TVs connect to your Windows PC, which forwards the connection here.' }),
          field('Your Windows PC\'s home-network IP address', host, 'On Windows open Command Prompt → "ipconfig" → IPv4 Address of your Wi-Fi/Ethernet adapter. You can fill this in later.'),
          h('div', { class: 'grid2' }, field('Port', port, 'Default 8443')),
          h('p', { class: 'hint', text: 'Lumio always uses HTTPS. Each device shows a one-time certificate warning, which you can accept.' }), err,
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: function () { st.step = 1; render(); } }, '← Back'), finish)];
      }
      root.appendChild(h('div', { class: 'wizard' },
        h('div', { class: 'row' }, h('img', { src: '/icon.svg', width: '44', height: '44', alt: '' }),
          h('div', null, h('h1', { text: 'Welcome to Lumio' }), h('p', { class: 'muted', text: 'Three quick steps and your home cinema is ready.' }))),
        bar, h('div', { class: 'panel' }, body)));
    }
    render();
  }

  // ---------- shell ----------
  var PAGES = [
    ['overview', '🏠', 'Overview'], ['library', '🎞', 'Library'], ['devices', '📱', 'Devices'],
    ['network', '🔒', 'Network & Security'], ['storage', '🗜', 'Storage'], ['logs', '📜', 'Logs'],
  ];
  var mainEl;

  function shell() {
    root.textContent = '';
    var nav = PAGES.map(function (p) {
      return h('button', { class: 'navbtn' + (p[0] === page ? ' active' : ''), 'data-page': p[0], onclick: function () { go(p[0]); } }, p[1], p[2]);
    });
    mainEl = h('main', { class: 'main' });
    root.appendChild(h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, h('img', { src: '/icon.svg', width: '30', height: '30', alt: '' }), h('div', null, 'Lumio', h('small', { text: 'Admin console' }))),
        nav, h('div', { class: 'spacer' }),
        h('button', { class: 'navbtn', onclick: quit }, '⏻', 'Quit Lumio')),
      mainEl));
    go(page);
  }

  function go(p) {
    page = p;
    clearInterval(pollTimer);
    Array.prototype.forEach.call(document.querySelectorAll('.navbtn[data-page]'), function (b) { b.classList.toggle('active', b.dataset.page === p); });
    var fn = { overview: overview, library: library, devices: devices, network: network, storage: storage, logs: logs }[p];
    Promise.resolve(fn()).then(function (nodes) {
      mainEl.textContent = '';
      (function add(list) {
        list.forEach(function (n) { if (Array.isArray(n)) add(n); else if (n) mainEl.appendChild(n); });
      })(nodes);
    }).catch(function (e) { if (e.message !== 'locked') { mainEl.textContent = ''; mainEl.appendChild(h('p', { class: 'err', text: e.message })); } });
  }

  function quit() {
    if (!confirm('Quit Lumio? Streaming stops on all devices until you open Lumio again.')) return;
    api('/api/server', { action: 'quit' }).finally(function () {
      root.textContent = '';
      root.appendChild(h('div', { class: 'center' }, h('div', null, h('h1', { text: 'Lumio has stopped' }), h('p', { class: 'muted', text: 'Double-click the Lumio icon to start it again. You can close this tab.' }))));
    });
  }

  function statusPill(s) {
    if (s.running) return h('span', { class: 'pill ok', text: 'Streaming' });
    if (s.error) return h('span', { class: 'pill bad', text: 'Error' });
    return h('span', { class: 'pill off', text: 'Stopped' });
  }

  // ---------- overview ----------
  function overview() {
    return refreshStatus().then(function (s) {
      var c = s.config;
      pollTimer = setInterval(function () { if (page === 'overview') refreshStatus().then(function () { go('overview'); }); }, 10000);
      var ctl = s.running
        ? [h('button', { class: 'btn', onclick: function (e) { busy(e.target, api('/api/server', { action: 'restart' })).then(function () { go('overview'); }); } }, '↻ Restart'),
          h('button', { class: 'btn danger', onclick: function (e) { busy(e.target, api('/api/server', { action: 'stop' })).then(function () { go('overview'); }); } }, '■ Stop streaming')]
        : [h('button', { class: 'btn primary', onclick: function (e) { busy(e.target, api('/api/server', { action: 'start' })).then(function () { go('overview'); }); } }, '▶ Start streaming')];
      var lib = s.library || { movies: 0, shows: 0, episodes: 0, bytes: 0 };
      var warnings = [];
      if (s.error) warnings.push(h('div', { class: 'panel' }, h('strong', { class: 'err', text: 'Lumio couldn\'t start: ' }), s.error));
      if (!c.publicHost) {
        warnings.push(h('div', { class: 'panel' }, h('strong', { text: '⚠ Add your Windows PC\'s IP address' }),
          h('p', { class: 'muted', text: 'Phones and TVs reach Lumio through your Windows PC. Enter its address so the link and certificate match.' }),
          h('button', { class: 'btn', onclick: function () { go('network'); } }, 'Open Network & Security')));
      } else if (c.https && c.cert && !c.cert.coversPublicHost) {
        warnings.push(h('div', { class: 'panel' }, h('strong', { text: '⚠ Certificate doesn\'t include ' + c.publicHost }),
          h('p', null, h('button', { class: 'btn', onclick: function (e) { busy(e.target, api('/api/cert', {})).then(function () { toast('Certificate renewed'); go('overview'); }); } }, 'Fix certificate'))));
      }
      return [
        h('div', { class: 'head' }, h('div', null, h('h1', { text: 'Overview' }), h('span', { class: 'muted small', text: s.running ? 'Up since ' + new Date(s.startedAt).toLocaleTimeString() : '' })),
          h('div', { class: 'row' }, statusPill(s), ctl)),
        h('div', { class: 'panel hl' },
          h('h2', { text: 'Watch on any device in your home' }),
          h('p', { class: 'muted', text: 'Open this address in the browser of your phone, TV, tablet or laptop:' }),
          h('div', { class: 'url mono', text: c.url }),
          h('p', { class: 'hint', text: 'First visit on each device: accept the certificate warning ("Advanced" → "Proceed"), then sign in with the household password.' }),
          h('div', { class: 'row' }, h('a', { class: 'btn', href: 'https://127.0.0.1:' + c.port + '/', target: '_blank', rel: 'noopener noreferrer' }, 'Open Lumio on this computer ↗'))),
        warnings,
        h('div', { class: 'cards' },
          h('div', { class: 'stat' }, h('b', { text: String(lib.movies) }), h('span', { class: 'muted', text: 'Movies' })),
          h('div', { class: 'stat' }, h('b', { text: String(lib.shows) }), h('span', { class: 'muted', text: 'Series (' + lib.episodes + ' episodes)' })),
          h('div', { class: 'stat' }, h('b', { text: bytes(lib.bytes) }), h('span', { class: 'muted', text: 'Library size' })),
          h('div', { class: 'stat' }, h('b', { text: String(s.activeStreams) }), h('span', { class: 'muted', text: 'Converting now' + (s.transcodes ? ' (' + s.transcodes + ' heavy)' : '') }))),
        h('div', { class: 'panel' }, h('div', { class: 'item' },
          h('div', { class: 'grow' }, h('strong', { text: 'Start Lumio automatically' }),
            h('div', { class: 'hint', text: s.autostart.enabled ? (s.autostart.linger ? 'Starts when this computer boots, even before anyone logs in.' : 'Starts when you log in to this computer.') : 'Off: Lumio runs only after you open it from the desktop icon.' })),
          toggle(s.autostart.enabled, function (on, input) {
            input.disabled = true;
            api('/api/autostart', { enabled: on }).then(function () { toast(on ? 'Autostart enabled' : 'Autostart disabled'); go('overview'); })
              .catch(function (e) { toast(e.message, true); input.checked = !on; input.disabled = false; });
          }, 'Start automatically'))),
      ];
    });
  }

  // ---------- library ----------
  function library() {
    var c = status.config;
    function saveDirs(dirs) {
      return api('/api/config', { mediaDirs: dirs }).then(function (r) { if (r.error) toast(r.error, true); else toast('Saved: library is rescanning'); return refreshStatus(); }).then(function () { go('library'); });
    }
    var dirs = h('div', { class: 'list' }, c.mediaDirs.map(function (d) {
      return h('div', { class: 'item' }, h('span', { class: 'mono grow ellipsis', text: d }),
        h('button', { class: 'btn sm danger', disabled: c.mediaDirs.length === 1, onclick: function () {
          if (confirm('Stop showing videos from ' + d + '? (Files are not deleted.)')) saveDirs(c.mediaDirs.filter(function (x) { return x !== d; }));
        } }, 'Remove'));
    }));
    return api('/api/library').catch(function () { return { movies: [], shows: [] }; }).then(function (lib) {
      return [
        h('div', { class: 'head' }, h('h1', { text: 'Library' }),
          h('button', { class: 'btn', onclick: function (e) { busy(e.target, api('/api/rescan', {})).then(function (l) { toast('Found ' + l.movies + ' movies, ' + l.shows + ' series'); go('library'); }).catch(function (er) { toast(er.message, true); }); } }, '↻ Rescan now')),
        h('div', { class: 'panel' }, h('h2', { text: 'Media folders' }), dirs,
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: function () {
            pickFolder(c.mediaDirs[0]).then(function (p) { if (p && c.mediaDirs.indexOf(p) < 0) saveDirs(c.mediaDirs.concat([p])); });
          } }, '📁 Add folder…')),
          h('details', null, h('summary', { text: 'How to name files so Lumio recognises them' }),
            h('ul', null,
              h('li', null, 'Movies: ', h('code', { text: 'Movies/Inception (2010).mkv' })),
              h('li', null, 'Series: ', h('code', { text: 'Series/Dark/Season 1/Dark S01E01.mkv' })),
              h('li', null, 'Subtitles next to the video: ', h('code', { text: 'Dark S01E01.ru.srt' })),
              h('li', null, 'Optional cover image in the folder: ', h('code', { text: 'poster.jpg' }))))),
        h('div', { class: 'panel' }, h('h2', { text: 'Series (' + lib.shows.length + ')' }),
          lib.shows.length ? h('table', null, h('tr', null, h('th', { text: 'Name' }), h('th', { class: 'num', text: 'Seasons' }), h('th', { class: 'num', text: 'Episodes' }), h('th', { class: 'num', text: 'Size' })),
            lib.shows.map(function (s) { return h('tr', null, h('td', { text: s.name }), h('td', { class: 'num', text: String(s.seasons) }), h('td', { class: 'num', text: String(s.episodes) }), h('td', { class: 'num', text: bytes(s.size) })); }))
            : h('p', { class: 'muted', text: 'No series found yet.' })),
        h('div', { class: 'panel' }, h('h2', { text: 'Movies (' + lib.movies.length + ')' }),
          lib.movies.length ? h('table', null, h('tr', null, h('th', { text: 'Title' }), h('th', { text: 'Year' }), h('th', { text: 'File' }), h('th', { class: 'num', text: 'Size' })),
            lib.movies.map(function (m) { return h('tr', null, h('td', { text: m.title }), h('td', { text: m.year ? String(m.year) : '' }), h('td', { class: 'muted small ellipsis', text: m.file }), h('td', { class: 'num', text: bytes(m.size) })); }))
            : h('p', { class: 'muted', text: 'No movies found yet.' })),
      ];
    });
  }

  // ---------- devices ----------
  function devices() {
    return api('/api/devices').then(function (list) {
      var items = list.map(function (d) {
        var hist = d.history.length ? h('table', null, d.history.map(function (r) {
          return h('tr', null, h('td', { text: r.title }),
            h('td', { class: 'muted', text: r.completed ? 'Watched' : 'Stopped at ' + fmtTime(r.position) + ' of ' + fmtTime(r.duration) }),
            h('td', { class: 'num muted', text: ago(r.updatedAt) }));
        })) : h('p', { class: 'muted small', text: 'Nothing watched yet.' });
        return h('div', { class: 'panel' },
          h('div', { class: 'row between' },
            h('div', null, h('strong', { text: d.name }),
              h('div', { class: 'hint', text: 'Last active ' + ago(d.lastSeen) + ' · added ' + new Date(d.createdAt).toLocaleDateString() + ' · ' + d.watched + ' watched' })),
            h('div', { class: 'row' },
              h('button', { class: 'btn sm', onclick: function () {
                var n = prompt('New name for this device', d.name);
                if (n) api('/api/devices/rename', { id: d.id, name: n }).then(function () { go('devices'); }).catch(function (e) { toast(e.message, true); });
              } }, 'Rename'),
              h('button', { class: 'btn sm danger', onclick: function () {
                if (confirm('Remove "' + d.name + '"? It will be signed out and its watch history deleted.')) api('/api/devices/revoke', { id: d.id }).then(function () { go('devices'); });
              } }, 'Remove'))),
          h('details', null, h('summary', { text: 'Watch history' }), hist));
      });
      return [h('div', { class: 'head' }, h('div', null, h('h1', { text: 'Devices' }), h('p', { class: 'muted', text: 'Every device keeps its own history and resume points.' }))),
        items.length ? h('div', null, items) : h('div', { class: 'panel' }, h('p', { class: 'muted', text: 'No devices yet. Open the Lumio address on a phone or TV and sign in.' }))];
    });
  }

  // ---------- network & security ----------
  function network() {
    return refreshStatus().then(function (s) {
      var c = s.config;
      var host = h('input', { type: 'text', value: c.publicHost, placeholder: 'e.g. 192.168.1.20' });
      var port = h('input', { type: 'number', value: String(c.port), min: '1024', max: '65535' });
      var https = h('input', { type: 'checkbox', checked: c.https });
      var addrErr = h('p', { class: 'err', role: 'alert' });
      var p1 = h('input', { type: 'password', autocomplete: 'new-password' });
      var p2 = h('input', { type: 'password', autocomplete: 'new-password' });
      var signout = h('input', { type: 'checkbox' });
      var pwMsg = h('p', { role: 'status' });
      var nets = h('textarea', { value: c.allowedNetworks.join('\n'), spellcheck: 'false' });
      var hosts = h('textarea', { value: c.allowedHosts.join('\n'), spellcheck: 'false', style: 'min-height:60px' });
      var sd = h('input', { type: 'number', value: String(c.sessionDays), min: '1', max: '3650' });
      var mt = h('input', { type: 'number', value: String(c.maxTranscodes), min: '1', max: '16' });
      var rm = h('input', { type: 'number', value: String(c.rescanMinutes), min: '1', max: '1440' });
      var advMsg = h('p', { role: 'status' });
      function saveCfg(btn, body, msgEl) {
        msgEl.textContent = ''; msgEl.className = '';
        return busy(btn, api('/api/config', body).then(function (r) {
          if (r.error) { msgEl.className = 'err'; msgEl.textContent = 'Saved, but Lumio could not restart: ' + r.error; }
          else { toast('Saved and restarted'); go('network'); }
        }).catch(function (e) { msgEl.className = 'err'; msgEl.textContent = e.message; }));
      }
      var certPanel = c.cert ? [
        h('p', null, 'Valid for: ', c.cert.sans.map(function (x, i) { return h('span', null, i ? ', ' : '', h('code', { text: x })); })),
        h('p', { class: 'hint', text: 'Expires ' + c.cert.validTo }),
        h('p', { class: 'hint mono', text: 'SHA-256 ' + c.cert.fingerprint }),
      ] : [h('p', { class: 'muted', text: 'No certificate yet.' })];
      return [
        h('div', { class: 'head' }, h('h1', { text: 'Network & Security' })),
        h('div', { class: 'panel' }, h('h2', { text: 'Address' }),
          h('div', { class: 'grid2' },
            field('Windows PC IP address (what devices type)', host, 'From "ipconfig" on Windows. The certificate is renewed automatically when this changes.'),
            field('Port', port, 'Must match the VMware port forwarding rule.')),
          h('label', { class: 'check', style: 'margin-top:12px' }, https, h('span', null, h('strong', { text: 'Use HTTPS (recommended)' }), h('div', { class: 'hint', text: 'Encrypts the password and video traffic on your network. Turn off only for very old TVs.' }))),
          h('p', { class: 'hint', text: 'This virtual machine\'s address: ' + (c.vmIps.join(', ') || 'unknown') }), addrErr,
          h('button', { class: 'btn primary', onclick: function (e) { saveCfg(e.target, { publicHost: host.value, port: Number(port.value), https: https.checked }, addrErr); } }, 'Save & restart')),
        h('div', { class: 'panel' }, h('h2', { text: 'Connect from your home network (VMware NAT)' }),
          h('p', { class: 'muted', text: 'Do this once on the Windows PC so phones and TVs can reach Lumio:' }),
          h('ol', { class: 'steps' },
            h('li', null, 'In VMware Workstation open ', h('strong', { text: 'Edit → Virtual Network Editor' }), ' and click ', h('strong', { text: 'Change Settings' }), '.'),
            h('li', null, 'Select ', h('strong', { text: 'VMnet8 (NAT)' }), ' → ', h('strong', { text: 'NAT Settings…' }), ' → ', h('strong', { text: 'Add…' })),
            h('li', null, 'Host port ', h('code', { text: String(c.port) }), ', Type ', h('code', { text: 'TCP' }), ', Virtual machine IP ', h('code', { text: c.vmIps[0] || '(VM IP)' }), ', Virtual machine port ', h('code', { text: String(c.port) }), ' → OK → Apply.'),
            h('li', null, 'When Windows asks about the firewall for vmnat.exe, allow ', h('strong', { text: 'Private networks only' }), '. Make sure your home Wi-Fi is set to ', h('em', { text: 'Private' }), ' in Windows settings.'),
            h('li', null, 'On a phone open ', h('code', { text: c.url }), '.')),
          h('p', { class: 'hint', text: 'Never forward this port on your internet router. Lumio is meant for your home only.' })),
        h('div', { class: 'panel' }, h('h2', { text: 'Certificate' }), certPanel,
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: function (e) { busy(e.target, api('/api/cert', {})).then(function () { toast('New certificate created'); go('network'); }).catch(function (er) { toast(er.message, true); }); } }, '↻ Renew certificate'),
            c.cert ? h('a', { class: 'btn', href: '/api/cert.pem', download: 'lumio.crt' }, '⬇ Download certificate') : null),
          h('p', { class: 'hint', text: 'Optional: install this certificate as trusted on a device to remove the browser warning. Devices can also download it from ' + c.url + '/lumio.crt' })),
        h('div', { class: 'panel' }, h('h2', { text: 'Household password' }),
          h('div', { class: 'grid2' }, field('New password (min 12 characters)', p1), field('Repeat', p2)),
          h('label', { class: 'check', style: 'margin-top:10px' }, signout, h('span', null, 'Sign out all devices (they keep their history when they sign in again with the same name)')),
          pwMsg,
          h('button', { class: 'btn primary', onclick: function (e) {
            pwMsg.className = 'err';
            if (p1.value.length < 12) { pwMsg.textContent = 'Use at least 12 characters.'; return; }
            if (p1.value !== p2.value) { pwMsg.textContent = 'Passwords don\'t match.'; return; }
            busy(e.target, api('/api/password', { password: p1.value, signOutAll: signout.checked })).then(function () {
              p1.value = ''; p2.value = ''; pwMsg.className = 'okmsg'; pwMsg.textContent = 'Password changed.';
            }).catch(function (er) { pwMsg.textContent = er.message; });
          } }, 'Change password')),
        h('div', { class: 'panel' }, h('h2', { text: 'Advanced' }),
          h('div', { class: 'grid2' },
            field('Allowed networks (one per line)', nets, 'Only these address ranges can connect. Defaults cover all home networks.'),
            h('div', null, field('Extra allowed hostnames (one per line)', hosts, 'Only needed if you use a name like lumio.home instead of an IP.'))),
          h('div', { class: 'grid2', style: 'margin-top:12px' },
            field('Stay signed in (days)', sd), field('Max simultaneous heavy conversions', mt, 'Lower on a slow machine.'), field('Rescan folders every (minutes)', rm)),
          advMsg,
          h('button', { class: 'btn primary', onclick: function (e) {
            saveCfg(e.target, {
              allowedNetworks: nets.value.split('\n'), allowedHosts: hosts.value.split('\n'),
              sessionDays: Number(sd.value), maxTranscodes: Number(mt.value), rescanMinutes: Number(rm.value),
            }, advMsg);
          } }, 'Save & restart')),
      ];
    });
  }

  // ---------- storage ----------
  var compactOpts = { crf: 30, preset: 6, audioLangs: '', mode: 'replace', outDir: '', selected: null };

  function storage() {
    return refreshStatus().then(function (s) {
      var cp = s.compact;
      if (cp.phase === 'analyzing' || cp.phase === 'encoding') {
        pollTimer = setInterval(function () { if (page === 'storage') go('storage'); }, 2000);
      }
      var intro = h('div', { class: 'panel' }, h('h2', { text: 'Shrink your library' }),
        h('p', { class: 'muted', text: 'Lumio never copies your videos and keeps no cache, so it uses almost no space itself. To save real space, it can re-encode files to AV1 video and Opus audio: usually 40–60% smaller with the same picture, and played directly by modern phones, TVs and browsers.' }),
        h('p', { class: 'hint', text: 'Every file is checked after converting; if anything looks wrong the original is kept. Converting is slow (roughly real-time per file), so it\'s best left running overnight.' }));
      var nodes = [h('div', { class: 'head' }, h('h1', { text: 'Storage' })), intro];
      if (!s.running) { nodes.push(h('div', { class: 'panel' }, h('p', { class: 'muted', text: 'Start streaming on the Overview page first.' }))); return nodes; }

      if (cp.phase === 'encoding' || (cp.phase === 'done' && cp.results.length)) {
        var cur = cp.current;
        var barSpan = h('span'); barSpan.style.width = (cur ? cur.percent : 100) + '%';
        nodes.push(h('div', { class: 'panel hl' },
          h('h2', { text: cp.phase === 'encoding' ? 'Converting…' : 'Finished' }),
          cur ? h('p', null, h('strong', { text: cur.name }), h('span', { class: 'muted', text: '  (' + cur.index + ' of ' + cur.total + ')  ' + cur.percent.toFixed(1) + '%' + (cur.speed ? ' · ' + cur.speed : '') })) : null,
          h('div', { class: 'bar' }, barSpan),
          h('p', { style: 'margin-top:12px', text: 'Space saved so far: ' + bytes(cp.savedBytes) }),
          cp.error ? h('p', { class: 'err', text: cp.error }) : null,
          h('div', { class: 'list' }, cp.results.map(function (r) {
            return h('div', { class: 'item' }, h('span', { class: 'grow ellipsis', text: r.name }),
              r.ok ? h('span', { class: 'okmsg', text: bytes(r.before) + ' → ' + bytes(r.after) }) : h('span', { class: 'err', text: r.message }));
          })),
          cp.phase === 'encoding'
            ? h('button', { class: 'btn danger', onclick: function () { if (confirm('Cancel? The file being converted is discarded; finished files stay converted.')) api('/api/compact/cancel', {}).then(function () { go('storage'); }); } }, 'Cancel')
            : h('button', { class: 'btn', onclick: function (e) { busy(e.target, api('/api/compact/analyze', { minMb: 50 })).then(function () { go('storage'); }); } }, 'Analyze again')));
        return nodes;
      }

      if (cp.phase === 'analyzing') {
        nodes.push(h('div', { class: 'panel' }, h('p', { class: 'muted', text: 'Analyzing your library…' })));
        return nodes;
      }

      var minMb = h('input', { type: 'number', value: '50', min: '0', style: 'max-width:120px' });
      nodes.push(h('div', { class: 'panel' }, h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: function (e) { busy(e.target, api('/api/compact/analyze', { minMb: Number(minMb.value) })).then(function () { setTimeout(function () { go('storage'); }, 400); }).catch(function (er) { toast(er.message, true); }); } }, '🔍 Analyze library'),
        h('span', { class: 'muted small', text: 'skip files smaller than' }), minMb, h('span', { class: 'muted small', text: 'MB' }))));

      if (cp.phase === 'ready') {
        if (cp.alreadyCompact && cp.alreadyCompact.count) {
          nodes.push(h('div', { class: 'panel' }, h('p', { class: 'okmsg', text: '✓ ' + cp.alreadyCompact.count + ' file(s) (' + bytes(cp.alreadyCompact.bytes) + ') are already efficiently encoded.' }),
            h('p', { class: 'hint', text: 'Their bitrate is so low that converting would save little or nothing and would soften the picture, so Lumio leaves them alone.' })));
        }
        if (!cp.candidates.length) {
          nodes.push(h('div', { class: 'panel' }, h('p', { class: 'okmsg', text: 'Nothing to do: your library is already compact.' })));
          return nodes;
        }
        if (!compactOpts.selected) compactOpts.selected = cp.candidates.map(function (x) { return x.id; });
        var sel = compactOpts.selected;
        var total = h('strong');
        function updTotal() {
          var sum = cp.candidates.filter(function (x) { return sel.indexOf(x.id) >= 0; }).reduce(function (a, x) { return a + x.size; }, 0);
          total.textContent = sel.length + ' file(s), ' + bytes(sum) + ' → about ' + bytes(sum * 0.45) + '–' + bytes(sum * 0.6);
        }
        var rows = cp.candidates.map(function (x) {
          var cb = h('input', { type: 'checkbox', checked: sel.indexOf(x.id) >= 0, onchange: function () {
            var i = sel.indexOf(x.id); if (cb.checked && i < 0) sel.push(x.id); if (!cb.checked && i >= 0) sel.splice(i, 1); updTotal();
          } });
          return h('tr', null, h('td', null, cb), h('td', { class: 'ellipsis', text: x.name }),
            h('td', { text: x.codec.toUpperCase() + (x.height ? ' ' + x.height + 'p' : '') }),
            h('td', { class: 'muted small', text: x.imageSubs ? 'drops ' + x.imageSubs + ' picture-subtitle track(s)' : '' }),
            h('td', { class: 'num', text: bytes(x.size) }));
        });
        updTotal();
        var crfLabel = h('span');
        var crf = h('input', { type: 'range', min: '22', max: '38', value: String(compactOpts.crf), oninput: function () { compactOpts.crf = Number(crf.value); setCrf(); } });
        function setCrf() { var v = compactOpts.crf; crfLabel.textContent = v + ' (' + (v <= 26 ? 'best quality, larger' : v <= 32 ? 'great quality, balanced' : 'smallest, softer picture') + ')'; }
        setCrf();
        var preset = h('select', { onchange: function () { compactOpts.preset = Number(preset.value); } },
          [['4', 'Slow, smallest files'], ['6', 'Balanced (recommended)'], ['8', 'Fast, slightly larger']].map(function (o) { return h('option', { value: o[0], selected: String(compactOpts.preset) === o[0] ? true : null }, o[1]); }));
        var langs = h('input', { type: 'text', value: compactOpts.audioLangs, placeholder: 'e.g. rus,eng (empty = keep all)', oninput: function () { compactOpts.audioLangs = langs.value; } });
        var outLabel = h('span', { class: 'mono small', text: compactOpts.outDir || 'no folder chosen' });
        var rReplace = h('input', { type: 'radio', name: 'mode', checked: compactOpts.mode === 'replace', onchange: function () { compactOpts.mode = 'replace'; } });
        var rCopy = h('input', { type: 'radio', name: 'mode', checked: compactOpts.mode === 'copy', onchange: function () { compactOpts.mode = 'copy'; } });
        var err = h('p', { class: 'err' });
        nodes.push(h('div', { class: 'panel' }, h('h2', { text: 'Files that can shrink' }),
          h('table', null, h('tr', null, h('th'), h('th', { text: 'File' }), h('th', { text: 'Now' }), h('th'), h('th', { class: 'num', text: 'Size' })), rows),
          h('p', { style: 'margin-top:12px' }, 'Selected: ', total)));
        nodes.push(h('div', { class: 'panel' }, h('h2', { text: 'Options' }),
          h('div', { class: 'grid2' },
            field(h('span', null, 'Quality: ', crfLabel), crf),
            field('Speed', preset),
            field('Keep only these audio languages', langs, 'Language codes, comma separated. Removing unused dubs saves a lot.')),
          h('h3', { text: 'What to do with the originals' }),
          h('label', { class: 'check' }, rReplace, h('span', null, h('strong', { text: 'Replace originals' }), h('div', { class: 'hint', text: 'Frees the space. Each original is deleted only after its new version is verified.' }))),
          h('label', { class: 'check', style: 'margin-top:8px' }, rCopy, h('span', null, h('strong', { text: 'Keep originals, save new files to another folder' }),
            h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: function (e) {
              e.preventDefault(); pickFolder(compactOpts.outDir).then(function (p) { if (p) { compactOpts.outDir = p; outLabel.textContent = p; rCopy.checked = true; compactOpts.mode = 'copy'; } });
            } }, 'Choose folder…'), outLabel))),
          err,
          h('button', { class: 'btn primary', style: 'margin-top:12px', onclick: function (e) {
            if (!sel.length) { err.textContent = 'Select at least one file.'; return; }
            if (compactOpts.mode === 'copy' && !compactOpts.outDir) { err.textContent = 'Choose the output folder.'; return; }
            if (compactOpts.mode === 'replace' && !confirm('Convert ' + sel.length + ' file(s) and replace the originals once verified?')) return;
            busy(e.target, api('/api/compact/start', { ids: sel, crf: compactOpts.crf, preset: compactOpts.preset, audioLangs: compactOpts.audioLangs, mode: compactOpts.mode, outDir: compactOpts.outDir }))
              .then(function () { compactOpts.selected = null; setTimeout(function () { go('storage'); }, 500); }).catch(function (er) { err.textContent = er.message; });
          } }, '🗜 Start converting')));
      }
      return nodes;
    });
  }

  // ---------- logs ----------
  function logs() {
    var box = h('div', { class: 'logs', role: 'log' });
    var since = 0;
    function pull() {
      api('/api/logs?since=' + since).then(function (d) {
        var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
        d.lines.forEach(function (l) {
          since = Math.max(since, l.t);
          box.appendChild(h('div', { class: l.level }, new Date(l.t).toLocaleTimeString() + '  ' + l.msg));
        });
        if (atBottom) box.scrollTop = box.scrollHeight;
      }).catch(function () {});
    }
    pull();
    pollTimer = setInterval(function () { if (page === 'logs') pull(); }, 2000);
    return [h('div', { class: 'head' }, h('h1', { text: 'Logs' })), box];
  }

  boot();
})();
