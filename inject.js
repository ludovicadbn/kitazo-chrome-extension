// MAIN world. Tre compiti:
//   1. intercettare fetch/XHR e clonare le risposte JSON (discovery passiva);
//   2. catturare il JWT Bearer dalla sessione;
//   3. eseguire il PULL ATTIVO da qui: essendo nella pagina, le chiamate al
//      proxy /sidecar sono same-origin *.tvtime.com e restituiscono dati veri
//      (dal service worker l'origine era sbagliata -> corpi vuoti).
(() => {
  "use strict";

  const MAX_BODY_CHARS = 12_000_000;
  let lastJwt = null;
  // Cooperative stop: the mobile overlay (or popup) can post {__tvtimeExport:
  // "abortPull"} to halt an in-flight extraction. The long loops below check
  // this flag and bail out early instead of hammering the API to the end.
  let aborted = false;

  function isTvTimeBackend(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      if (u.protocol !== "https:") return false;
      return u.hostname.endsWith("tvtime.com") || u.hostname === "api2.tozelabs.com";
    } catch {
      return false;
    }
  }

  const looksJson = (ct) => typeof ct === "string" && ct.includes("json");

  function relay(kind, extra) {
    try {
      // target "*": il bridge filtra comunque per event.source===window e per
      // la firma __tvtimeExport, quindi resta sicuro. Evita che il messaggio
      // venga scartato quando location.origin differisce tra i world/frame.
      window.postMessage({ __tvtimeExport: kind, ...extra }, "*");
    } catch {}
  }

  function relayToken(jwt) {
    if (!jwt || jwt === lastJwt) return;
    lastJwt = jwt;
    relay("token", { jwt });
  }

  // Appena carico, cerco lo user id. TV Time NON lo mette nell'URL della
  // pagina profilo (/profile), ma è presente in ogni chiamata API
  // (.../user/<id>/...) e negli URL sidecar. Lo estraggo da lì.
  let foundUid = null;
  function tryUid(fromUrl) {
    if (foundUid) return;
    let s = fromUrl || "";
    // decodifica eventuale sidecar o_b64
    const m64 = /o_b64=([^&]+)/.exec(s);
    if (m64) {
      try { s += " " + atob(m64[1].replace(/-/g, "+").replace(/_/g, "/")); } catch {}
    }
    const m = /\/user\/(\d{3,})/.exec(s) || /\/users\/(\d{3,})/.exec(s);
    if (m) {
      foundUid = m[1];
      try { console.log("[TV Time Export] user id trovato:", foundUid); } catch {}
      relay("uid", { uid: foundUid });
    }
  }
  function relayUidFromUrl() {
    tryUid(location.href);
  }
  relayUidFromUrl();
  setInterval(relayUidFromUrl, 3000);

  function sniffAuth(headers) {
    if (!headers) return;
    let value = null;
    if (headers instanceof Headers) value = headers.get("authorization");
    else if (Array.isArray(headers)) {
      const f = headers.find((h) => String(h[0]).toLowerCase() === "authorization");
      value = f && f[1];
    } else if (typeof headers === "object") {
      for (const k of Object.keys(headers))
        if (k.toLowerCase() === "authorization") value = headers[k];
    }
    if (typeof value === "string" && /^Bearer\s+/i.test(value))
      relayToken(value.replace(/^Bearer\s+/i, "").trim());
  }

  // === intercettazione =====================================================
  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      if (input instanceof Request) sniffAuth(input.headers);
      if (init && init.headers) sniffAuth(init.headers);
    } catch {}

    const response = await nativeFetch.apply(this, arguments);
    try {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      tryUid(url);
      if (isTvTimeBackend(url) && looksJson(response.headers.get("content-type"))) {
        const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
        response
          .clone()
          .text()
          .then((body) => {
            if (body.length <= MAX_BODY_CHARS)
              relay("record", {
                record: {
                  url: new URL(url, location.href).href,
                  method: method.toUpperCase(),
                  status: response.status,
                  body,
                  ts: Date.now(),
                },
              });
          })
          .catch(() => {});
      }
    } catch {}
    return response;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tt = { method: String(method || "GET").toUpperCase(), url };
    try { tryUid(url); } catch {}
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (String(name).toLowerCase() === "authorization" && /^Bearer\s+/i.test(value))
        relayToken(String(value).replace(/^Bearer\s+/i, "").trim());
    } catch {}
    return nativeSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      try {
        const info = this.__tt;
        if (!info || !isTvTimeBackend(info.url)) return;
        if (!looksJson(this.getResponseHeader("content-type"))) return;
        const body =
          this.responseType === "" || this.responseType === "text"
            ? this.responseText
            : JSON.stringify(this.response);
        if (body && body.length <= MAX_BODY_CHARS)
          relay("record", {
            record: { url: new URL(info.url, location.href).href, method: info.method, status: this.status, body, ts: Date.now() },
          });
      } catch {}
    });
    return nativeSend.apply(this, arguments);
  };

  // === pull attivo =========================================================

  function b64url(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Il sidecar vuole il base (origine+path) in o_b64 e la query del target
  // come parametri FRATELLI, non dentro il base64.
  function sidecarUrl(targetUrl) {
    const u = new URL(targetUrl);
    const base = `${u.origin}${u.pathname}`;
    const sidecar = new URL("https://app.tvtime.com/sidecar");
    sidecar.searchParams.set("o_b64", b64url(base));
    for (const [k, v] of u.searchParams) sidecar.searchParams.append(k, v);
    return sidecar.toString();
  }

  function targetsFor(uid) {
    const ms = "https://msapi.tvtime.com/prod";
    const cm = "https://comments.tvtime.com/v1/comments";
    const st = "https://stats.tvtime.com/v2/stats/user";
    return [
      // --- nucleo (funziona) ---
      ["visti_episodi",   `${ms}/v1/tracking/watches/user/${uid}?entity_type=episode`],
      ["visti_film",      `${ms}/v1/tracking/watches/user/${uid}?entity_type=movie`],
      ["follows_film",    `${ms}/v1/tracking/cgw/follows/user/${uid}?entity_type=movie&sort=watched_date,desc`],
      // tutte le serie in ogni stato (incluse abbandonate / in pausa / watchlist)
      ["follows_serie_all", `${ms}/v1/tracking/cgw/follows/user/${uid}?entity_type=series`],
      ["preferiti_film",  `${ms}/v2/lists/user/${uid}/lists/favorite-movies?expand=all`],
      ["preferiti_serie", `${ms}/v2/lists/user/${uid}/lists/favorite-series?expand=all`],
      ["liste",           `${ms}/v2/lists/user/${uid}?expand=meta`],
      // ignore_replies=true: solo i commenti top-level (come il counter di TV
      // Time). Le risposte ad altri commenti, migrate come commenti a sé sul
      // titolo, perderebbero il thread a cui rispondevano — quindi le escludiamo
      // alla fonte.
      ["commenti",        `${cm}/cgw/user/${uid}/comments?sort=most_recent&ignore_replies=true&only_watched=false&expand=all`],
      // aggregati dei voti (personaggi + rating serie)
      ["voti_serie",      `${st}/${uid}/episode/voted`],
      ["voti_film",       `${st}/${uid}/movie/voted`],
      // copertine/fanart personalizzate scelte dall'utente su TV Time: le
      // reimportiamo come poster/banner scelti in Kitazo. Endpoint per-utente
      // (auth via bearer/cookie), non serve l'uid nel path.
      ["copertine",       `https://users-customization.tvtime.com/v1/customization/images`],
    ];
  }

  // Header di auth: usa il Bearer se catturato, altrimenti le chiamate
  // same-origin al proxy /sidecar sono già autenticate dai cookie di sessione.
  function authHeaders(jwt) {
    const h = { Accept: "application/json" };
    if (jwt) h.Authorization = `Bearer ${jwt}`;
    return h;
  }

  // Fetch con timeout: se una chiamata resta appesa oltre N ms viene abortita,
  // così un singolo endpoint lento non blocca l'intera raccolta.
  async function fetchTimeout(url, opts, ms = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function pullOne(label, target, jwt) {
    try {
      const res = await fetchTimeout(sidecarUrl(target), {
        method: "GET",
        headers: authHeaders(jwt),
        credentials: "include",
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      relay("pullResult", { label, target, status: res.status, ok: res.ok, data });
      return { ok: res.ok, data };
    } catch (e) {
      relay("pullResult", { label, target, status: 0, ok: false, error: String(e) });
      return { ok: false, data: null };
    }
  }

  // Fetch "silenzioso": non emette pullResult (usato dentro il pass 2 per
  // risolvere nomi personaggi senza intasare la lista risultati).
  async function fetchQuiet(target, jwt) {
    try {
      const res = await fetchTimeout(sidecarUrl(target), {
        method: "GET",
        headers: authHeaders(jwt),
        credentials: "include",
      });
      const text = await res.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch { return null; }
  }

  const unwrap = (d) => (d && d.data !== undefined ? d.data : d);
  const listOf = (d) => {
    const x = unwrap(d);
    if (Array.isArray(x)) return x;
    if (x && Array.isArray(x.objects)) return x.objects;
    return [];
  };

  // Pass 2: per ogni titolo votato, prende rating (stelle) + personaggio votato.
  async function pullVotes(uid, jwt, { filmUuids }, done) {
    const ms = "https://msapi.tvtime.com";
    const vt = "https://votes.tvtime.com/v1/votes/subject";

    // cache: uuid film/serie -> {char_id -> nome}
    const charCache = new Map();
    async function resolveChar(subjectUuid, entityId, kind) {
      if (!charCache.has(subjectUuid)) {
        const url = kind === "movie"
          ? `${ms}/prod/v1/movies/${subjectUuid}`
          : `${ms}/v1/episode/${subjectUuid}`;
        const d = unwrap(await fetchQuiet(url, jwt)) || {};
        const chars = d.characters || [];
        const m = new Map();
        for (const c of chars) m.set(String(c.uuid ?? c.id), c.name);
        charCache.set(subjectUuid, m);
        await new Promise((r) => setTimeout(r, 250));
      }
      return charCache.get(subjectUuid).get(String(entityId)) || null;
    }

    // Cicla TUTTI i film seguiti. Per ognuno prova rating e personaggio; se il
    // film non è votato le risposte sono vuote e non emette nulla (evita rumore).
    for (const uu of filmUuids) {
      // rating stelle
      const rv = await fetchQuiet(`${ms}/live/v1/ratings/votes/${uu}/${uid}?set=stars_wording_scalev2`, jwt);
      const ruv = (unwrap(rv)?.user_votes) || [];
      if (ruv.length) {
        relay("pullResult", { label: `rating_mv_${uu}`, status: 200, ok: true, data: { user_votes: ruv } });
      }
      // personaggio votato
      const sv = await fetchQuiet(`${vt}/${uu}/user/${uid}`, jwt);
      const cuv = (unwrap(sv)?.user_votes) || [];
      if (cuv.length) {
        const enriched = [];
        for (const v of cuv) {
          const nome = await resolveChar(uu, v.entity_id, "movie");
          enriched.push({ ...v, character_name: nome });
        }
        relay("pullResult", { label: `pers_film_${uu}`, status: 200, ok: true, data: { user_votes: enriched } });
      }
      done++;
      relay("pullProgress", { done });
      await new Promise((r) => setTimeout(r, 200));
    }
    return done;
  }

  // Dall'aggregato voti_serie estraggo sia i personaggi votati sia i rating
  // votati (le "reazioni" a stelle), entrambi a livello di serie (nome).
  function emitSeriesAggregate(aggData) {
    const blocks = unwrap(aggData) || [];
    for (const b of blocks) {
      const dim = (b.detailed_statistics?.[0]?.dimensions || [])
        .find((d) => d.id?.endsWith("-all")) || b.detailed_statistics?.[0]?.dimensions?.[0];
      const parseY = (y) => {
        const m = /^(.*?)\s*\(x\d+\)\s*$/.exec(y || "");
        return m ? m[1].trim() : (y || "").trim();
      };
      if (b.id === "character-vote") {
        const rows = (dim?.values || []).map((v) => ({ serie_name: v.x, personaggio: parseY(v.y), personaggio_raw: v.y }));
        relay("pullResult", { label: "pers_serie_aggregato", status: 200, ok: true, data: { rows } });
      } else if (b.id === "rating-vote") {
        const rows = (dim?.values || []).map((v) => ({ serie_name: v.x, reazione: parseY(v.y), reazione_raw: v.y }));
        relay("pullResult", { label: "rating_serie_aggregato", status: 200, ok: true, data: { rows } });
      }
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.__tvtimeExport === "abortPull") { aborted = true; return; }
    if (!d || d.__tvtimeExport !== "startPull") return;
    aborted = false;   // fresh run

    const jwt = d.jwt || lastJwt;   // opzionale: se manca si usano i cookie
    // User id: dal messaggio, o dal token, o dall'URL della pagina.
    let uid = d.uid;
    if (!uid) {
      const m = /\/user\/(\d+)/.exec(location.pathname) || /\/user\/(\d+)/.exec(location.href);
      if (m) uid = m[1];
    }
    if (!uid) {
      relay("pullDone", { error: "User id non trovato: apri la tua pagina profilo su TV Time." });
      return;
    }
    const deepVotes = Boolean(d.deepVotes);  // opzione: voti per-episodio (lento)

    // === PASS 1: pull normale ===
    const targets = targetsFor(uid);
    relay("pullStart", { total: targets.length });
    const results = {};
    let done = 0;
    for (const [label, target] of targets) {
      if (aborted) { relay("pullDone", { aborted: true }); return; }
      const r = await pullOne(label, target, jwt);
      results[label] = r.data;
      done++;
      relay("pullProgress", { done });
      await new Promise((r) => setTimeout(r, 350));
    }
    if (aborted) { relay("pullDone", { aborted: true }); return; }

    // === PASS 2: voti dettagliati ===
    try {
      const filmObjs = listOf(results.follows_film);
      const filmUuids = filmObjs.map((o) => o.uuid).filter(Boolean);
      const serieObjs = listOf(results.follows_serie_all || results.follows_serie);
      const serieIds = serieObjs.map((o) => o.meta?.id).filter(Boolean);

      // Also fetch the episode structure for series you WATCHED but no longer
      // FOLLOW: unfollowed shows still count in TV Time's stats and are in the
      // watch log, but aren't in the follows list — without their structure their
      // watched episodes have nowhere to attach and silently vanish from the export.
      const followedSet = new Set(serieIds.map(String));
      const watchedOnlyIds = [];
      const seenWatchedSid = new Set();
      for (const w of listOf(results.visti_episodi)) {
        const sid = w && (w.series_id != null ? w.series_id : w.show_id);
        if (sid == null) continue;
        const key = String(sid);
        if (followedSet.has(key) || seenWatchedSid.has(key)) continue;
        seenWatchedSid.add(key);
        watchedOnlyIds.push(sid);
      }
      const allSerieIds = [...serieIds, ...watchedOnlyIds];
      if (watchedOnlyIds.length) relay("pullNote", { note: `+${watchedOnlyIds.length} serie viste ma non seguite` });

      // Ora conosco il totale reale: pull base + film ciclati + serie ciclate.
      relay("pullSetTotal", { total: targets.length + filmUuids.length + allSerieIds.length });

      // aggregati (non contano come step: sono istantanei)
      emitSeriesAggregate(results.voti_serie);

      if (filmUuids.length) {
        done = await pullVotes(uid, jwt, { filmUuids }, done);
      }

      // === PASS 3: struttura stagioni/episodi per ogni serie (seguite + viste) ===
      done = await pullSeriesStructure(jwt, allSerieIds, done);

      // === PASS 4: risolvi il tvdb dei film presenti SOLO nelle liste ===
      // (film mai seguiti: il loro tvdb non è nei follows). Interrogo l'endpoint
      // del film per ognuno, così le liste hanno tvdb_id anche per questi.
      const followedUuids = new Set(filmUuids);
      const listMovieUuids = new Set();
      const collectList = (raw) => {
        const arr = raw?.objects || [];
        for (const it of arr) if (it.type === "movie" && it.uuid && !followedUuids.has(it.uuid)) listMovieUuids.add(it.uuid);
      };
      collectList(unwrap(results.preferiti_film));
      for (const l of listOf(results.liste)) collectList(l);
      await pullListMovieIds(jwt, [...listMovieUuids]);

      // === PASS 5: personaggi + rating a stelle per-episodio ===
      // L'aggregato dà solo il "top per serie". Ciclo gli episodi visti delle
      // serie in cui risulti aver votato (personaggi O stelle) per il dettaglio.
      const votedSeriesNames = new Set();   // serie con voti personaggio
      const ratedSeriesNames = new Set();   // serie con rating a stelle
      for (const b of (unwrap(results.voti_serie) || [])) {
        const dim = (b.detailed_statistics?.[0]?.dimensions || []).find((d) => d.id?.endsWith("-all"));
        if (b.id === "character-vote") for (const v of (dim?.values || [])) if (v.x) votedSeriesNames.add(v.x);
        else if (b.id === "rating-vote") for (const v of (dim?.values || [])) if (v.x) ratedSeriesNames.add(v.x);
      }
      const nameToTvdb = new Map();
      const nameToUuid = new Map();
      for (const o of serieObjs) {
        const m = o.meta || {};
        if (m.name && m.id) nameToTvdb.set(m.name, m.id);
        const su = o.uuid || m.uuid;
        if (m.name && su) nameToUuid.set(m.name, su);
      }
      const watchedEpisodeIds = new Set();
      for (const w of listOf(results.visti_episodi)) if (w.episode_id != null) watchedEpisodeIds.add(w.episode_id);

      // === RATING per-episodio: endpoint BULK (1 sola chiamata) ===
      // msapi/prod/v1/ratings/votes/user/{uid}?entity_type=episode restituisce
      // TUTTI i voti-stella dell'utente in un colpo. Li joino con la struct per
      // ricavare serie/stagione/episodio ed emetto nel formato che il converter
      // già consuma (rating_episodi_precisi_0). Niente più ciclo su migliaia di
      // episodi: i rating per-puntata diventano precisi e di default.
      await pullEpisodeRatingsBulk(uid, jwt, nameToTvdb);

      // === PERSONAGGI preferiti per-episodio ===
      // I voti-personaggio degli EPISODI non hanno endpoint bulk (verificato:
      // votes/user restituisce solo i film; show/season tozelabs falliscono).
      // L'unica fonte è tozelabs characters.is_voted per singolo episodio.
      // Concorrente sugli episodi visti (~1-2 min). Attivo di default via la
      // checkbox del popup; disattivabile per un export più rapido.
      // I personaggi dei FILM li prende già il pass 2 (pers_film_*).
      if (deepVotes) {
        await pullEpisodeCharacters(uid, jwt, watchedEpisodeIds, nameToTvdb);
      }

      // Foto/meme allegati ai commenti: scaricati qui (referer tvtime OK) e
      // incorporati nello ZIP come data URI.
      await pullCommentImages(results.commenti);
    } catch (e) {
      relay("pullResult", { label: "pass2_error", status: 0, ok: false, error: String(e) });
    }

    relay("pullDone", {});
  });

  // Accumulatore: tvdb serie -> [{uuid episodio}] (popolato dal pass 3).
  const episodesBySeriesTvdb = new Map();

  // Scarica la struttura episodi di ogni serie. Salva solo i campi utili
  // (numero, stagione, nome, id, imdb, uuid) per non gonfiare l'export.
  async function pullSeriesStructure(jwt, serieIds, done) {
    const ms = "https://msapi.tvtime.com/v1/series";
    for (const sid of serieIds) {
      if (aborted) break;
      // Retry a failed/empty episode-structure fetch: a single transient timeout
      // or rate-limit here used to drop the ENTIRE series' watched episodes (the
      // watch log can only be placed via this structure), quietly shrinking the
      // export. Up to 3 tries with backoff before giving up on this series.
      let eps = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await fetchQuiet(`${ms}/${sid}/episodes`, jwt);
        const parsed = unwrap(raw);
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.episodes) ? parsed.episodes : null);
        if (arr && arr.length) { eps = arr; break; }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      if (Array.isArray(eps) && eps.length) {
        const lean = eps.map((e) => ({
          id: e.id,
          uuid: e.uuid || undefined,
          imdb_id: e.imdb_id || undefined,
          number: e.number,
          season: typeof e.season === "object" ? e.season?.number : e.season,
          name: e.name,
          is_special: e.is_special || undefined,
          air_date: e.air_date || undefined,
        }));
        relay("pullResult", { label: `struct_${sid}`, status: 200, ok: true, data: { episodes: lean } });
        episodesBySeriesTvdb.set(sid, lean.filter((e) => e.id).map((e) => ({ id: e.id, uuid: e.uuid, number: e.number, season: e.season, name: e.name })));
      }
      done++;
      relay("pullProgress", { done });
      await new Promise((r) => setTimeout(r, 200));
    }
    return done;
  }

  // RATING per-episodio via endpoint BULK: una sola chiamata restituisce tutti
  // i voti-stella dell'utente. Confermato:
  //   GET msapi/prod/v1/ratings/votes/user/{uid}?entity_type=episode
  //   -> { data: [ { episode_id, rating_id, created, ... } ] }
  // Joina episode_id con la struct (episodesBySeriesTvdb) per serie/stagione/
  // episodio ed emette rating_episodi_precisi_0 nel formato del converter.
  async function pullEpisodeRatingsBulk(uid, jwt, nameToTvdb) {
    const url = `https://msapi.tvtime.com/prod/v1/ratings/votes/user/${uid}?entity_type=episode&set=stars_wording_scalev2`;
    const list = unwrap(await fetchQuiet(url, jwt));
    if (!Array.isArray(list)) {
      relay("pullResult", { label: "rating_episodi_bulk_meta", status: 200, ok: true, data: { count: 0, note: "endpoint bulk vuoto o formato inatteso" } });
      return;
    }
    // indici di join: tvdb -> nome serie, episode_id -> {tvdb, season, number, name}
    const tvdbToName = new Map();
    for (const [name, tv] of nameToTvdb) tvdbToName.set(tv, name);
    const epIndex = new Map();
    for (const [tvdb, eps] of episodesBySeriesTvdb) {
      for (const e of eps) if (e.id != null) epIndex.set(e.id, { tvdb, season: e.season, number: e.number, name: e.name });
    }
    const votes = [];
    const unmatched = [];
    for (const v of list) {
      const voted_at = v.created ? new Date(v.created * 1000).toISOString().slice(0, 10) : undefined;
      const info = epIndex.get(v.episode_id);
      if (info) {
        votes.push({
          serie_tvdb: info.tvdb,
          serie_name: tvdbToName.get(info.tvdb),
          season: info.season,
          episode: info.number,
          episode_name: info.name,
          episode_id: v.episode_id,
          rating_id: v.rating_id,
          voted_at,
        });
      } else {
        unmatched.push({ episode_id: v.episode_id, rating_id: v.rating_id, voted_at });
      }
    }
    relay("pullResult", { label: "rating_episodi_precisi_0", status: 200, ok: true, data: { votes } });
    // episodi non collegabili alla struct (serie senza struttura scaricata):
    // restano nel debug per non perderli e per capirne la causa.
    if (unmatched.length) {
      relay("pullResult", { label: "rating_episodi_bulk_unmatched", status: 200, ok: true, data: { count: unmatched.length, votes: unmatched } });
    }
  }

  // PERSONAGGI preferiti per-episodio: per ogni episodio visto interroga
  // tozelabs e tiene i personaggi con is_voted=true. È l'unica fonte (nessun
  // bulk esiste). Concorrente per stare sotto ~1-2 min anche su migliaia di
  // episodi. Emette voti_personaggio_episodi_N nel formato del converter.
  async function pullEpisodeCharacters(uid, jwt, watchedEpisodeIds, nameToTvdb) {
    const ep = "https://api2.tozelabs.com/v2/episode";
    const fields = "characters.fields(id,name,actor_name,is_voted)";
    const tvdbByName = new Map();
    for (const [name, tv] of nameToTvdb) tvdbByName.set(tv, name);

    // Fetch con retry: fetchQuiet ingoia errori/timeout restituendo null. Sotto
    // concorrenza un fetch può fallire per rate-limit transitorio: se non
    // riprovassimo, quel voto verrebbe perso in silenzio (declassato all'aggregato).
    // Ritorna l'array characters, oppure null se fallisce dopo i tentativi.
    async function fetchChars(epId) {
      for (let i = 0; i < 3; i++) {
        const res = await fetchQuiet(`${ep}/${epId}?fields=${fields}`, jwt);
        const chars = unwrap(res)?.characters;
        if (Array.isArray(chars)) return chars;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));  // backoff
      }
      return null;
    }

    // Target: tutti gli episodi VISTI presenti nella struct (l'aggregato tronca
    // a 5 serie, quindi non si può filtrare per serie: vanno controllati tutti).
    const targets = [];
    for (const [tvdb, eps] of episodesBySeriesTvdb) {
      const serieName = tvdbByName.get(tvdb);
      for (const e of eps) if (e.id != null && watchedEpisodeIds.has(e.id)) {
        targets.push({ serie_tvdb: tvdb, serie_name: serieName, ep_id: e.id, season: e.season, number: e.number, ep_name: e.name });
      }
    }
    if (!targets.length) return;
    relay("pullSetTotalAdd", { add: targets.length });

    // Emissione a blocchi (ogni 50) per non accumulare tutto in memoria.
    // Conteggio esplicito invece di `done % 50` così il bundle minificato non
    // contiene "%50" (che iOS potrebbe interpretare come percent-encoding).
    let charBuf = [];
    let blockN = 0;
    let done = 0;
    let sinceFlush = 0;
    const flush = () => {
      if (charBuf.length) {
        relay("pullResult", { label: `voti_personaggio_episodi_${blockN}`, status: 200, ok: true, data: { votes: charBuf } });
        charBuf = [];
        blockN++;
      }
    };

    // Pool di worker concorrenti che pescano dalla stessa coda (indice condiviso).
    const CONC = 6;
    let idx = 0;
    let failed = 0;   // episodi non recuperati dopo i retry (per diagnostica)
    async function worker() {
      while (idx < targets.length) {
        if (aborted) return;
        const t = targets[idx++];
        const chars = await fetchChars(t.ep_id);
        if (chars === null) {
          failed++;
        } else {
          for (const c of chars) {
            if (c.is_voted) charBuf.push({
              serie_tvdb: t.serie_tvdb, serie_name: t.serie_name,
              season: t.season, episode: t.number, episode_name: t.ep_name,
              character_id: c.id, personaggio: c.name || undefined, attore: c.actor_name || undefined,
            });
          }
        }
        done++;
        sinceFlush++;
        relay("pullProgressAdd", { add: 1 });
        if (sinceFlush >= 50) { flush(); sinceFlush = 0; }
        await new Promise((r) => setTimeout(r, 50));  // throttle leggero per worker
      }
    }
    await Promise.all(Array.from({ length: CONC }, () => worker()));
    flush();  // ultimo blocco
    // Meta diagnostica: quanti episodi non sono stati recuperati (se >0, alcuni
    // voti potrebbero mancare e ripiegare sull'aggregato).
    relay("pullResult", { label: "voti_personaggio_scan_meta", status: 200, ok: true, data: { episodi_totali: targets.length, falliti: failed } });
  }

  // Scarica i meme/foto allegati ai commenti e li incorpora come data URI.
  // TV Time li serve da CloudFront (dominio diverso da tvtime.com) e l'URL
  // diretto risponde 403 senza il referer di TV Time: per questo NON si possono
  // riscaricare lato server, né aprendo il link a mano. Qui però giriamo DENTRO
  // una pagina tvtime.com, quindi la fetch invia automaticamente il referer
  // giusto e le immagini ancora vive si scaricano — esattamente come fa l'app
  // quando mostra il meme. Le converto in data URI così finiscono nello ZIP e
  // sopravvivono alla migrazione (le vecchissime già cancellate da TV Time
  // restano irrecuperabili: vengono semplicemente saltate).
  async function pullCommentImages(commentsData) {
    const list = listOf(commentsData);
    const urls = [];
    for (const c of list) {
      const u = c && c.image && c.image.url;
      if (u && /^https?:\/\//i.test(u)) urls.push(u);
    }
    const uniq = [...new Set(urls)];
    if (!uniq.length) return;
    const map = {};
    let i = 0;
    async function worker() {
      while (i < uniq.length) {
        if (aborted) return;
        const url = uniq[i++];
        try {
          const res = await fetchTimeout(url, { credentials: "omit" }, 20000);
          if (!res || !res.ok) continue;
          const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          if (!/^image\//.test(ct)) continue;
          const blob = await res.blob();
          if (!blob.size || blob.size > 3 * 1024 * 1024) continue;  // cap 3MB/immagine
          const dataUri = await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ""));
            fr.onerror = () => resolve("");
            fr.readAsDataURL(blob);
          });
          if (dataUri.startsWith("data:image/")) map[url] = dataUri;
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, uniq.length) }, worker));
    if (Object.keys(map).length) {
      relay("pullResult", { label: "commenti_immagini", status: 200, ok: true, data: map });
    }
  }

  // Risolve tvdb_id/imdb_id dei film presenti solo nelle liste (mai seguiti).
  async function pullListMovieIds(jwt, uuids) {
    const ms = "https://msapi.tvtime.com/prod/v1/movies";
    for (const uu of uuids) {
      const raw = await fetchQuiet(`${ms}/${uu}`, jwt);
      const d = unwrap(raw) || {};
      const tvdb = (d.external_sources || []).find((s) => s.source === "tvdb");
      if (tvdb || d.imdb_id) {
        relay("pullResult", {
          label: `listmovie_${uu}`, status: 200, ok: true,
          data: { tvdb_id: tvdb ? Number(tvdb.id) : undefined, imdb_id: d.imdb_id || undefined },
        });
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
})();
