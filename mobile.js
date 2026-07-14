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
    sendErr: 'Link expired. Copy a fresh bookmarklet from Kitazo (Import → Mobile) and run it again.',
    tooLarge: 'Your library is too large to send this way. Use the desktop extension for this account.',
    netErr: 'Network error — check your connection and tap Send again.',
    noToken: 'Missing upload token — copy the bookmarklet again from Kitazo (Settings → Import → Mobile).',
    noUid: 'Could not find your TV Time user id. Open your TV Time profile page, then run it again.',
    close: 'Close',
    minLeft: 'min left', secLeft: 'sec left', almostDone: 'Almost done…',
    stop: 'Stop', stopped: 'Extraction stopped.',
    chooseHeading: 'Ready to extract your TV Time data',
    inclChars: 'Include voted characters',
    charsNote: 'This scans every watched episode for character votes. It can take a lot longer depending on how many series you have marked in your account — turn it off for a much faster export.',
    startBtn: 'Start extraction',
  } : {
    starting: 'Avvio…', scanning: 'Sto estraendo i tuoi dati TV Time…',
    keepOpen: 'Tieni questa scheda aperta fino alla fine.',
    done: 'Estrazione completata', chooseWhat: 'Cosa vuoi fare?',
    send: 'Invia a Kitazo', download: 'Scarica archivio',
    sending: 'Invio a Kitazo…', opening: 'Apro Kitazo…',
    building: 'Preparo l’archivio…', downloaded: 'Archivio scaricato.',
    sendErr: 'Link scaduto. Copia un nuovo bookmarklet da Kitazo (Importa → Mobile) e riavvialo.',
    tooLarge: 'La tua libreria è troppo grande per questo metodo. Per questo account usa l’estensione desktop.',
    netErr: 'Errore di rete — controlla la connessione e ripremi Invia.',
    noToken: 'Token mancante — ricopia il bookmarklet da Kitazo (Impostazioni → Importa → Mobile).',
    noUid: 'User id TV Time non trovato. Apri la tua pagina profilo su TV Time e riprova.',
    close: 'Chiudi',
    minLeft: 'min rimasti', secLeft: 'sec rimasti', almostDone: 'Quasi finito…',
    stop: 'Interrompi', stopped: 'Estrazione interrotta.',
    chooseHeading: 'Pronto per estrarre i tuoi dati TV Time',
    inclChars: 'Includi i personaggi votati',
    charsNote: 'Controlla i voti ai personaggi episodio per episodio. Può metterci molto di più in base a quante serie hai segnate nell’account — disattivalo per un export molto più veloce.',
    startBtn: 'Avvia estrazione',
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
    'width:100%', 'max-width:400px', 'background:rgb(26,20,38)', 'border:1px solid rgb(46,36,64)',
    'border-radius:18px', 'padding:22px', 'color:rgb(236,231,240)', 'text-align:center',
    'box-shadow:0 20px 60px rgba(0,0,0,0.5)',
  ].join(';'));
  root.appendChild(card);

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function h(html) { card.innerHTML = html; }
  function btn(label, primary) {
    return '<button data-k="1" style="width:100%;margin-top:10px;padding:13px;border-radius:12px;border:0;' +
      'font-size:15px;font-weight:800;cursor:pointer;' +
      (primary ? 'background:rgb(139,92,246);color:rgb(255,255,255)' : 'background:rgb(36,27,52);color:rgb(236,231,240);border:1px solid rgb(58,47,77)') +
      '">' + esc(label) + '</button>';
  }
  function cleanup() { try { root.remove(); } catch (e) {} window.__kitazoMobileRunning = false; }

  // Rough time-remaining estimate from how fast pulls are completing.
  function etaText() {
    if (!startTs || !total || done <= 0) return T.keepOpen;
    var elapsed = (Date.now() - startTs) / 1000;
    if (elapsed < 2) return T.keepOpen;
    var rate = done / elapsed;
    if (rate <= 0) return T.keepOpen;
    var remain = (total - done) / rate;
    if (remain <= 3) return T.almostDone;
    if (remain < 60) return '~' + Math.ceil(remain) + ' ' + T.secLeft;
    return '~' + Math.ceil(remain / 60) + ' ' + T.minLeft;
  }

  function showProgress(pct, note) {
    var p = Math.max(3, Math.min(100, pct || 0));
    h(
      '<div style="font-size:26px;margin-bottom:6px">📺</div>' +
      '<div style="font-size:17px;font-weight:800;margin-bottom:4px">Kitazo</div>' +
      '<div style="font-size:13px;color:rgb(185,168,214);margin-bottom:12px">' + esc(T.scanning) + '</div>' +
      '<div style="font-size:30px;font-weight:900;color:rgb(236,231,240);margin-bottom:10px">' + Math.round(p) + '%</div>' +
      '<div style="height:8px;background:rgb(36,27,52);border-radius:6px;overflow:hidden">' +
      '<div style="height:100%;width:' + p + '%;background:rgb(139,92,246);transition:width .3s"></div></div>' +
      '<div style="font-size:12px;color:rgb(111,100,131);margin-top:10px">' + esc(note || etaText()) + '</div>' +
      '<div id="k-stop">' + btn(T.stop) + '</div>'
    );
    var s = card.querySelector('[id=k-stop] button');
    if (s) s.onclick = doAbort;
  }

  // Stop an in-flight extraction: tell inject.js to bail out of its loops, mark
  // ourselves finished so a late pullDone can't trigger the upload, then close.
  function doAbort() {
    finished = true;
    try { window.postMessage({ __tvtimeExport: 'abortPull' }, '*'); } catch (e) {}
    cleanup();
  }

  // First screen: let the user opt in/out of the slow per-episode character-vote
  // pass BEFORE anything starts. On by default (matches the desktop extension),
  // but flagged as the part that gets much longer the more series are marked.
  function showStart() {
    h(
      '<div style="font-size:26px;margin-bottom:6px">📺</div>' +
      '<div style="font-size:18px;font-weight:800;margin-bottom:4px">Kitazo</div>' +
      '<div style="font-size:13px;color:rgb(185,168,214);margin-bottom:16px">' + esc(T.chooseHeading) + '</div>' +
      '<label style="display:flex;align-items:flex-start;gap:10px;text-align:left;background:rgb(36,27,52);' +
        'border:1px solid rgb(58,47,77);border-radius:12px;padding:12px;cursor:pointer">' +
        '<input id="k-chars" type="checkbox" checked style="width:20px;height:20px;margin-top:1px;accent-color:rgb(139,92,246);flex:0 0 auto">' +
        '<span><span style="font-size:14px;font-weight:700;color:rgb(236,231,240)">' + esc(T.inclChars) + '</span>' +
        '<span style="display:block;font-size:12px;color:rgb(154,143,176);margin-top:4px;line-height:1.45">' + esc(T.charsNote) + '</span></span>' +
      '</label>' +
      '<div id="k-go">' + btn(T.startBtn, true) + '</div>'
    );
    card.querySelector('[id=k-go] button').onclick = function () {
      var deep = card.querySelector('[id=k-chars]').checked;
      begin(deep);
    };
  }

  // Kick off: resolve identity, then give the app a short window to reveal its
  // API key (its hook captures it from the app's own live requests — needed for
  // the direct fallback when the sidecar 502s). Nudge the app into making a
  // request by re-focusing the tab, then start the pull (after ~6s at the latest
  // so it never hangs).
  function begin(deepVotes) {
    showProgress(3, T.starting);
    if (!uid || !jwt) {
      var found0 = findIdentity();
      if (!uid) uid = found0.uid;
      if (!jwt) jwt = found0.jwt;
    }
    // The listener (inject.js) is now active but the app is idle, so it won't
    // reveal its API key on its own. FORCE it to make a request by driving its
    // in-page (SPA) router through a few data routes — those fetches carry the
    // API-key header, which the hook then captures for the direct fallback.
    forceAppRequests();
    var waited = 0;
    (function waitKey() {
      if (!apiKeyHave && waited < 8000) {
        if (waited === 3000 || waited === 6000) forceAppRequests(); // nudge again
        waited += 500;
        setTimeout(waitKey, 500);
        return;
      }
      window.postMessage({ __tvtimeExport: 'startPull', jwt: jwt, uid: uid, deepVotes: deepVotes }, '*');
    })();
  }

  // Nudge the TV Time SPA into fetching so its API-key header goes over the wire
  // (the overlay hides any visual churn; we navigate away to Kitazo at the end).
  function forceAppRequests() {
    try { window.dispatchEvent(new Event('focus')); } catch (e) {}
    try { window.dispatchEvent(new Event('online')); } catch (e) {}
    var routes = ['/', '/user/' + (uid || ''), '/to-watch', '/upcoming', '/home'];
    routes.forEach(function (r, i) {
      setTimeout(function () {
        try {
          history.pushState({}, '', r);
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        } catch (e) {}
      }, i * 350);
    });
  }

  document.documentElement.appendChild(root);
  showStart();

  // ---- Accumulate the extractor's relay messages (same shape as the popup) ---
  var pulls = [];
  var total = 0, done = 0, jwt = null, uid = null, finished = false, startTs = 0, apiKeyHave = false;

  function onMsg(ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || typeof d !== 'object' || !d.__tvtimeExport) return;
    switch (d.__tvtimeExport) {
      case 'token': if (d.jwt) jwt = d.jwt; break;
      case 'uid': if (d.uid) uid = d.uid; break;
      case 'apikey': apiKeyHave = true; break;
      case 'pullStart': total = d.total || 0; done = 0; startTs = Date.now(); showProgress(5); break;
      case 'pullSetTotal': total = d.total || total; break;
      case 'pullSetTotalAdd': total += (d.total || 0); break;
      case 'pullResult':
        pulls.push({ label: d.label, target: d.target, status: d.status, ok: d.ok, data: d.data, body: d.body });
        break;
      case 'pullProgress': done = d.done || done; showProgress(total ? (done / total) * 95 : 20); break;
      case 'pullProgressAdd': done += (d.add || 1); showProgress(total ? (done / total) * 95 : 20); break;
      case 'pullDone':
        if (finished) break;
        finished = true;
        if (d.aborted) { cleanup(); break; }
        if (d.error) { showError(d.error); break; }
        finalize();
        break;
      default: break;
    }
  }
  window.addEventListener('message', onMsg);

  // Compact per-pull summary (label:[x]status[#itemcount]) — sent alongside the
  // upload so the server can show WHY series/films might be empty (auth failure
  // vs empty response) without shipping the raw data.
  function pullDiag() {
    return pulls
      .map(function (p) {
        var c = '';
        try {
          var d = p.data;
          var arr = d && d.data !== undefined ? d.data : d;
          if (Array.isArray(arr)) c = '=' + arr.length;
          else if (arr && Array.isArray(arr.objects)) c = '=' + arr.objects.length;
        } catch (e) {}
        return p.label + ':' + (p.ok ? '' : 'x') + p.status + c;
      })
      .join(' ');
  }

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
    h('<div style="font-size:26px">⚠️</div><div style="font-size:15px;margin:10px 0;color:rgb(236,231,240)">' + esc(msg) + '</div>' + btn(T.close));
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
      '<div id="k-msg" style="font-size:12px;color:rgb(111,100,131);margin-top:12px"></div>' +
      '<div id="k-close" style="margin-top:6px">' + btn(T.close) + '</div>'
    );
    var msg = card.querySelector('[id=k-msg]');
    card.querySelector('[id=k-close] button').onclick = cleanup;
    card.querySelector('[id=k-send] button').onclick = doSend;
    function setMsg(s) { msg.textContent = s; }

    // Build the archive once and keep it, so a retry (e.g. after a flaky network)
    // doesn't re-zip the whole library.
    var cachedB64 = null;

    async function doSend() {
      if (!UPLOAD_TOKEN) { setMsg(T.noToken); return; }
      try {
        if (!cachedB64) {
          setMsg(T.building);
          var blob = await window.TVTimeConverter.buildZipBlob(buildRaw());
          cachedB64 = await blobToBase64(blob);
        }
      } catch (e) {
        setMsg(T.netErr);
        return;
      }
      setMsg(T.opening);
      // Send by SUBMITTING A FORM, not fetch/XHR. TV Time's CSP `connect-src`
      // blocks fetch to the Kitazo API (iOS Safari enforces it strictly), but a
      // form submission is a top-level NAVIGATION governed by `form-action`
      // (which TV Time doesn't restrict). The server imports the archive and
      // redirects us back into Kitazo, where the import shows up. No file, no
      // manual step, everything stays in the browser.
      //
      // Convert to base64url (+ → -, / → _, drop =) so the archive can't be
      // corrupted by form-urlencoding, where a raw "+" decodes to a space and
      // would silently break the zip. The server converts it back.
      var b64url = cachedB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      var f = document.createElement('form');
      f.method = 'POST';
      f.action = API_BASE + '/api/handoff/form';
      f.acceptCharset = 'utf-8';
      f.style.display = 'none';
      f.appendChild(hidden('token', UPLOAD_TOKEN));
      f.appendChild(hidden('zipBase64', b64url));
      var firstFail = null;
      for (var fi = 0; fi < pulls.length; fi++) { if (!pulls[fi].ok && pulls[fi].body) { firstFail = pulls[fi]; break; } }
      f.appendChild(hidden('diag',
        'page=' + location.origin + ' uid=' + (uid || '?') + ' jwt=' + (jwt ? 'y' : 'n') + ' apikey=' + (apiKeyHave ? 'y' : 'n') +
        ' | ' + pullDiag() +
        (firstFail ? ' || ' + firstFail.label + ' body: ' + firstFail.body : '')));
      document.body.appendChild(f);
      f.submit();
    }
  }

  function hidden(name, value) {
    var i = document.createElement('input');
    i.type = 'hidden';
    i.name = name;
    i.value = value;
    return i;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ---- Find the TV Time user id + token WITHOUT relying on captured network
  // traffic. The desktop extension hooks fetch at document_start and reads the id
  // from API calls; a bookmarklet loads AFTER those calls, so it must dig the id
  // out of the page itself: the URL, or (mainly) the JWT that TV Time stores in
  // localStorage/sessionStorage/cookies — its payload carries the numeric user id.
  function b64urlDecode(s) {
    try { return atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); } catch (e) { return ''; }
  }
  function uidFromJwt(tk) {
    try {
      var p = JSON.parse(b64urlDecode(tk.split('.')[1]));
      var cand = [p.sub, p.user_id, p.userId, p.uid, p.id, p.user && p.user.id, p.data && p.data.id];
      for (var i = 0; i < cand.length; i++) {
        if (cand[i] != null && /^\d{3,}$/.test(String(cand[i]))) return { uid: String(cand[i]), jwt: tk };
      }
    } catch (e) {}
    return null;
  }
  function findIdentity() {
    // 1) URL (some TV Time routes carry it).
    var m = /\/user[s]?\/(\d{3,})/.exec(location.href);
    if (m) return { uid: m[1], jwt: null };
    // 2) Any JWT stored on the page → decode its user id.
    var blobs = [];
    try { for (var i = 0; i < localStorage.length; i++) blobs.push(localStorage.getItem(localStorage.key(i))); } catch (e) {}
    try { for (var j = 0; j < sessionStorage.length; j++) blobs.push(sessionStorage.getItem(sessionStorage.key(j))); } catch (e) {}
    try { blobs.push(document.cookie); } catch (e) {}
    for (var k = 0; k < blobs.length; k++) {
      var jwts = String(blobs[k] || '').match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
      if (!jwts) continue;
      for (var n = 0; n < jwts.length; n++) { var r = uidFromJwt(jwts[n]); if (r) return r; }
    }
    return { uid: null, jwt: null };
  }
})();
