'use strict';
/* Lumio web client. No frameworks, no innerHTML with data: every string from
   the server is inserted with textContent, so the UI cannot be script-injected. */
(function () {
  var view = document.getElementById('view');
  var searchBox = document.getElementById('search');
  var state = { me: null, library: null, progress: null };

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

  function api(path, body) {
    var opts = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Lumio-CSRF'] = state.me ? state.me.csrf : '';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
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
    if (it.kind === 'episode') return epCode(it) + ' · ' + it.title;
    return [it.year, it.duration ? Math.round(it.duration / 60) + ' min' : null].filter(Boolean).join(' · ');
  }
  function progressOf(id) { return state.progress && state.progress.map[id]; }

  // Which optional codecs this device can decode; the server then streams
  // AV1/HEVC/VP9 files untouched instead of burning CPU on transcoding.
  var caps = (function () {
    var tests = { av1: 'video/mp4; codecs="av01.0.08M.10"', hevc: 'video/mp4; codecs="hvc1.2.4.L120.90"', vp9: 'video/mp4; codecs="vp09.00.10.08"' };
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

  function continueCard(c) {
    var it = c.item;
    var label = c.upNext ? 'Up next' : fmtLeft(c.position, c.duration || it.duration);
    return h('a', { class: 'card wide', href: '#/watch/' + it.id },
      h('div', { class: 'poster' }, thumb(it.id),
        h('span', { class: 'play-badge', 'aria-hidden': 'true' }, '▶'),
        progressBar(c.upNext ? null : { position: c.position, duration: c.duration || it.duration })),
      h('div', { class: 'meta' },
        h('strong', { text: itemTitle(it) }),
        h('span', { class: 'muted', text: (it.kind === 'episode' ? epCode(it) + ' · ' : '') + label })));
  }
  function movieCard(it) {
    return h('a', { class: 'card', href: '#/watch/' + it.id },
      h('div', { class: 'poster' }, thumb(it.id), progressBar(progressOf(it.id)),
        progressOf(it.id) && progressOf(it.id).completed ? h('span', { class: 'check', title: 'Watched' }, '✓') : null),
      h('div', { class: 'meta' }, h('strong', { text: it.title }), h('span', { class: 'muted', text: itemSub(it) })));
  }
  function showCard(s) {
    return h('a', { class: 'card', href: '#/show/' + s.key },
      h('div', { class: 'poster' }, thumb(s.thumbId)),
      h('div', { class: 'meta' }, h('strong', { text: s.name }),
        h('span', { class: 'muted', text: s.seasons + (s.seasons === 1 ? ' season' : ' seasons') + ' · ' + s.episodeCount + ' episodes' })));
  }
  function row(title, cards) {
    if (!cards.length) return null;
    return h('section', { class: 'row' }, h('h2', { text: title }), h('div', { class: 'scroller' }, cards));
  }
  function grid(title, cards, empty) {
    return h('section', { class: 'row' }, h('h2', { text: title }),
      cards.length ? h('div', { class: 'grid' }, cards) : h('p', { class: 'muted', text: empty }));
  }

  // ---------- views ----------

  function homeView() {
    var lib = state.library;
    var q = searchBox.value.trim().toLowerCase();
    if (q) return searchView(q);
    var recent = lib.movies.map(function (m) { return { t: m.addedAt, el: function () { return movieCard(m); } }; })
      .concat(lib.shows.map(function (s) { return { t: s.addedAt, el: function () { return showCard(s); } }; }))
      .sort(function (a, b) { return b.t - a.t; }).slice(0, 20).map(function (x) { return x.el(); });
    var cont = state.progress.cont.map(continueCard);
    var nodes = [
      cont.length
        ? row('Continue watching on ' + state.me.deviceName, cont)
        : h('section', { class: 'hero' }, h('h1', { text: 'Welcome to Lumio' }),
          h('p', { class: 'muted', text: 'Start something and it will appear here, ready to resume on this device.' })),
      row('Recently added', recent),
      row('Series', lib.shows.map(showCard)),
      row('Movies', lib.movies.map(movieCard)),
    ];
    if (!lib.movies.length && !lib.shows.length) {
      nodes.push(h('p', { class: 'muted pad', text: 'Your library is empty. Add MKV or MP4 files to your media folder, then use Settings → Rescan.' }));
    }
    return nodes;
  }

  function searchView(q) {
    var lib = state.library;
    var match = function (s) { return String(s).toLowerCase().indexOf(q) >= 0; };
    return [
      grid('Series', lib.shows.filter(function (s) { return match(s.name); }).map(showCard), 'No series match.'),
      grid('Movies', lib.movies.filter(function (m) { return match(m.title); }).map(movieCard), 'No movies match.'),
    ];
  }

  function moviesView() { return [grid('Movies', state.library.movies.map(movieCard), 'No movies yet.')]; }
  function seriesView() { return [grid('Series', state.library.shows.map(showCard), 'No series yet.')]; }

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
        Array.prototype.forEach.call(tabs.children, function (t) { t.classList.toggle('active', Number(t.dataset.season) === sn); });
        list.textContent = '';
        show.episodes.filter(function (e) { return e.season === sn; }).forEach(function (e) {
          var p = progressOf(e.id);
          list.appendChild(h('a', { class: 'episode', href: '#/watch/' + e.id },
            h('div', { class: 'poster' }, thumb(e.id), progressBar(p)),
            h('div', { class: 'ep-meta' },
              h('strong', { text: e.episode + '. ' + e.title }),
              h('span', { class: 'muted', text: [e.duration ? Math.round(e.duration / 60) + ' min' : null,
                p && p.completed ? 'Watched' : p ? fmtLeft(p.position, p.duration) : null].filter(Boolean).join(' · ') })),
            p && p.completed ? h('span', { class: 'check' }, '✓') : null));
        });
      }
      seasons.forEach(function (sn) {
        tabs.appendChild(h('button', { class: 'tab', role: 'tab', 'data-season': sn, onclick: function () { renderSeason(sn); } }, 'Season ' + sn));
      });
      renderSeason(current);
      return [
        h('section', { class: 'show-head' },
          h('h1', { text: show.name }),
          h('p', { class: 'muted', text: show.seasons + (show.seasons === 1 ? ' season' : ' seasons') + ' · ' + show.episodeCount + ' episodes' }),
          h('a', { class: 'btn primary', href: '#/watch/' + resume.id },
            (rp && !rp.completed ? '▶ Continue ' : '▶ Play ') + epCode(resume))),
        seasons.length > 1 ? tabs : null,
        list,
      ];
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
          h('a', { href: '#/watch/' + r.id, class: 'poster small' }, thumb(r.id), progressBar(r)),
          h('div', { class: 'ep-meta' }, h('strong', { text: itemTitle(it) }),
            h('span', { class: 'muted', text: itemSub(it) }),
            h('span', { class: 'muted', text: (r.completed ? 'Watched ' : 'Stopped at ' + fmtTime(r.position) + ' · ') + ago(r.updatedAt) })),
          toggle);
      });
      return [h('h2', { class: 'pad', text: 'Watch history on ' + state.me.deviceName }), rows.length ? h('div', { class: 'history' }, rows) : h('p', { class: 'muted pad', text: 'Nothing watched on this device yet.' })];
    });
  }

  function settingsView() {
    return api('/api/devices').then(function (d) {
      var nameInput = h('input', { type: 'text', maxlength: '40', value: state.me.deviceName, 'aria-label': 'Device name' });
      var msg = h('span', { class: 'muted' });
      var devices = d.devices.map(function (dev) {
        var mine = dev.id === d.current;
        return h('div', { class: 'device' },
          h('div', null, h('strong', { text: dev.name + (mine ? ' (this device)' : '') }),
            h('div', { class: 'muted', text: 'Last active ' + ago(dev.lastSeen) + ' · added ' + new Date(dev.createdAt).toLocaleDateString() })),
          h('button', { class: 'btn small danger', onclick: function () {
            if (!confirm('Sign out "' + dev.name + '" and delete its watch history?')) return;
            api('/api/devices/revoke', { id: dev.id }).then(function () { if (mine) location.replace('/login'); else render(); });
          } }, mine ? 'Remove' : 'Revoke'));
      });
      return [
        h('section', { class: 'panel' }, h('h2', { text: 'This device' }),
          h('form', { class: 'inline', onsubmit: function (e) {
            e.preventDefault();
            api('/api/devices/rename', { name: nameInput.value }).then(function () {
              state.me.deviceName = nameInput.value.trim(); msg.textContent = 'Saved';
            }).catch(function (er) { msg.textContent = er.message; });
          } }, nameInput, h('button', { class: 'btn', type: 'submit' }, 'Rename'), msg),
          h('p', { class: 'muted', text: 'Hardware decoding: H.264' + (caps ? ', ' + caps.toUpperCase().split(',').join(', ') : '') })),
        h('section', { class: 'panel' }, h('h2', { text: 'Signed-in devices' }), devices),
        h('section', { class: 'panel' }, h('h2', { text: 'Library' }),
          h('button', { class: 'btn', onclick: function (e) {
            e.target.disabled = true;
            api('/api/rescan', {}).then(function (r) { e.target.textContent = 'Found ' + r.count + ' files'; return loadAll(); });
          } }, 'Rescan media folders'),
          ' ',
          h('button', { class: 'btn danger', onclick: function () {
            api('/api/logout', {}).then(function () { location.replace('/login'); });
          } }, 'Sign out')),
      ];
    });
  }

  // ---------- player ----------

  var player = null;

  function watchView(id) {
    return api('/api/media/' + id + '?caps=' + caps).then(function (d) {
      var p = progressOf(id);
      var resumeAt = p && !p.completed && p.position > 10 ? p.position : 0;
      player = createPlayer(d, resumeAt);
      return [player.el];
    });
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
    var timeEl = h('span', { class: 'time' });
    var playBtn = h('button', { class: 'ctl', 'aria-label': 'Play/pause' }, '❚❚');
    var spinner = h('div', { class: 'spinner', hidden: true });
    var title = h('div', { class: 'p-title' },
      h('a', { href: d.kind === 'episode' ? '#/show/' + d.showKey : '#/', class: 'ctl back', 'aria-label': 'Back' }, '←'),
      h('div', null, h('strong', { text: itemTitle(d) }), h('div', { class: 'muted', text: itemSub(d) })));

    var audioSel = d.audio.length > 1 ? h('select', { class: 'sel', 'aria-label': 'Audio track' },
      d.audio.map(function (a) { return h('option', { value: String(a.index) }, a.label); })) : null;
    var subSel = d.subtitles.length ? h('select', { class: 'sel', 'aria-label': 'Subtitles' },
      [h('option', { value: '' }, 'Subtitles off')].concat(d.subtitles.map(function (s) { return h('option', { value: s.key }, s.label); }))) : null;
    var nextBtn = d.next ? h('a', { class: 'ctl text', href: '#/watch/' + d.next.id }, 'Next ⏭') : null;
    var upNext = h('div', { class: 'upnext', hidden: true });

    var controls = h('div', { class: 'controls' }, seek,
      h('div', { class: 'ctl-row' },
        playBtn,
        h('button', { class: 'ctl', 'aria-label': 'Back 10 seconds', onclick: function () { seekTo(now() - 10); } }, '↺10'),
        h('button', { class: 'ctl', 'aria-label': 'Forward 30 seconds', onclick: function () { seekTo(now() + 30); } }, '30↻'),
        timeEl, h('span', { class: 'grow' }), audioSel, subSel, nextBtn,
        h('button', { class: 'ctl', 'aria-label': 'Fullscreen', onclick: toggleFs }, '⛶')));

    var el = h('div', { class: 'player' }, video, spinner, title, controls, upNext);

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
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
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
        h('strong', { text: epCode(d.next) + ' · ' + d.next.title }), label));
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
      timeEl.textContent = fmtTime(t) + ' / ' + fmtTime(duration);
      save(false);
      if (d.next && duration - t < 25 && upNext.hidden && !el._shown) { el._shown = true; startUpNext(); }
    });
    video.addEventListener('play', function () { playBtn.textContent = '❚❚'; poke(); });
    video.addEventListener('pause', function () { playBtn.textContent = '▶'; el.classList.remove('idle'); save(true); });
    video.addEventListener('waiting', function () { spinner.hidden = false; });
    video.addEventListener('playing', function () { spinner.hidden = true; });
    video.addEventListener('canplay', function () { spinner.hidden = true; });
    video.addEventListener('ended', function () { save(true); if (!el._shown) startUpNext(); });
    video.addEventListener('error', function () {
      spinner.hidden = true;
      timeEl.textContent = 'Playback error. This device may not support the file. Try again or pick another title.';
    });
    video.addEventListener('click', function () { if (video.paused) video.play(); else video.pause(); });
    video.addEventListener('dblclick', toggleFs);
    playBtn.addEventListener('click', function () { if (video.paused) video.play(); else video.pause(); });
    seek.addEventListener('change', function () { seekTo(Number(seek.value)); });
    el.addEventListener('mousemove', poke);
    el.addEventListener('touchstart', poke, { passive: true });
    if (audioSel) audioSel.addEventListener('change', function () {
      audio = Number(audioSel.value);
      direct = false; // switching audio needs the server to pick the track
      seekTo(now());
    });
    if (subSel) subSel.addEventListener('change', function () { subKey = subSel.value; loadSubs(); });

    function onKey(e) {
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
      if (e.target.tagName === 'SELECT') return;
      var k = e.key;
      if (k === ' ' || k === 'k' || k === 'Enter' && e.target === document.body) { e.preventDefault(); if (video.paused) video.play(); else video.pause(); }
      else if (k === 'ArrowLeft' || k === 'j') { e.preventDefault(); seekTo(now() - 10); }
      else if (k === 'ArrowRight' || k === 'l') { e.preventDefault(); seekTo(now() + 30); }
      else if (k === 'f') toggleFs();
      else if (k === 'Escape' && !document.fullscreenElement) history.back();
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
    timeEl.textContent = fmtTime(resumeAt) + ' / ' + fmtTime(duration);
    document.body.classList.add('watching');

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
      case 'settings': out = settingsView(); break;
      default: out = (name === 'home' ? loadProgress() : Promise.resolve()).then(homeView);
    }
    Promise.resolve(out).then(function (nodes) {
      view.textContent = '';
      (Array.isArray(nodes) ? nodes : [nodes]).forEach(function (n) { if (n) view.appendChild(n); });
      if (name !== 'watch') window.scrollTo(0, 0);
    }).catch(function (e) {
      if (e.message === 'signed out') return;
      view.textContent = '';
      view.appendChild(h('p', { class: 'error pad', text: 'Something went wrong: ' + e.message }));
    });
  }

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
    return loadAll();
  }).then(render).catch(function () {});
})();
