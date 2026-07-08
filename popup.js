const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);

// --- i18n -------------------------------------------------------------------
// Tutte le stringhe dell'interfaccia in italiano e inglese. I valori possono
// essere stringhe o funzioni (per i testi con parametri).
const I18N = {
  it: {
    refreshTitle: "Ricomincia da capo se si blocca",
    deepTitle: "Trova i personaggi preferiti dei singoli episodi",
    deepWarn: "Serve SOLO a questo. Scansiona gli episodi visti uno per uno (di solito 1-2 minuti). Se la togli, tutto il resto — visti, film, rating, liste, commenti, preferiti — viene scaricato comunque. Lascia la scheda aperta fino alla fine.",
    consentText: "Confermo che questi sono i <b>miei</b> dati personali su TV Time e che voglio esportarli per uso personale o per trasferirli a un servizio di mia scelta (portabilità dei dati). Non esporterò dati di altri utenti.",
    exportBtn: "Scarica i miei dati (ZIP)",
    clearBtn: "Svuota",
    exportRawBtn: "⚙ Scarica JSON grezzo (debug)",

    tokenActive: (uid) => `Sessione attiva${uid ? ` · utente ${uid}` : ""}.`,
    tokenHint: "Per iniziare: apri la sezione Profilo su TV Time e ricarica la pagina.",
    pullDefault: "Scarica visti, film e show",
    pullRunning: (done, total) => (total ? `Scarico… ${done}/${total}` : "Scarico…"),
    progressRunning: (done, total) => (total ? `Raccolta in corso… ${done} di ${total}` : "Avvio della raccolta…"),
    progressDone: "Raccolta completata. Puoi scaricare.",

    sayReset: 'Reset eseguito. Puoi ripartire con "Scarica".',
    sayNoUid: "Apri la sezione Profilo su TV Time e ricarica la pagina, poi riprova.",
    sayNoTab: "Apri una scheda su app.tvtime.com, poi premi di nuovo.",
    sayPulling: "Scarico dalla pagina TV Time…",
    sayStarted: "Raccolta avviata. Su account grandi può richiedere qualche minuto: lascia la scheda aperta.",
    sayTabNoResponse: "La scheda TV Time non risponde: ricaricala e riprova.",
    sayNeedConsent: "Spunta prima la conferma di consenso per scaricare.",
    sayPreparingZip: "Preparo l'archivio…",
    sayZipDone: "Archivio scaricato: serie, film e liste.",
    sayConvertError: (e) => "Errore nella conversione: " + e,
    sayCleared: "Svuotato.",
    sayPreparingRaw: "Preparo il JSON grezzo…",
    sayRawDone: (n) => `JSON grezzo scaricato (${n} pull).`,
  },
  en: {
    refreshTitle: "Start over if it gets stuck",
    deepTitle: "Find your favourite characters for individual episodes",
    deepWarn: "This is ALL it does. It scans your watched episodes one by one (usually 1-2 minutes). If you untick it, everything else — watched, movies, ratings, lists, comments, favourites — is still downloaded. Keep the tab open until it finishes.",
    consentText: "I confirm that this is <b>my</b> personal TV Time data and that I want to export it for personal use or to move it to a service of my choice (data portability). I will not export other users' data.",
    exportBtn: "Download my data (ZIP)",
    clearBtn: "Clear",
    exportRawBtn: "⚙ Download raw JSON (debug)",

    tokenActive: (uid) => `Session active${uid ? ` · user ${uid}` : ""}.`,
    tokenHint: "To start: open your Profile section on TV Time and reload the page.",
    pullDefault: "Download watched, movies & shows",
    pullRunning: (done, total) => (total ? `Downloading… ${done}/${total}` : "Downloading…"),
    progressRunning: (done, total) => (total ? `Collecting… ${done} of ${total}` : "Starting…"),
    progressDone: "Done. You can download now.",

    sayReset: 'Reset done. You can start again with "Download".',
    sayNoUid: "Open your Profile section on TV Time and reload the page, then try again.",
    sayNoTab: "Open a tab on app.tvtime.com, then press again.",
    sayPulling: "Downloading from the TV Time page…",
    sayStarted: "Collection started. On large accounts it can take a few minutes: keep the tab open.",
    sayTabNoResponse: "The TV Time tab is not responding: reload it and try again.",
    sayNeedConsent: "Tick the consent confirmation first to download.",
    sayPreparingZip: "Preparing the archive…",
    sayZipDone: "Archive downloaded: shows, movies and lists.",
    sayConvertError: (e) => "Conversion error: " + e,
    sayCleared: "Cleared.",
    sayPreparingRaw: "Preparing the raw JSON…",
    sayRawDone: (n) => `Raw JSON downloaded (${n} pulls).`,
  },
};

let lang = "it";
function detectLang() {
  const saved = localStorage.getItem("kitazo_lang");
  if (saved === "it" || saved === "en") return saved;
  return (navigator.language || "").toLowerCase().startsWith("it") ? "it" : "en";
}
// t("key") o t("key", ...args) per i valori funzione.
function t(key, ...args) {
  const v = I18N[lang][key];
  return typeof v === "function" ? v(...args) : v;
}

// Applica le stringhe statiche (marcate con data-i18n / data-i18n-title).
function applyStaticI18n() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    if (val == null) continue;
    if (key === "consentText") el.innerHTML = val;   // contiene <b>
    else el.textContent = val;
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const val = t(el.getAttribute("data-i18n-title"));
    if (val != null) el.title = val;
  }
  for (const b of document.querySelectorAll(".lang-btn")) {
    b.classList.toggle("active", b.dataset.lang === lang);
  }
}

function setLang(next) {
  lang = next;
  localStorage.setItem("kitazo_lang", next);
  applyStaticI18n();
  refresh();   // aggiorna anche i testi dinamici (token, progress, pull)
}

for (const b of document.querySelectorAll(".lang-btn")) {
  b.addEventListener("click", () => setLang(b.dataset.lang));
}

// --- util -------------------------------------------------------------------
function say(t) { $("status").textContent = t; }

// Rotellina di refresh: sblocca uno scan inceppato e riparte da capo.
$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.classList.add("spinning");
  await ask({ type: "resetPull" });   // azzera stato + risultati parziali
  say(t("sayReset"));
  setTimeout(() => btn.classList.remove("spinning"), 600);
  refresh();
});

async function refresh() {
  const s = await ask({ type: "summary" });

  const tokenEl = $("token");
  tokenEl.classList.toggle("on", s.hasSession);
  $("tokenMsg").textContent = s.hasSession ? t("tokenActive", s.uid) : t("tokenHint");

  const st = s.pullState || { running: false, done: 0, total: 0 };
  const running = st.running;

  // Barra di avanzamento: visibile durante il pull.
  const progressBox = $("progressBox");
  if (running) {
    progressBox.hidden = false;
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    $("progressFill").style.width = `${pct}%`;
    $("progressText").textContent = t("progressRunning", st.done, st.total);
  } else if (s.pulls.length > 0) {
    // finito: barra piena, messaggio pronto
    progressBox.hidden = false;
    $("progressFill").style.width = "100%";
    $("progressText").textContent = t("progressDone");
  } else {
    progressBox.hidden = true;
  }

  // Pulsante pull: disabilitato senza sessione o mentre gira
  $("pull").disabled = !s.hasSession || running;
  $("pull").textContent = running ? t("pullRunning", st.done, st.total) : t("pullDefault");

  const hasData = s.captured > 0 || s.pulls.length > 0;
  const consented = $("consent").checked;
  // Riflette lo stato del consenso visivamente
  $("consentBox").classList.toggle("checked", consented);
  // Svuota: solo pull finito + dati
  $("clear").disabled = running || !hasData;
  // Export: richiede ANCHE il consenso esplicito
  $("export").disabled = running || !hasData || !consented;
  // Debug: solo dati + pull finito (no consenso: è per uso tecnico)
  $("exportRaw").disabled = running || !hasData;
}

// --- pull attivo: parte dalla pagina ---------------------------------------
$("pull").addEventListener("click", async () => {
  const { jwt, uid } = await ask({ type: "auth" });
  // Il token non è più obbligatorio: le chiamate al proxy sono same-origin e
  // autenticate dai cookie. Serve solo lo user id (dall'URL della pagina).
  if (!uid) {
    say(t("sayNoUid"));
    return;
  }

  const tabs = await chrome.tabs.query({ url: "https://*.tvtime.com/*" });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) {
    say(t("sayNoTab"));
    return;
  }

  $("pull").disabled = true;
  $("pull").textContent = t("pullRunning", 0, 0);
  // stato "running" subito, così l'export resta bloccato senza finestre
  await ask({ type: "pullStart", total: 0 });
  say(t("sayPulling"));
  try {
    const deepVotes = $("deepVotes").checked;
    await chrome.tabs.sendMessage(tab.id, { type: "startPull", jwt, uid, deepVotes });
    say(t("sayStarted"));
  } catch {
    say(t("sayTabNoResponse"));
    await ask({ type: "pullDone" }); // sblocco: il pull non è partito
    $("pull").disabled = false;
  }
});

// Consenso: aggiorna subito lo stato del pulsante export al click.
$("consent").addEventListener("change", () => {
  $("consentBox").classList.toggle("checked", $("consent").checked);
  refresh();
});

$("export").addEventListener("click", async () => {
  if (!$("consent").checked) {
    say(t("sayNeedConsent"));
    return;
  }
  say(t("sayPreparingZip"));
  const { pulls } = await ask({ type: "dump" });

  // Ricostruisco il payload grezzo (con consenso) e lo passo al convertitore,
  // che restituisce lo ZIP con i 3 file puliti.
  const raw = {
    exportedAt: new Date().toISOString(),
    consent: {
      given: true,
      statement: "L'utente ha confermato di esportare i propri dati personali per uso personale / portabilità.",
      timestamp: new Date().toISOString(),
    },
    pulls: pulls.map((p) => ({ label: p.label, target: p.target, status: p.status, ok: p.ok, data: p.data })),
  };

  try {
    const blob = window.TVTimeConverter.buildZipBlob(raw);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `tvtime-migrazione-${stamp}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    say(t("sayZipDone"));
  } catch (e) {
    say(t("sayConvertError", String(e)));
  }
});

$("clear").addEventListener("click", async () => {
  await ask({ type: "clear" });
  say(t("sayCleared"));
  refresh();
});

// DEBUG: scarica il JSON grezzo con tutti i pull così come tornano dall'API,
// senza pulizia né conversione. Utile per ispezionare campi non documentati
// (es. extended_comment dei commenti con foto).
$("exportRaw").addEventListener("click", async () => {
  say(t("sayPreparingRaw"));
  const { captures, pulls } = await ask({ type: "dump" });
  const payload = {
    exportedAt: new Date().toISOString(),
    tool: "TV Time Extractor by Kitazo — RAW DEBUG",
    pulls,               // tutti i pull, dati integrali
    passiveCaptures: captures,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `tvtime-raw-debug-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  say(t("sayRawDone", pulls.length));
});

// --- avvio ------------------------------------------------------------------
lang = detectLang();
applyStaticI18n();
refresh();
setInterval(refresh, 1200);
