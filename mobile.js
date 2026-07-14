/*
 * Kitazo — TV Time Extractor MOBILE driver.
 *
 * The Chrome extension can't run on phones. This is the in-page equivalent: it
 * reuses the EXACT same extraction (inject.js) and conversion (converter.js) as
 * the desktop extension, driven from the page itself instead of the popup —
 * so it works from any mobile browser (loaded via a bookmarklet / loader).
 *
 * How it reuses the extension untouched:
 *   • inject.js relays every step with window.postMessage({__tvtimeExport,...}).
 *   • The desktop popup accumulates those into `pulls` and hands them to the
 *     converter. This driver listens for the same messages and does the same.
 *   • At the end the user chooses: send everything straight to Kitazo, or
 *     download the archive (then import it in the app).
 *
 * Expects window.TVTimeConverter (converter.js) and inject.js to be loaded first
 * (the loader does that). Safe to run more than once — it guards re-entry.
 */
(function () {
  'use strict';
  if (window.__kitazoMobileRunning) return;
  window.__kitazoMobileRunning = true;

  // Base API + the one-time upload token, both injected by the personalized
  // bookmarklet the user copies from Kitazo (Impostazioni → Importa → Mobile).
  // The token ties the upload to their account — you must be registered + signed
  // in to Kitazo to get it, so there are never orphan uploads.
  var API_BASE = window.__KITAZO_API || 'https://kitazo.app';
  var UPLOAD_TOKEN = window.__KITAZO_UPLOAD_TOKEN || '';

  // Keep the screen awake during the (possibly long) extraction so the mobile
  // browser doesn't throttle/suspend the tab. Best-effort; re-acquired if the tab
  // is briefly hidden and shown again.
  var wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !wakeLock) keepAwake();
  });
  keepAwake();

  var T = (navigator.language || 'it').slice(0, 2) === 'en' ? {
    starting: 'Starting…', scanning: 'Extracting your TV Time data…',
    keepOpen: 'Keep this tab open until it finishes.',
    done: 'Extraction complete', chooseWhat: 'What do you want to do?',
    send: 'Send to Kitazo', download: 'Download archive',
    sending: 'Sending to Kitazo…', opening: 'Opening Kitazo…',
    building: 'Preparing the archive…', downloaded: 'Archive downloaded.',
    sendErr: 'Send failed. Get a fresh link from Kitazo and try again.',
    noToken: 'Missing upload token — copy the bookmarklet again from Kitazo (Settings → Import → Mobile).',
    noUid: 'Could not find your TV Time user id. Open your TV Time profile page, then run it again.',
    close: 'Close',
  } : {
    starting: 'Avvio…', scanning: 'Sto estraendo i tuoi dati TV Time…',
    keepOpen: 'Tieni questa scheda aperta fino alla fine.',
    done: 'Estrazione completata', chooseWhat: 'Cosa vuoi fare?',
    send: 'Invia a Kitazo', download: 'Scarica archivio',
    sending: 'Invio a Kitazo…', opening: 'Apro Kitazo…',
    building: 'Preparo l’archivio…', downloaded: 'Archivio scaricato.',
    sendErr: 'Invio fallito. Prendi un nuovo link da Kitazo e riprova.',
    noToken: 'Token mancante — ricopia il bookmarklet da Kitazo (Impostazioni → Importa → Mobile).',
    noUid: 'User id TV Time non trovato. Apri la tua pagina profilo su TV Time e riprova.',
    close: 'Chiudi',
  };

  // ---- Minimal in-page overlay UI (self-contained styles) -------------------
  var root = document.createElement('div');
  root.setAttribute('style', [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:rgba(14,11,22,0.92)', 'display:flex', 'align-items:center',
    'justify-content:center', 'padding:20px', 'box-sizing:border-box',
    'font-family:-apple-system,Segoe UI,Roboto,sans-serif', '-webkit-font-smoothing:antialiased',
  ].join(';'));
  var card = document.createElement('div');
  card.setAttribute('style', [
    'width:100%', 'max-width:400px', 'background:#1a1426', 'border:1px solid #2e2440',
    'border-radius:18px', 'padding:22px', 'color:#ECE7F0', 'text-align:center',
    'box-shadow:0 20px 60px rgba(0,0,0,0.5)',
  ].join(';'));
  root.appendChild(card);

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function h(html) { card.innerHTML = html; }
  function btn(label, primary) {
    return '<button data-k="1" style="width:100%;margin-top:10px;padding:13px;border-radius:12px;border:0;' +
      'font-size:15px;font-weight:800;cursor:pointer;' +
      (primary ? 'background:#8B5CF6;color:#fff' : 'background:#241b34;color:#ECE7F0;border:1px solid #3a2f4d') +
      '">' + esc(label) + '</button>';
  }
  function cleanup() { try { root.remove(); } catch (e) {} window.__kitazoMobileRunning = false; }

  function showProgress(pct, note) {
    h(
      '<div style="font-size:26px;margin-bottom:6px">📺</div>' +
      '<div style="font-size:17px;font-weight:800;margin-bottom:4px">Kitazo</div>' +
      '<div style="font-size:13px;color:#B9A8D6;margin-bottom:14px">' + esc(T.scanning) + '</div>' +
      '<div style="height:8px;background:#241b34;border-radius:6px;overflow:hidden">' +
      '<div style="height:100%;width:' + Math.max(3, Math.min(100, pct || 0)) + '%;background:#8B5CF6;transition:width .3s"></div></div>' +
      '<div style="font-size:12px;color:#6f6483;margin-top:10px">' + esc(note || T.keepOpen) + '</div>'
    );
  }

  document.documentElement.appendChild(root);
  showProgress(3, T.starting);

  // ---- Accumulate the extractor's relay messages (same shape as the popup) ---
  var pulls = [];
  var total = 0, done = 0, jwt = null, uid = null, finished = false;

  function onMsg(ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || typeof d !== 'object' || !d.__tvtimeExport) return;
    switch (d.__tvtimeExport) {
      case 'token': if (d.jwt) jwt = d.jwt; break;
      case 'uid': if (d.uid) uid = d.uid; break;
      case 'pullStart': total = d.total || 0; done = 0; showProgress(5); break;
      case 'pullSetTotal': total = d.total || total; break;
      case 'pullSetTotalAdd': total += (d.total || 0); break;
      case 'pullResult':
        pulls.push({ label: d.label, target: d.target, status: d.status, ok: d.ok, data: d.data });
        break;
      case 'pullProgress': done = d.done || done; showProgress(total ? (done / total) * 95 : 20); break;
      case 'pullProgressAdd': done += (d.add || 1); showProgress(total ? (done / total) * 95 : 20); break;
      case 'pullDone':
        if (finished) break;
        finished = true;
        if (d.error) { showError(d.error); break; }
        finalize();
        break;
      default: break;
    }
  }
  window.addEventListener('message', onMsg);

  function buildRaw() {
    return {
      exportedAt: new Date().toISOString(),
      consent: {
        given: true,
        statement: 'L’utente ha confermato di esportare i propri dati personali per uso personale / portabilità.',
        timestamp: new Date().toISOString(),
      },
      pulls: pulls.map(function (p) { return { label: p.label, target: p.target, status: p.status, ok: p.ok, data: p.data }; }),
    };
  }

  function showError(msg) {
    h('<div style="font-size:26px">⚠️</div><div style="font-size:15px;margin:10px 0;color:#ECE7F0">' + esc(msg) + '</div>' + btn(T.close));
    card.querySelector('button').onclick = cleanup;
  }

  // ---- End of run: send the data straight to Kitazo (no archive download). ---
  // Everyone who uses the service goes through the app: we park the archive as a
  // one-time handoff (no account needed yet), then open the Kitazo universal link
  // — the APP if installed, otherwise the website. The user logs in or registers
  // and the import is waiting on their profile; the handoff is claimed once
  // they're authenticated. No file, no manual code.
  function finalize() {
    h(
      '<div style="font-size:30px;margin-bottom:6px">✅</div>' +
      '<div style="font-size:18px;font-weight:800">' + esc(T.done) + '</div>' +
      '<div id="k-send" style="margin-top:14px">' + btn(T.send, true) + '</div>' +
      '<div id="k-msg" style="font-size:12px;color:#6f6483;margin-top:12px"></div>' +
      '<div id="k-close" style="margin-top:6px">' + btn(T.close) + '</div>'
    );
    var msg = card.querySelector('#k-msg');
    card.querySelector('#k-close button').onclick = cleanup;
    card.querySelector('#k-send button').onclick = doSend;
    function setMsg(s) { msg.textContent = s; }

    async function doSend() {
      if (!UPLOAD_TOKEN) { setMsg(T.noToken); return; }
      setMsg(T.building);
      try {
        var blob = await window.TVTimeConverter.buildZipBlob(buildRaw());
        var b64 = await blobToBase64(blob);
        setMsg(T.sending);
        var res = await fetch(API_BASE + '/api/handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: UPLOAD_TOKEN, zipBase64: b64 }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        setMsg(T.opening);
        // Straight to Kitazo (app if installed, else the site). The import page
        // sees the parked archive on the account and runs it in the background.
        window.location.href = API_BASE + '/import?imported=1';
      } catch (e) {
        setMsg(T.sendErr);
      }
    }
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ---- Kick off: give inject.js a moment to capture uid/token from the SPA's
  // ambient API traffic, then start the same pull the popup triggers. ----------
  setTimeout(function () {
    window.postMessage({ __tvtimeExport: 'startPull', jwt: jwt, uid: uid, deepVotes: true }, '*');
  }, 2500);
})();
