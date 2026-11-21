// Startup guard. Lives in its own file (not inline) so /app can use a strict
// Content-Security-Policy with no 'unsafe-inline' anywhere.
// If the app script cannot run (missing file, old cached copy, browser too old) say so
// instead of hanging on "Connecting...".
(function () {
  function fail(why) {
    if (window.__ghostBooted || window.__ghostFailShown) return;
    window.__ghostFailShown = true;
    var s = document.getElementById('status-bar');
    if (s) { s.textContent = 'App could not start'; s.className = 'status-badge offline'; }
    var c = document.getElementById('chat-box');
    if (c) {
      var d = document.createElement('div');
      d.className = 'msg sys';
      d.textContent = 'Ghost Talk could not start (' + why + '). Reload the page. If this keeps happening, a file is missing on the server: app.js, e2e.js and security.js must all be in the public folder.';
      c.appendChild(d);
    }
  }
  window.__ghostFail = fail;
  window.addEventListener('error', function (e) { fail(e && e.message ? e.message : 'script error'); });
  setTimeout(function () { fail('the app script did not load'); }, 6000);
})();
