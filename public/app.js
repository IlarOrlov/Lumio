'use strict';
/* Lumio web client. No frameworks, no innerHTML with data: every string from
   the server is inserted with textContent, so the UI cannot be script-injected. */
(function () {
 function start() {
  var view = document.getElementById('view');
  var searchBox = document.getElementById('search');
  var whoEl = document.getElementById('who');
  var state = { me: null, library: null, progress: null };
  var stage = null;
  try { // visual effects are optional: they must never stop the app from working
    stage = window.LumioFX ? LumioFX.beam(document.getElementById('room'), { power: 0.9 }) : null;
    if (window.LumioFX) LumioFX.tilt();
  } catch (fxErr) { stage = null; if (window.LumioReport) LumioReport('effects: ' + fxErr.message); }
  var DEFAULT_AIM = { x: 0.72, y: 0.4 };

  // ---------- helpers ----------

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(x); });
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  var ICONS = {
    play: 'M8 5.5v13l11-6.5z',
    pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
    back: 'M15 5l-7 7 7 7',
    rew: 'M12 5a7 7 0 1 1-6.6 4.7M5 4v5h5',
    fwd: 'M12 5a7 7 0 1 0 6.6 4.7M19 4v5h-5',
    full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    next: 'M6 5.5v13l9-6.5zM17 5h2v14h-2z',
    down: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    audio: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2',
    subs: 'M3 6h18v12H3zM7 14h4M13 14h4M7 10h2M11 10h6',
    skip: 'M5 5.5v13l8-6.5zM13 5.5v13l8-6.5z',
  };
  function icon(name) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    var filled = name === 'play' || name === 'pause' || name === 'next' || name === 'skip';
    path.setAttribute('fill', filled ? 'currentColor' : 'none');
    if (!filled) { path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); }
    svg.appendChild(path);
    return svg;
  }

  /** Circular arrow with "30" inside: unmistakably "30 seconds back/forward". */
  function jumpIcon(dir) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'jump-ico');
    var arc = document.createElementNS(NS, 'path');
    arc.setAttribute('d', dir < 0 ? 'M9.2 7.8A11 11 0 1 1 5 16' : 'M22.8 7.8A11 11 0 1 0 27 16');
    var head = document.createElementNS(NS, 'path');
    head.setAttribute('d', dir < 0 ? 'M10.5 2.8L8.6 8.3l5.6 1.4' : 'M21.5 2.8l1.9 5.5-5.6 1.4');
    [arc, head].forEach(function (p) {
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2.2');
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    });
    var t = document.createElementNS(NS, 'text');
    t.setAttribute('x', '16'); t.setAttribute('y', '20.6'); t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'jump-num');
    t.textContent = '30';
    svg.appendChild(t);
    return svg;
  }

  function api(path, body) {
    var opts = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Lumio-CSRF'] = state.me ? state.me.csrf : '';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).catch(function (e) {
      // Connection refused before reaching Lumio (some TV browsers only trust a
      // clicked-through certificate on page loads): reload once to reconnect.
      var last = 0;
      try { last = Number(sessionStorage.getItem('lumio-reconnect')) || 0; } catch (x) { /* storage blocked */ }
      if (Date.now() - last > 20000) {
        try { sessionStorage.setItem('lumio-reconnect', String(Date.now())); } catch (x) { /* storage blocked */ }
        location.reload();
        throw new Error('signed out'); // silent: the page is reloading
      }
      throw new Error('Lumio isn\'t reachable right now. Check the network and reload the page.');
    }).then(function (r) {
      if (r.status === 401) { location.replace('/login'); throw new Error('signed out'); }
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return hh ? hh + ':' + two(mm) + ':' + two(ss) : mm + ':' + two(ss);
  }
  function fmtLeft(pos, dur) {
    var m = Math.round(Math.max(0, dur - pos) / 60);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm left' : m + 'm left';
  }
  function ago(ts) {
    var d = (Date.now() - ts) / 1000;
    if (d < 90) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    return Math.round(d / 86400) + ' days ago';
  }
  function epCode(it) {
    return 'S' + (it.season < 10 ? '0' : '') + it.season + 'E' + (it.episode < 10 ? '0' : '') + it.episode;
  }
  function itemTitle(it) { return it.kind === 'episode' ? it.show : it.title; }
  function itemSub(it) {
    if (it.kind === 'episode') return epCode(it) + '  ' + it.title;
    return [it.year, it.duration ? Math.round(it.duration / 60) + ' min' : null].filter(Boolean).join(', ');
  }
  function seasonsText(n, eps) { return n + (n === 1 ? ' season, ' : ' seasons, ') + eps + ' episodes'; }
  function progressOf(id) { return state.progress && state.progress.map[id]; }

  // Which optional codecs this device can decode; the server then streams
  // AV1/HEVC/VP9 files untouched instead of burning CPU on transcoding.
  var caps = (function () {
    var tests = {
      av1: 'video/mp4; codecs="av01.0.08M.10"', hevc: 'video/mp4; codecs="hvc1.2.4.L120.90"', vp9: 'video/mp4; codecs="vp09.00.10.08"',
      opus: 'audio/mp4; codecs="opus"', flac: 'audio/mp4; codecs="flac"',
    };
    var v = document.createElement('video');
    return Object.keys(tests).filter(function (k) {
      try {
        if (window.MediaSource && MediaSource.isTypeSupported(tests[k])) return true;
        return v.canPlayType(tests[k]) === 'probably';
      } catch (e) { return false; }
    }).join(',');
  })();

  function thumb(id, cls) {
    return h('img', { class: cls || 'thumb', src: '/media/' + id + '/thumb', alt: '', loading: 'lazy', decoding: 'async' });
  }

  /** The series' own poster when it has one, otherwise a frame from its first episode. */
  function showImage(s, cls) {
    if (!s.poster) return thumb(s.thumbId, cls);
    return h('img', { class: (cls || 'thumb') + ' poster-img', src: '/shows/' + s.key + '/poster', alt: '', loading: 'lazy', decoding: 'async' });
  }

  function progressBar(p) {
    if (!p || !p.duration) return null;
    var pct = p.completed ? 100 : Math.min(100, (p.position / p.duration) * 100);
    var bar = h('div', { class: 'bar' }, h('span'));
    bar.firstChild.style.width = pct + '%';
    return bar;
  }

  // ---------- data ----------

  function loadProgress() {
    return api('/api/progress').then(function (p) {
      var map = {};
      p.items.forEach(function (r) { map[r.id] = r; });
      state.progress = { map: map, items: p.items, cont: p.continue };
    });
  }
  function loadAll() {
    return Promise.all([api('/api/library'), loadProgress()]).then(function (r) { state.library = r[0]; });
  }

  // ---------- cards ----------

  function frame(id, extra) {
    return h('div', { class: 'frame' }, thumb(id), extra);
  }
  function continueCard(c) {
    var it = c.item;
    var label = c.upNext ? 'Up next' : fmtLeft(c.position, c.duration || it.duration);
    return h('a', { class: 'card tilt', href: '#/watch/' + it.id, 'data-tilt': '12' },
      frame(it.id, [it.kind === 'episode' ? h('span', { class: 'chip', text: epCode(it) }) : null,
        progressBar(c.upNext ? null : { position: c.position, duration: c.duration || it.duration })]),
      h('div', { class: 'meta' }, h('strong', { text: itemTitle(it) }), h('span', { text: label })));
  }
  function movieCard(it) {
    var p = progressOf(it.id);
    return h('a', { class: 'card tilt', href: '#/watch/' + it.id, 'data-tilt': '12' },
      frame(it.id, [progressBar(p), p && p.completed ? h('span', { class: 'check', title: 'Watched' }, '✓') : null]),
      h('div', { class: 'meta' }, h('strong', { text: it.title }), h('span', { text: itemSub(it) })));
  }
  function showCard(s) {
    return h('a', { class: 'card tilt', href: '#/show/' + s.key, 'data-tilt': '12' },
      h('div', { class: 'frame' }, showImage(s)),
      h('div', { class: 'meta' }, h('strong', { text: s.name }), h('span', { text: seasonsText(s.seasons, s.episodeCount) })));
  }
  function row(title, cards, opts) {
    if (!cards.length) return null;
    opts = opts || {};
    return h('section', { class: 'row' },
      h('div', { class: 'row-head' }, h('h2', { text: title }), opts.note ? h('span', { class: 'muted', text: opts.note }) : null),
      h('div', { class: 'scroller' + (opts.wide ? ' wide' : '') }, cards));
  }
  function grid(title, cards, empty) {
    return h('section', { class: 'row' }, title ? h('div', { class: 'row-head' }, h('h2', { text: title })) : null,
      cards.length ? h('div', { class: 'grid' }, cards) : h('p', { class: 'muted', text: empty }));
  }
  function pageHead(title, sub) {
    return h('section', { class: 'page-head' }, h('h1', { text: title }), sub ? h('p', { class: 'muted', text: sub }) : null);
  }

  /** The hero: a big 3D screen the projector beam lands on. */
  function heroStage(o) {
    var screen = h('a', { class: 'screen tilt', href: o.href, 'data-tilt': '8', 'aria-label': o.cta + ': ' + o.title },
      h('div', { class: 'screen-img' }, o.image || thumb(o.thumbId, 'hero-img'), o.progress ? progressBar(o.progress) : null),
      h('span', { class: 'play-orb', 'aria-hidden': 'true' }, icon('play')));
    var node = h('section', { class: 'stage' },
      h('div', { class: 'stage-copy' },
        o.note ? h('p', { class: 'stage-note', text: o.note }) : null,
        h('h1', { class: 'marquee', text: o.title }),
        o.sub,
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: o.href }, icon('play'), o.cta),
          o.secondary || null)),
      h('div', { class: 'screen-wrap' }, screen));
    node._screen = screen;
    return node;
  }

  // ---------- views ----------

  function homeView() {
    var lib = state.library;
    var q = searchBox.value.trim().toLowerCase();
    if (q) return searchView(q);
    if (!lib.movies.length && !lib.shows.length) {
      return [h('section', { class: 'empty' }, h('h1', { class: 'marquee', text: 'Lights on, screen empty' }),
        h('p', { class: 'muted', text: 'Lumio found no videos yet. Put MKV or MP4 files in your media folder, then choose Settings, Rescan media folders.' }))];
    }
    var recent = lib.movies.map(function (m) { return { t: m.addedAt, el: function () { return movieCard(m); } }; })
      .concat(lib.shows.map(function (s) { return { t: s.addedAt, el: function () { return showCard(s); } }; }))
      .sort(function (a, b) { return b.t - a.t; }).slice(0, 20).map(function (x) { return x.el(); });
    var cont = state.progress.cont;
    var hero;
    if (cont.length) {
      var c = cont[0], it = c.item;
      hero = heroStage({
        note: c.upNext ? 'Up next on ' + state.me.deviceName : 'Continue on ' + state.me.deviceName,
        title: itemTitle(it), thumbId: it.id, href: '#/watch/' + it.id,
        cta: c.upNext ? 'Play' : 'Resume',
        progress: c.upNext ? null : { position: c.position, duration: c.duration || it.duration },
        sub: h('p', { class: 'stage-sub' }, it.kind === 'episode' ? h('span', { class: 'code', text: epCode(it) }) : null,
          h('strong', { text: it.kind === 'episode' ? it.title : itemSub(it) }),
          h('span', { text: c.upNext ? 'ready when you are' : fmtLeft(c.position, c.duration || it.duration) })),
        secondary: it.kind === 'episode' ? h('a', { class: 'btn', href: '#/show/' + it.showKey }, 'All episodes') : null,
      });
    } else {
      var pick = lib.shows[0] ? { title: lib.shows[0].name, thumbId: lib.shows[0].thumbId, image: showImage(lib.shows[0], 'hero-img'), href: '#/show/' + lib.shows[0].key, sub: seasonsText(lib.shows[0].seasons, lib.shows[0].episodeCount) }
        : { title: lib.movies[0].title, thumbId: lib.movies[0].id, href: '#/watch/' + lib.movies[0].id, sub: itemSub(lib.movies[0]) };
      hero = heroStage({
        note: 'Welcome, ' + state.me.deviceName, title: pick.title, thumbId: pick.thumbId, image: pick.image, href: pick.href, cta: 'Start watching',
        sub: h('p', { class: 'stage-sub' }, h('span', { text: pick.sub + '. Whatever you start here resumes on this device.' })),
      });
    }
    return [
      hero,
      row('Continue watching', cont.slice(1).map(continueCard), { wide: true, note: 'on ' + state.me.deviceName }),
      row('Recently added', recent),
      row('Series', lib.shows.map(showCard)),
      row('Movies', lib.movies.map(movieCard)),
    ];
  }

  function searchView(q) {
    var lib = state.library;
    var match = function (s) { return String(s).toLowerCase().indexOf(q) >= 0; };
    return [
      pageHead('Results', 'Titles matching "' + searchBox.value.trim() + '"'),
      grid('Series', lib.shows.filter(function (s) { return match(s.name); }).map(showCard), 'No series match.'),
      grid('Movies', lib.movies.filter(function (m) { return match(m.title); }).map(movieCard), 'No movies match.'),
    ];
  }

  function moviesView() { return [pageHead('Movies', state.library.movies.length + ' in your library'), grid(null, state.library.movies.map(movieCard), 'No movies yet. Put them in a "Movies" folder inside your media folder.')]; }
  function seriesView() { return [pageHead('Series', state.library.shows.length + ' in your library'), grid(null, state.library.shows.map(showCard), 'No series yet. Name episodes like "Show S01E01.mkv".')]; }

  function showView(key) {
    return api('/api/shows/' + key).then(function (show) {
      var seasons = [];
      show.episodes.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
      var resume = show.episodes.find(function (e) { var p = progressOf(e.id); return !p || !p.completed; }) || show.episodes[0];
      var rp = progressOf(resume.id);
      var current = resume.season;
      var list = h('div', { class: 'episodes' });
      var tabs = h('div', { class: 'tabs', role: 'tablist' });

      function renderSeason(sn) {
        current = sn;
        Array.prototype.forEach.call(tabs.children, function (t) {
          var on = Number(t.dataset.season) === sn;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        list.textContent = '';
        show.episodes.filter(function (e) { return e.season === sn; }).forEach(function (e) {
          var p = progressOf(e.id);
          list.appendChild(h('a', { class: 'episode', href: '#/watch/' + e.id },
            frame(e.id, progressBar(p)),
            h('div', { class: 'ep-meta' },
              h('div', { class: 'ep-title' }, h('span', { class: 'num', text: String(e.episode) }), h('strong', { text: e.title })),
              h('span', { class: 'muted', text: [e.duration ? Math.round(e.duration / 60) + ' min' : null,
                p && p.completed ? 'watched' : p ? fmtLeft(p.position, p.duration) : null].filter(Boolean).join(', ') })),
            p && p.completed ? h('span', { class: 'check', title: 'Watched' }, '✓') : null));
        });
      }
      seasons.forEach(function (sn) {
        tabs.appendChild(h('button', { class: 'tab', role: 'tab', 'data-season': sn, onclick: function () { renderSeason(sn); } }, 'Season ' + sn));
      });
      renderSeason(current);
      var hero = heroStage({
        note: seasonsText(show.seasons, show.episodeCount),
        title: show.name, thumbId: resume.id, image: show.poster ? showImage(show, 'hero-img') : null, href: '#/watch/' + resume.id,
        cta: (rp && !rp.completed ? 'Continue ' : 'Play ') + epCode(resume),
        progress: rp && !rp.completed ? rp : null,
        sub: h('p', { class: 'stage-sub' }, h('span', { class: 'code', text: epCode(resume) }), h('strong', { text: resume.title })),
      });
      return [hero, seasons.length > 1 ? tabs : null, list];
    });
  }

  function historyView() {
    var lib = state.library;
    var byId = {};
    lib.movies.forEach(function (m) { byId[m.id] = m; });
    var items = state.progress.items;
    var needed = items.filter(function (r) { return !byId[r.id]; }).map(function (r) { return r.id; });
    return Promise.all(needed.map(function (id) {
      return api('/api/media/' + id).then(function (d) { byId[id] = d; }).catch(function () {});
    })).then(function () {
      var rows = items.filter(function (r) { return byId[r.id]; }).map(function (r) {
        var it = byId[r.id];
        var toggle = h('button', { class: 'btn small', onclick: function () {
          api(r.completed ? '/api/progress/clear' : '/api/progress/watched', { id: r.id })
            .then(loadProgress).then(render);
        } }, r.completed ? 'Mark unwatched' : 'Mark watched');
        return h('div', { class: 'hist' },
          h('a', { href: '#/watch/' + r.id, class: 'card' }, frame(r.id, progressBar(r))),
          h('div', { class: 'ep-meta' }, h('strong', { text: itemTitle(it) }),
            h('span', { class: 'muted', text: itemSub(it) }),
            h('span', { class: 'muted', text: (r.completed ? 'Watched ' : 'Stopped at ' + fmtTime(r.position) + ', ') + ago(r.updatedAt) })),
          toggle);
      });
      return [pageHead('History', 'What ' + state.me.deviceName + ' has watched. Other devices keep their own.'),
        rows.length ? h('div', { class: 'history' }, rows) : h('p', { class: 'empty', text: 'Nothing watched on this device yet.' })];
    });
  }


  /** Per-device look: Auto (detected), Full, Light or Basic. Stored on this device only. */
  function effectsPanel() {
    var cur = 'auto';
    try { cur = localStorage.getItem('lumio-fx') || 'auto'; } catch (e) { /* storage blocked */ }
    var auto = window.LumioAutoTier || 'full';
    var names = { full: 'Full (all effects)', lite: 'Light', basic: 'Basic (fastest)' };
    var opts = [['auto', 'Auto: ' + names[auto]], ['full', names.full], ['lite', names.lite], ['basic', names.basic]];
    var row = h('div', { class: 'tabs fx-pick', role: 'radiogroup', 'aria-label': 'Visual effects' });
    opts.forEach(function (o) {
      row.appendChild(h('button', { class: 'tab' + (o[0] === cur ? ' active' : ''), role: 'radio', 'aria-checked': o[0] === cur ? 'true' : 'false', onclick: function () {
        if (window.LumioSetTier) window.LumioSetTier(o[0] === 'auto' ? auto : o[0], o[0] === 'auto' ? null : o[0]);
        location.reload();
      } }, o[1]));
    });
    return h('section', { class: 'panel' }, h('h2', { text: 'Visual effects on this device' }),
      h('p', { class: 'muted small', text: 'Lumio picks the look that runs smoothly here. Full shows every effect, Basic is fastest on TVs and older devices.' }), row);
  }

  /** Non-admin devices: their name and sign-out, nothing that changes Lumio. */
  function deviceView() {
    return [
      pageHead(state.me.deviceName, 'This device keeps its own watch history and resume points.'),
      h('section', { class: 'panel' }, h('h2', { text: 'Settings' }),
        h('p', { class: 'muted', text: 'Settings are managed on admin devices. The owner can make a device an admin in the Lumio admin console on the computer that runs Lumio.' })),
      effectsPanel(),
      h('section', { class: 'panel' }, h('h2', { text: 'Sign out' }),
        h('p', { class: 'muted', text: 'Signing out ends this device\'s session. Sign in again with the same name to get its history back.' }),
        h('button', { class: 'btn danger', onclick: function () {
          api('/api/logout', {}).then(function () { location.replace('/login'); });
        } }, 'Sign out')),
    ];
  }

  function settingsView() {
    if (!state.me.isAdmin) return deviceView();
    return api('/api/devices').then(function (d) {
      var nameInput = h('input', { type: 'text', maxlength: '40', value: state.me.deviceName, 'aria-label': 'Device name' });
      var msg = h('span', { class: 'muted', role: 'status' });
      var devices = d.devices.map(function (dev) {
        var mine = dev.id === d.current;
        return h('div', { class: 'device' },
          h('div', null, h('strong', { text: dev.name + (mine ? ' (this device)' : '') }), dev.isAdmin ? h('span', { class: 'badge', text: 'Admin' }) : null,
            h('div', { class: 'muted small', text: 'Last active ' + ago(dev.lastSeen) + ', added ' + new Date(dev.createdAt).toLocaleDateString() })),
          dev.isAdmin && !mine ? h('span', { class: 'muted small', text: 'Managed in the admin console' }) : h('button', { class: 'btn small danger', onclick: function () {
            if (!confirm('Sign out "' + dev.name + '" and delete its watch history?')) return;
            api('/api/devices/revoke', { id: dev.id }).then(function () { if (mine) location.replace('/login'); else render(); });
          } }, mine ? 'Remove' : 'Sign out'));
      });
      var host = location.hostname;
      return [
        pageHead('Settings', 'This is an admin device. Other devices can\'t open settings unless you make them admins in the Lumio admin console.'),
        h('section', { class: 'panel' }, h('h2', { text: 'This device' }),
          h('form', { class: 'inline', onsubmit: function (e) {
            e.preventDefault();
            api('/api/devices/rename', { name: nameInput.value }).then(function () {
              state.me.deviceName = nameInput.value.trim(); whoEl.textContent = state.me.deviceName; msg.textContent = 'Renamed';
            }).catch(function (er) { msg.textContent = er.message; });
          } }, nameInput, h('button', { class: 'btn', type: 'submit' }, 'Rename'), msg),
          h('p', { class: 'muted small', text: 'Plays directly on this device: H.264' + (caps ? ', ' + caps.toUpperCase().split(',').join(', ') : '') + '. Everything else is converted on the fly.' })),
        h('section', { class: 'panel' }, h('h2', { text: 'Signed-in devices' }), devices),
        effectsPanel(),
        h('section', { class: 'panel' }, h('h2', { text: 'Open Lumio on other devices' }),
          h('p', { class: 'muted', text: 'On any phone, tablet, TV or laptop on your home network, open:' }),
          h('p', null, h('span', { class: 'code', text: 'https://' + (/\.local$/.test(host) ? host : 'lumio.local') + ':' + (location.port || '443') })),
          h('p', { class: 'muted small', text: 'This name keeps working when Lumio\'s IP address changes. Devices that can\'t open .local names (some older TVs) can use the address in the Lumio admin console instead.' }),
          h('p', { class: 'muted small' }, 'To stop browser warnings, install ', h('a', { href: '/lumio.crt', download: 'Lumio-home-CA.crt', class: 'link' }, 'Lumio\'s certificate'), ' once on each device.')),
        h('section', { class: 'panel' }, h('h2', { text: 'Windows PC (VMware NAT only)' }),
          h('p', { class: 'muted', text: 'Not needed when the Lumio VM\'s network adapter is set to Bridged in VMware. Only if you must keep NAT: this helper forwards the port and opens the firewall for your home network. It writes nothing else to the Windows drive, can undo its changes, and deletes itself when done.' }),
          h('a', { class: 'btn', href: '/api/windows-helper', download: 'Lumio-Windows-Setup.cmd' }, icon('down'), 'Download Windows helper')),
        h('section', { class: 'panel' }, h('h2', { text: 'Library' }),
          h('div', { class: 'inline' },
            h('button', { class: 'btn', onclick: function (e) {
              e.target.disabled = true;
              api('/api/rescan', {}).then(function (r) { e.target.textContent = 'Found ' + r.count + ' files'; return loadAll(); });
            } }, 'Rescan media folders'),
            h('button', { class: 'btn danger', onclick: function () {
              api('/api/logout', {}).then(function () { location.replace('/login'); });
            } }, 'Sign out'))),
      ];
    });
  }

  // ---------- player ----------

  var player = null;

  /** Theatre layout: the player on top, then the title and the season's episodes as numbered tiles. */
  function watchView(id) {
    return api('/api/media/' + id + '?caps=' + caps).then(function (d) {
      var p = progressOf(id);
      var resumeAt = p && !p.completed && p.position > 10 ? p.position : 0;
      var showReq = d.kind === 'episode' ? api('/api/shows/' + d.showKey).catch(function () { return null; }) : Promise.resolve(null);
      return showReq.then(function (show) {
        player = createPlayer(d, resumeAt);
        var head = h('div', { class: 'watch-head' },
          h('h1', { text: itemTitle(d) }),
          h('p', { class: 'watch-sub' },
            d.kind === 'episode' ? h('span', { class: 'code', text: epCode(d) }) : null,
            h('span', { text: d.kind === 'episode' ? (/^Episode \d+$/.test(d.title) ? '' : d.title) : itemSub(d) }),
            d.duration ? h('span', { class: 'muted', text: Math.round(d.duration / 60) + ' min' }) : null));
        var below = [head];
        if (show) below.push(episodeTiles(show, d));
        else {
          var others = state.library.movies.filter(function (m) { return m.id !== d.id; }).map(movieCard);
          if (others.length) below.push(h('section', { class: 'watch-more' }, h('h2', { text: 'More movies' }), h('div', { class: 'scroller' }, others)));
        }
        return [h('div', { class: 'watch' }, player.el, h('section', { class: 'watch-info' }, below))];
      });
    });
  }

  function episodeTiles(show, current) {
    var seasons = [];
    show.episodes.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
    var grid = h('div', { class: 'ep-grid' });
    var tabs = h('div', { class: 'tabs', role: 'tablist' });
    function renderSeason(sn) {
      Array.prototype.forEach.call(tabs.children, function (t) { t.classList.toggle('active', Number(t.getAttribute('data-season')) === sn); });
      grid.textContent = '';
      show.episodes.filter(function (e) { return e.season === sn; }).forEach(function (e) {
        var pr = progressOf(e.id);
        var now = e.id === current.id;
        var note = now ? 'Playing' : pr && pr.completed ? 'Watched' : pr ? fmtLeft(pr.position, pr.duration) : (e.duration ? Math.round(e.duration / 60) + ' min' : '');
        var named = !/^Episode \d+$/.test(e.title);
        var tile = h('a', { class: 'ep-tile' + (now ? ' now' : '') + (pr && pr.completed ? ' done' : ''), href: '#/watch/' + e.id, 'aria-current': now ? 'true' : null,
          'aria-label': 'Episode ' + e.episode + (named ? ', ' + e.title : '') + (note ? ', ' + note : '') },
          h('span', { class: 'n', text: String(e.episode) }),
          named ? h('span', { class: 't', text: e.title }) : null,
          h('span', { class: 'note', text: note }),
          pr && !pr.completed && !now ? progressBar(pr) : null);
        grid.appendChild(tile);
      });
    }
    seasons.forEach(function (sn) {
      tabs.appendChild(h('button', { class: 'tab', role: 'tab', 'data-season': sn, onclick: function () { renderSeason(sn); } }, 'Season ' + sn));
    });
    renderSeason(current.season);
    return h('section', { class: 'watch-eps' }, h('div', { class: 'row-head' }, h('h2', { text: 'Episodes' }), seasons.length > 1 ? tabs : null), grid);
  }

  function createPlayer(d, resumeAt) {
    var direct = d.plan === 'direct';
    var duration = d.duration;
    var offset = 0;
    var audio = 0;
    var subKey = '';
    var lastSaved = 0;
    var destroyed = false;
    var hideTimer = null;

    var video = h('video', { class: 'video', playsinline: true, preload: 'auto', autoplay: true });
    var seek = h('input', { type: 'range', class: 'seek', min: '0', max: String(Math.floor(duration)), step: '1', value: '0', 'aria-label': 'Seek' });
    var timeEl = h('span', { class: 'time cur' }, '0:00');
    var durEl = h('span', { class: 'time dur' }, fmtTime(duration));
    var intros = (d.intros || []).filter(function (s) { return s.end - s.start >= 2; });
    var skipBtn = h('button', { class: 'skip-intro', hidden: true, 'aria-label': 'Skip intro' }, h('span', { text: 'Skip intro' }), icon('skip'));
    var currentIntro = null;
    var playBtn = h('button', { class: 'ctl play', 'aria-label': 'Play or pause' }, icon('pause'));
    function setPlayIcon(name) { playBtn.textContent = ''; playBtn.appendChild(icon(name)); }
    var spinner = h('div', { class: 'spinner', hidden: true });
    var title = h('div', { class: 'p-title' },
      h('a', { href: d.kind === 'episode' ? '#/show/' + d.showKey : '#/', class: 'ctl back', 'aria-label': 'Back' }, icon('back')),
      h('div', null, h('strong', { text: itemTitle(d) }), h('div', { class: 'muted', text: itemSub(d) })));

    // audio / subtitle pickers: one icon button each, opening a small menu
    var menu = h('div', { class: 'pmenu', hidden: true, role: 'menu' });
    function openMenu(btn, heading, options, current, onPick) {
      if (!menu.hidden && menu._for === btn) { menu.hidden = true; return; }
      menu.textContent = '';
      menu._for = btn;
      menu.appendChild(h('div', { class: 'pmenu-head', text: heading }));
      options.forEach(function (o) {
        menu.appendChild(h('button', { class: 'pmenu-item' + (o.value === current() ? ' on' : ''), role: 'menuitemradio',
          'aria-checked': o.value === current() ? 'true' : 'false',
          onclick: function () { menu.hidden = true; onPick(o.value); } }, o.label));
      });
      menu.hidden = false;
      var first = menu.querySelector('.on') || menu.querySelector('.pmenu-item');
      if (first) first.focus();
    }
    var audioBtn = d.audio.length > 1 ? h('button', { class: 'ctl', 'aria-label': 'Audio track', title: 'Audio' }, icon('audio')) : null;
    var subBtn = d.subtitles.length ? h('button', { class: 'ctl', 'aria-label': 'Subtitles', title: 'Subtitles' }, icon('subs')) : null;
    var nextBtn = d.next ? h('a', { class: 'ctl', href: '#/watch/' + d.next.id, 'aria-label': 'Next episode', title: 'Next episode' }, icon('next')) : null;
    var upNext = h('div', { class: 'upnext', hidden: true });
    var back30 = h('button', { class: 'ctl jump', 'aria-label': 'Back 30 seconds', title: 'Back 30 seconds', onclick: function () { seekTo(now() - 30); } }, jumpIcon(-1));
    var fwd30 = h('button', { class: 'ctl jump', 'aria-label': 'Forward 30 seconds', title: 'Forward 30 seconds', onclick: function () { seekTo(now() + 30); } }, jumpIcon(1));

    var controls = h('div', { class: 'controls' },
      h('div', { class: 'seekline' }, timeEl, seek, durEl),
      h('div', { class: 'ctl-row' },
        h('div', { class: 'ctl-side left' }, audioBtn, subBtn),
        h('div', { class: 'ctl-center' }, back30, playBtn, fwd30),
        h('div', { class: 'ctl-side right' }, nextBtn, h('button', { class: 'ctl', 'aria-label': 'Fullscreen', title: 'Fullscreen', onclick: toggleFs }, icon('full')))));

    var tap = h('div', { class: 'tap', 'aria-hidden': 'true' });
    var el = h('div', { class: 'player' }, video, tap, spinner, title, controls, skipBtn, menu, upNext);
    el.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.ctl')) menu.hidden = true; });

    function now() { return offset + (video.currentTime || 0); }

    function src(t) {
      return '/media/' + d.id + '/play?caps=' + caps + '&audio=' + audio + (direct ? '' : '&t=' + t.toFixed(3));
    }

    function loadSubs() {
      Array.prototype.slice.call(video.querySelectorAll('track')).forEach(function (t) { t.remove(); });
      if (!subKey) return;
      var tr = h('track', { kind: 'subtitles', default: true, src: '/media/' + d.id + '/subs/' + subKey + '.vtt?t=' + (direct ? 0 : offset).toFixed(3) });
      video.appendChild(tr);
      tr.addEventListener('load', function () { if (video.textTracks[0]) video.textTracks[0].mode = 'showing'; });
    }

    function seekTo(t) {
      t = Math.max(0, Math.min(duration - 1, t));
      if (direct) { video.currentTime = t; return; }
      spinner.hidden = false;
      api('/api/media/' + d.id + '/seek?t=' + t.toFixed(3) + '&audio=' + audio + '&caps=' + caps).then(function (r) {
        if (destroyed) return;
        offset = r.start;
        video.src = src(r.start);
        loadSubs();
        video.play().catch(function () {});
      });
    }

    function updateSkip(t) {
      var seg = null;
      for (var i = 0; i < intros.length; i++) if (t >= intros[i].start && t < intros[i].end - 1) { seg = intros[i]; break; }
      if (seg !== currentIntro) {
        currentIntro = seg;
        skipBtn.hidden = !seg;
        if (seg) { skipBtn.classList.remove('pop'); void skipBtn.offsetWidth; skipBtn.classList.add('pop'); }
      }
    }
    skipBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!currentIntro) return;
      var to = currentIntro.end;
      skipBtn.hidden = true;
      currentIntro = null;
      seekTo(to);
    });
    if (audioBtn) audioBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openMenu(audioBtn, 'Audio', d.audio.map(function (a) { return { value: a.index, label: a.label }; }), function () { return audio; }, function (v) {
        if (v === audio) return;
        audio = v;
        direct = false; // switching audio needs the server to pick the track
        seekTo(now());
      });
    });
    if (subBtn) subBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openMenu(subBtn, 'Subtitles', [{ value: '', label: 'Off' }].concat(d.subtitles.map(function (s) { return { value: s.key, label: s.label }; })),
        function () { return subKey; }, function (v) { subKey = v; subBtn.classList.toggle('on', !!v); loadSubs(); });
    });

    function save(force) {
      var pos = now();
      if (!duration || (!force && Math.abs(pos - lastSaved) < 5)) return;
      lastSaved = pos;
      fetch('/api/progress', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Lumio-CSRF': state.me.csrf },
        body: JSON.stringify({ id: d.id, position: pos, duration: duration }),
      }).then(function () {
        var m = state.progress.map[d.id] || {};
        m.id = d.id; m.position = pos; m.duration = duration; m.completed = m.completed || pos / duration >= 0.92;
        state.progress.map[d.id] = m;
      }).catch(function () {});
    }

    function toggleFs() {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { var r = req.call(el); if (r && r.catch) r.catch(function () {}); } else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }

    function poke() {
      el.classList.remove('idle');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { if (!video.paused) el.classList.add('idle'); }, 3000);
    }

    function startUpNext() {
      if (!d.next) return;
      var n = 10;
      upNext.hidden = false;
      var label = h('span');
      upNext.textContent = '';
      upNext.appendChild(h('div', null, h('div', { class: 'muted', text: 'Up next' }),
        h('strong', { text: epCode(d.next) + '  ' + d.next.title }), h('div', { class: 'muted' }, label)));
      upNext.appendChild(h('div', { class: 'upnext-btns' },
        h('a', { class: 'btn primary', href: '#/watch/' + d.next.id }, 'Play now'),
        h('button', { class: 'btn', onclick: function () { clearInterval(timer); upNext.hidden = true; } }, 'Cancel')));
      var tick = function () { label.textContent = 'Starting in ' + n + 's'; };
      tick();
      var timer = setInterval(function () {
        n -= 1; tick();
        if (n <= 0) { clearInterval(timer); if (!destroyed) location.hash = '#/watch/' + d.next.id; }
      }, 1000);
      el._timer = timer;
    }

    video.addEventListener('timeupdate', function () {
      var t = now();
      if (document.activeElement !== seek) seek.value = String(Math.floor(t));
      seek.style.setProperty('--pct', (duration ? Math.min(100, t / duration * 100) : 0).toFixed(2) + '%');
      timeEl.textContent = fmtTime(t);
      updateSkip(t);
      save(false);
      if (d.next && duration - t < 25 && upNext.hidden && !el._shown) { el._shown = true; startUpNext(); }
    });
    video.addEventListener('play', function () { setPlayIcon('pause'); poke(); });
    video.addEventListener('pause', function () { setPlayIcon('play'); el.classList.remove('idle'); save(true); });
    video.addEventListener('waiting', function () { spinner.hidden = false; });
    video.addEventListener('playing', function () { spinner.hidden = true; });
    video.addEventListener('canplay', function () { spinner.hidden = true; });
    video.addEventListener('ended', function () { save(true); if (!el._shown) startUpNext(); });
    video.addEventListener('error', function () {
      spinner.hidden = true;
      durEl.textContent = '';
      timeEl.textContent = 'Playback error. This device may not support the file. Try again or pick another title.';
    });
    // One click on the picture plays/pauses (and shows the controls); double-click toggles full screen.
    tap.addEventListener('click', function () {
      if (!menu.hidden) { menu.hidden = true; return; }
      if (video.paused) video.play(); else video.pause();
      poke();
    });
    tap.addEventListener('dblclick', toggleFs);
    playBtn.addEventListener('click', function () { if (video.paused) video.play(); else video.pause(); });
    seek.addEventListener('change', function () { seekTo(Number(seek.value)); });
    el.addEventListener('mousemove', poke);
    el.addEventListener('touchstart', poke, { passive: true });

    function onKey(e) {
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
      if (e.target.tagName === 'SELECT') return;
      if (e.target.closest && e.target.closest('.pmenu')) { if (e.key === 'Escape') { menu.hidden = true; } return; }
      var k = e.key;
      if (k === ' ' || k === 'k' || k === 'Enter' && e.target === document.body) { e.preventDefault(); if (video.paused) video.play(); else video.pause(); }
      else if (k === 'ArrowLeft' || k === 'j') { e.preventDefault(); seekTo(now() - 10); }
      else if (k === 'ArrowRight' || k === 'l') { e.preventDefault(); seekTo(now() + 30); }
      else if (k === 'f') toggleFs();
      else if (k === 's' && currentIntro) skipBtn.click();
      else if (k === 'Escape' && !menu.hidden) { menu.hidden = true; e.preventDefault(); return; }
      poke();
    }
    document.addEventListener('keydown', onKey);
    function onHide() { save(true); }
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);

    // start
    if (direct) {
      video.src = src(0);
      if (resumeAt) video.addEventListener('loadedmetadata', function once() { video.removeEventListener('loadedmetadata', once); video.currentTime = resumeAt; });
    } else {
      seekTo(resumeAt);
    }
    timeEl.textContent = fmtTime(resumeAt);
    document.body.classList.add('watching');
    window.scrollTo(0, 0);
    if (stage) stage.pause(); // the room goes dark while a film plays

    return {
      el: el,
      destroy: function () {
        destroyed = true;
        save(true);
        clearInterval(el._timer);
        clearTimeout(hideTimer);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onHide);
        video.pause();
        video.removeAttribute('src');
        video.load();
        document.body.classList.remove('watching');
        if (stage) stage.resume();
        if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      },
    };
  }

  // ---------- router ----------

  function render() {
    if (player) { player.destroy(); player = null; }
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/');
    var name = parts[0] || 'home';
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (a) {
      a.classList.toggle('active', a.dataset.nav === name);
    });
    var out;
    switch (name) {
      case 'watch': out = /^[0-9a-f]{20}$/.test(parts[1]) ? watchView(parts[1]) : homeView(); break;
      case 'show': out = /^[0-9a-f]{16}$/.test(parts[1]) ? showView(parts[1]) : homeView(); break;
      case 'movies': out = moviesView(); break;
      case 'series': out = seriesView(); break;
      case 'history': out = historyView(); break;
      case 'settings': case 'device': out = settingsView(); break;
      default: out = (name === 'home' ? loadProgress() : Promise.resolve()).then(homeView);
    }
    Promise.resolve(out).then(function (nodes) {
      view.textContent = '';
      view.classList.remove('view-in');
      var screen = null;
      (Array.isArray(nodes) ? nodes : [nodes]).forEach(function (n) { if (n) { view.appendChild(n); if (n._screen) screen = n._screen; } });
      if (name !== 'watch') {
        window.scrollTo(0, 0);
        void view.offsetWidth; // restart the entrance animation
        view.classList.add('view-in');
        aimBeam(screen);
      }
    }).catch(function (e) {
      if (e.message === 'signed out') return;
      view.textContent = '';
      view.appendChild(h('p', { class: 'error pad', text: 'Something went wrong: ' + e.message }));
    });
  }

  var aimTarget = null;
  function aimBeam(target) {
    aimTarget = target;
    if (!stage) return;
    // aim after the screen's swing-in settles, then keep it pointed on scroll/resize
    stage.aimAt(target ? { x: 0.7, y: 0.45 } : DEFAULT_AIM);
    if (target) setTimeout(function () { if (aimTarget === target) stage.aimAt(target); }, 900);
  }
  function reaim() { if (stage && aimTarget && document.body.contains(aimTarget)) stage.aimAt(aimTarget); }
  addEventListener('scroll', reaim, { passive: true });
  addEventListener('resize', reaim);

  var searchTimer;
  searchBox.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (location.hash && location.hash !== '#/') location.hash = '#/';
      else render();
    }, 200);
  });

  window.addEventListener('hashchange', render);

  api('/api/me').then(function (me) {
    state.me = me;
    whoEl.textContent = me.deviceName;
    if (me.isAdmin) whoEl.classList.add('admin');
    else {
      var nav = document.querySelector('[data-nav="settings"]');
      if (nav) nav.remove();
    }
    return loadAll();
  }).then(render).catch(function (e) {
    if (e && e.message === 'signed out') return;
    if (window.LumioFail) window.LumioFail('loading the library', e);
  });
 }
 try { start(); } catch (e) { if (window.LumioFail) window.LumioFail('app', e); else throw e; }
})();
