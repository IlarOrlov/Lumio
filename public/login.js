'use strict';
(function () {
  var form = document.getElementById('login');
  var err = document.getElementById('error');
  var pw = document.getElementById('password');
  var device = document.getElementById('device');
  var presets = document.getElementById('presets');

  // Back from the plain-form sign-in (no script)? Show why, and keep the address bar clean.
  var e = /[?&]e=(wrong|locked)/.exec(location.search);
  if (e) err.textContent = e[1] === 'locked' ? 'Too many failed attempts. Wait a minute and try again.' : 'That password doesn\'t match. Use the household password from Lumio\'s setup.';
  if (location.search && window.history && history.replaceState) history.replaceState(null, '', '/login');

  if (window.LumioFX) {
    var stage = LumioFX.beam(document.getElementById('room'), { power: 1 });
    LumioFX.tilt();
    if (stage) { stage.aimAt(form); addEventListener('resize', function () { stage.aimAt(form); }); }
  }

  function guessName() {
    var ua = navigator.userAgent;
    if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|AFT|CrKey|Android TV/i.test(ua)) return 'Living room TV';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
    if (/Macintosh/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Linux/i.test(ua)) return 'Linux PC';
    return 'My device';
  }
  var guess = guessName();
  device.value = guess;
  [guess, 'Living room TV', 'Bedroom TV', 'Phone', 'Tablet', 'Laptop'].filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 5).forEach(function (name) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'preset' + (name === guess ? ' on' : ''); b.textContent = name;
    b.addEventListener('click', function () {
      device.value = name;
      Array.prototype.forEach.call(presets.children, function (c) { c.classList.toggle('on', c === b); });
    });
    presets.appendChild(b);
  });
  device.addEventListener('input', function () {
    Array.prototype.forEach.call(presets.children, function (c) { c.classList.toggle('on', c.textContent === device.value); });
  });

  document.getElementById('reveal').addEventListener('click', function (e) {
    var show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.target.textContent = show ? 'Hide' : 'Show';
    pw.focus();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    if (!pw.value) { err.textContent = 'Enter the household password.'; pw.focus(); return; }
    if (!device.value.trim()) { err.textContent = 'Give this device a name, for example "Living room TV".'; device.focus(); return; }
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Signing in';
    fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw.value, deviceName: device.value.trim() }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (r.status === 401) throw new Error('That password doesn\'t match. Use the household password from Lumio\'s setup. You can set a new one in the Lumio admin console under Network & Security.');
        if (!r.ok) throw new Error(body.error || 'Sign-in failed. Try again.');
        location.replace('/');
      });
    }).catch(function (e2) {
      err.textContent = e2.message === 'Failed to fetch' ? 'Lumio isn\'t reachable. Check that this device is on your home network.' : e2.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
      pw.select();
    });
  });
})();
