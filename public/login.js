'use strict';
(function () {
  var form = document.getElementById('login');
  var err = document.getElementById('error');
  var device = document.getElementById('device');

  function guessName() {
    var ua = navigator.userAgent;
    if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|AFT|CrKey|Android TV/i.test(ua)) return 'TV';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
    if (/Macintosh/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Linux/i.test(ua)) return 'Linux PC';
    return 'My device';
  }
  device.value = guessName();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var btn = form.querySelector('button');
    btn.disabled = true;
    fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value, deviceName: device.value }),
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || 'Sign in failed');
        location.replace('/');
      });
    }).catch(function (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
    });
  });
})();
