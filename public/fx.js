'use strict';
/*
 * Lumio visual effects, shared by the viewer and the admin console.
 *
 *  - LumioFX.beam(canvas): a WebGL projector beam with drifting dust and haze
 *    behind the page. It renders at a fraction of screen resolution (the beam
 *    is soft, so nobody can tell), caps itself at 30 fps, adapts quality to
 *    slow GPUs (TVs), pauses while a video plays or the tab is hidden, and
 *    draws a single still frame when the device asks for reduced motion.
 *  - LumioFX.tilt(): 3D tilt + moving glare on any `.tilt` element, driven by
 *    one delegated pointer listener (cheap even with hundreds of cards).
 *
 * No dependencies, no inline styles (custom properties are set via CSSOM,
 * which the strict Content-Security-Policy allows).
 */
(function () {
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FRAG = [
    'precision mediump float;',
    'uniform vec2 uRes;uniform float uTime;uniform vec2 uAim;uniform float uPower;uniform vec2 uSrc;',
    'float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
    ' return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}',
    'float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}',
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/uRes;float asp=uRes.x/uRes.y;',
    ' vec2 p=vec2(uv.x*asp,uv.y);',
    ' vec2 src=vec2(uSrc.x*asp,uSrc.y);vec2 aim=vec2(uAim.x*asp,uAim.y);',
    ' vec2 dir=normalize(aim-src);vec2 d=p-src;',
    ' float along=dot(d,dir);float across=abs(d.x*dir.y-d.y*dir.x);',
    ' float spread=.035+along*.24;',
    ' float edge=clamp(across/spread,0.,1.);',
    ' float cone=(1.-smoothstep(.55,1.,edge))*smoothstep(0.,.08,along);',
    ' float fall=exp(-along*.42);',
    ' float smoke=fbm(p*2.6+vec2(uTime*.025,-uTime*.018));',
    ' smoke=.45+1.1*smoke*smoke;',
    // dust motes: one random speck per cell, drifting and twinkling
    ' vec2 g=p*46.+vec2(uTime*.35,uTime*.22);vec2 id=floor(g);vec2 f=fract(g)-.5;',
    ' float r=h(id);vec2 o=vec2(h(id+3.1),h(id+7.7))-.5;',
    ' float dust=smoothstep(.09,0.,length(f-o*.7))*step(.72,r)*(.5+.5*sin(uTime*1.7+r*40.));',
    ' vec3 warm=vec3(1.,.77,.42);vec3 pale=vec3(1.,.95,.84);vec3 cool=vec3(.47,.88,1.);',
    ' vec3 lc=mix(mix(warm,pale,smoothstep(0.,.6,along)),cool,edge*edge*.55);',
    ' float beam=cone*fall*uPower;',
    ' vec3 col=vec3(.027,.039,.094);', // ink
    ' col+=vec3(.05,.035,.12)*(1.-uv.y);', // dusk at the bottom
    ' float pool=exp(-length(p-aim)*2.4)*.22*uPower;', // light pooling where the beam lands
    ' col+=pale*pool;',
    ' col+=lc*beam*(.10+.30*smoke);',
    ' col+=pale*dust*beam*1.4;',
    ' col+=warm*exp(-length(p-src)*5.)*.55*uPower;', // lamp glow at the source
    ' float vig=smoothstep(1.35,.35,length(uv-.5));col*=.55+.45*vig;',
    ' gl_FragColor=vec4(col,1.);',
    '}',
  ].join('\n');

  function beam(canvas, opts) {
    opts = opts || {};
    var tier = window.LumioTier || 'full';
    if (tier === 'basic') { document.documentElement.classList.add('no-gl'); return null; } // TVs/old devices: painted background only
    var gl = null;
    try { gl = canvas.getContext('webgl', { antialias: false, depth: false, alpha: false, powerPreference: 'low-power' }); } catch (e) { gl = null; }
    if (!gl) { document.documentElement.classList.add('no-gl'); return null; }
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { document.documentElement.classList.add('no-gl'); return null; }
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {};
    ['uRes', 'uTime', 'uAim', 'uPower', 'uSrc'].forEach(function (k) { U[k] = gl.getUniformLocation(prog, k); });

    var scale = opts.scale || (tier === 'lite' ? 0.32 : 0.5);
    var frameMs = tier === 'lite' ? 50 : 33; // lite: ~20 fps, full: ~30 fps
    var power = opts.power == null ? 1 : opts.power;
    var targetPower = power;
    var aim = { x: 0.72, y: 0.42 }, aimT = { x: 0.72, y: 0.42 };
    var src = opts.src || { x: -0.04, y: 1.06 };
    var pointer = { x: 0, y: 0 };
    var running = false, raf = 0, last = 0, t0 = performance.now(), slow = 0, giveUps = 0;

    function resize() {
      var w = Math.max(1, Math.round(innerWidth * scale)), hgt = Math.max(1, Math.round(innerHeight * scale));
      if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; gl.viewport(0, 0, w, hgt); }
    }
    function draw(now) {
      resize();
      aim.x += (aimT.x + pointer.x * 0.03 - aim.x) * 0.06;
      aim.y += (aimT.y + pointer.y * 0.03 - aim.y) * 0.06;
      power += (targetPower - power) * 0.3;
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uTime, (now - t0) / 1000);
      gl.uniform2f(U.uAim, aim.x, aim.y);
      gl.uniform2f(U.uSrc, src.x, src.y);
      gl.uniform1f(U.uPower, power);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function frame(now) {
      raf = 0;
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (now - last < frameMs) return; // the haze drifts slowly: no need for 60 fps
      var dt = now - last;
      last = now;
      draw(now);
      // adaptive quality: if frames keep arriving late, render fewer pixels
      if (dt > frameMs * 2) {
        if (++slow > 20) {
          slow = 0;
          if (scale > 0.25) scale = Math.max(0.25, scale * 0.8);
          else if (++giveUps > 2) { // still too slow at the lowest quality: switch this device to the light look
            stop(); canvas.style.display = 'none';
            document.documentElement.classList.add('no-gl');
            if (window.LumioSetTier && window.LumioTier === 'full') window.LumioSetTier('lite');
          }
        }
      } else slow = Math.max(0, slow - 1);
    }
    function start() {
      if (reduced) { draw(performance.now() + 4000); return; }
      if (running || document.hidden) return;
      running = true;
      if (!raf) raf = requestAnimationFrame(frame);
    }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    addEventListener('resize', function () { if (reduced) draw(performance.now() + 4000); });
    addEventListener('pointermove', function (e) {
      pointer.x = e.clientX / innerWidth - 0.5;
      pointer.y = 0.5 - e.clientY / innerHeight;
    }, { passive: true });

    // the lamp "strikes": a short flicker as the page opens (once, then steady)
    if (!reduced && opts.ignite !== false) {
      var finalPower = targetPower;
      targetPower = 0; power = 0;
      [[140, 0.75], [210, 0.12], [330, 1.15], [420, 0.55], [600, finalPower]].forEach(function (s) {
        setTimeout(function () { targetPower = s[1]; }, s[0]);
      });
    }
    start();

    return {
      pause: stop,
      resume: start,
      /** Points the beam at an element (e.g. the hero screen) or a viewport fraction. */
      aimAt: function (target) {
        if (target && target.getBoundingClientRect) {
          var r = target.getBoundingClientRect();
          aimT.x = (r.left + r.width / 2) / innerWidth;
          aimT.y = 1 - (r.top + r.height / 2) / innerHeight;
        } else if (target) { aimT.x = target.x; aimT.y = target.y; }
        if (reduced) { aim.x = aimT.x; aim.y = aimT.y; draw(performance.now() + 4000); }
      },
      power: function (p) { targetPower = p; if (reduced) { power = p; draw(performance.now() + 4000); } },
    };
  }

  // ---------- 3D tilt + glare (delegated) ----------
  var tiltBound = false;
  function tilt() {
    if (tiltBound || reduced || (window.LumioTier && window.LumioTier !== 'full')) return;
    tiltBound = true;
    var current = null;
    function reset(el) {
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
      el.classList.remove('tilting');
    }
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      var el = e.target.closest ? e.target.closest('.tilt') : null;
      if (current && current !== el) { reset(current); current = null; }
      if (!el) return;
      current = el;
      var r = el.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      var max = Number(el.getAttribute('data-tilt')) || 10;
      el.style.setProperty('--rx', ((0.5 - y) * max).toFixed(2) + 'deg');
      el.style.setProperty('--ry', ((x - 0.5) * max).toFixed(2) + 'deg');
      el.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
      el.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      el.classList.add('tilting');
    }, { passive: true });
    document.addEventListener('pointerleave', function () { if (current) { reset(current); current = null; } });
  }

  window.LumioFX = { beam: beam, tilt: tilt, reduced: reduced };
})();
