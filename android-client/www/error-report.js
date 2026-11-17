/* 0.2.4.15: report uncaught errors on this phone to our own server (POST /api/client-errors) so the admin console
   shows what breaks before a farmer has to say so. No third-party service, signed-in accounts only, at most ten
   distinct reports per page load, sent when online. Loaded right after polyfills so later scripts are covered. */
(function installErrorReport(root) {
  'use strict';
  const release = (document.querySelector('meta[name="jk-release"]') || {}).content || '';
  const queue = [], seen = new Set();
  let budget = 10, timer = null;
  const signedIn = () => { try { return typeof currentAccount !== 'undefined' && !!currentAccount && typeof api === 'function'; } catch (_) { return false; } };
  const view = () => { try { return typeof currentMenuName !== 'undefined' ? String(currentMenuName) : ''; } catch (_) { return ''; } };
  const native = () => !!(root.JagaNative && typeof root.JagaNative.isNative === 'function' && root.JagaNative.isNative());
  function flush() {
    timer = null;
    if (!queue.length) return;
    if (!signedIn() || root.navigator.onLine === false) { timer = setTimeout(flush, 30000); return; }
    api('/api/client-errors', { method: 'POST', body: queue.shift() }).catch(() => {})
      .finally(() => { if (queue.length && !timer) timer = setTimeout(flush, 1000); });
  }
  // "at fn (https://jagake.bond/app.js?v=41:812:5)" -> app.js, 812
  function frame(stack) {
    const m = /([A-Za-z0-9_.-]+\.js)(?:\?[^:\s)]*)?:(\d+):\d+/.exec(String(stack || ''));
    return m ? { source: m[1], line: Number(m[2]) } : { source: '', line: null };
  }
  function report(kind, message, source, line) {
    message = String(message || '').slice(0, 400);
    if (!message || budget <= 0) return;
    if (/^Script error\.?$/i.test(message) || /-extension:\/\//.test(String(source || ''))) return;   // not our code
    const key = kind + '|' + message + '|' + source + '|' + line;
    if (seen.has(key)) return;
    seen.add(key); budget -= 1;
    queue.push({ kind, message, source: String(source || '').slice(0, 300), line: Number.isInteger(line) ? line : null,
      release, view: view(), native: native() });
    if (!timer) timer = setTimeout(flush, 2000);
  }
  root.addEventListener('error', event => {
    if (event && event.message) report('error', event.message, event.filename, event.lineno);
  });
  root.addEventListener('unhandledrejection', event => {
    const reason = event && event.reason;
    const message = reason && (reason.message || String(reason));
    // Failures the app already explains to the farmer (no signal, session ended, stale account) are not bugs.
    if (!message || (reason && (reason.offline || reason.timedOut || reason.stale || reason.accountMismatch)) ||
        /failed to fetch|networkerror|load failed|abort|reanalysis_stale/i.test(message)) return;
    const where = frame(reason && reason.stack);
    report('rejection', message, where.source, where.line);
  });
  root.JagaErrorReport = { report };
})(window);
