const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function say(t) { $("status").textContent = t; }

// Rotellina di refresh: sblocca uno scan inceppato e riparte da capo.
$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.classList.add("spinning");
  await ask({ type: "resetPull" });   // azzera stato + risultati parziali
  say("Reset eseguito. Puoi ripartire con \"Scarica\".");
  setTimeout(() => btn.classList.remove("spinning"), 600);
  refresh();
});

async function refresh() {
  const s = await ask({ type: "summary" });

  const tokenEl = $("token");
  tokenEl.classList.toggle("on", s.hasSession);
  $("tokenMsg").textContent = s.hasSession
    ? `Sessione attiva${s.uid ? ` · utente ${s.uid}` : ""}.`
    : "Per iniziare: apri la sezione Profilo su TV Time e ricarica la pagina.";

  const st = s.pullState || { running: false, done: 0, total: 0 };
  const running = st.running;

  // Barra di avanzamento: visibile durante il pull.
  const progressBox = $("progressBox");
  if (running) {
    progressBox.hidden = false;
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    $("progressFill").style.width = `${pct}%`;
    $("progressText").textContent = st.total
      ? `Raccolta in corso… ${st.done} di ${st.total}`
      : "Avvio della raccolta…";
  } else if (s.pulls.length > 0) {
    // finito: barra piena, messaggio pronto
    progressBox.hidden = false;
    $("progressFill").style.width = "100%";
    $("progressText").textContent = "Raccolta completata. Puoi scaricare.";
  } else {
    progressBox.hidden = true;
  }

  // Pulsante pull: disabilitato senza sessione o mentre gira
  $("pull").disabled = !s.hasSession || running;
  if (running) {
    $("pull").textContent = st.total
      ? `Scarico… ${st.done}/${st.total}`
      : "Scarico…";
  } else {
    $("pull").textContent = "Scarica visti, film e show";
  }

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
    say("Apri la sezione Profilo su TV Time e ricarica la pagina, poi riprova.");
    return;
  }

  const tabs = await chrome.tabs.query({ url: "https://*.tvtime.com/*" });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) {
    say("Apri una scheda su app.tvtime.com, poi premi di nuovo.");
    return;
  }

  $("pull").disabled = true;
  $("pull").textContent = "Scarico…";
  // stato "running" subito, così l'export resta bloccato senza finestre
  await ask({ type: "pullStart", total: 0 });
  say("Scarico dalla pagina TV Time…");
  try {
    const deepVotes = $("deepVotes").checked;
    await chrome.tabs.sendMessage(tab.id, { type: "startPull", jwt, uid, deepVotes });
    say("Raccolta avviata. Su account grandi può richiedere diversi minuti: lascia la scheda aperta.");
  } catch {
    say("La scheda TV Time non risponde: ricaricala e riprova.");
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
    say("Spunta prima la conferma di consenso per scaricare.");
    return;
  }
  say("Preparo l'archivio…");
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
    say("Archivio scaricato: serie, film e liste.");
  } catch (e) {
    say("Errore nella conversione: " + String(e));
  }
});

$("clear").addEventListener("click", async () => {
  await ask({ type: "clear" });
  say("Svuotato.");
  refresh();
});

// DEBUG: scarica il JSON grezzo con tutti i pull così come tornano dall'API,
// senza pulizia né conversione. Utile per ispezionare campi non documentati
// (es. extended_comment dei commenti con foto).
$("exportRaw").addEventListener("click", async () => {
  say("Preparo il JSON grezzo…");
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
  say(`JSON grezzo scaricato (${pulls.length} pull).`);
});

refresh();
setInterval(refresh, 1200);
