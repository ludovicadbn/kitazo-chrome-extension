// converter.js — logica di conversione, eseguita nel popup (browser).
// Prende l'export grezzo e produce un Blob .zip con i 3 JSON puliti.
// Nessuna dipendenza: lo ZIP usa metodo "stored" (no compressione), va bene
// per pochi file di testo e resta 100% standard.

(function (global) {
  "use strict";

  // ---- ZIP minimale (metodo stored) ----------------------------------------
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const enc = new TextEncoder();

  function makeZipBlob(files) {
    // files: [{ name, text }]
    const parts = [];        // Uint8Array chunks (local headers + data)
    const central = [];
    let offset = 0;

    const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
    const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

    // Data/ora corrente in formato DOS (richiesto dallo ZIP). Senza questo i
    // file dentro l'archivio risultano datati 31/12/1979 (timestamp zero).
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = enc.encode(f.text);
      const crc = crc32(data);

      const local = concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), // sig, ver, flags, method(0=stored)
        u16(dosTime), u16(dosDate),                // ora, data (DOS)
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0),
        nameBytes, data,
      ]);
      parts.push(local);

      const cen = concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0),
        u16(dosTime), u16(dosDate),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset),
        nameBytes,
      ]);
      central.push(cen);
      offset += local.length;
    }

    const centralBuf = concat(central);
    const centralSize = centralBuf.length;
    const centralOffset = offset;
    const end = concat([
      u32(0x06054b50), u16(0), u16(0),
      u16(files.length), u16(files.length),
      u32(centralSize), u32(centralOffset), u16(0),
    ]);

    return new Blob([concat(parts), centralBuf, end], { type: "application/zip" });
  }

  function concat(arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
  }

  // ---- conversione ---------------------------------------------------------
  // Date "placeholder" di TV Time (epoch zero = mai visto/mai aggiornato):
  // le trasformo in undefined così non compaiono come 1970/1979 nell'import.
  function cleanDate(v) {
    if (!v || typeof v !== "string") return undefined;
    if (v.startsWith("1970-01-01") || v.startsWith("1969-12-31") || v.startsWith("0001-")) return undefined;
    return v;
  }


  function convert(raw) {
    const pulls = raw.pulls || [];
    const P = (l) => { const p = pulls.find((x) => x.label === l); let x = p?.data; return (x && x.data !== undefined) ? x.data : x; };
    const objs = (x) => (x && Array.isArray(x.objects)) ? x.objects : (Array.isArray(x) ? x : []);
    const okList = (l) => { const p = pulls.find((x) => x.label === l); return p && p.ok ? objs(P(l)) : []; };

    // watch log indicizzato per episode_id
    const watchById = new Map();
    for (const w of okList("visti_episodi")) if (w.episode_id != null) watchById.set(w.episode_id, w);

    // --- PONTI uuid -> id (TV Time usa uuid interni e tvdb_id in parallelo) ---
    // Costruisco mappe per collegare rating/commenti/liste (che hanno solo
    // l'uuid) ai titoli veri (tvdb_id/imdb_id).
    const serieByUuid = new Map();   // uuid serie -> { tvdb_id }
    const serieTvdbById = new Map(); // (per episodi) tvdb serie -> struttura
    for (const o of (okList("follows_serie_all").length ? okList("follows_serie_all") : okList("follows_serie"))) {
      const m = o.meta || {};
      if (o.uuid) serieByUuid.set(o.uuid, { tvdb_id: m.id });
      if (m.uuid) serieByUuid.set(m.uuid, { tvdb_id: m.id });
    }
    const filmByUuid = new Map();    // uuid film -> { tvdb_id, imdb_id }
    for (const o of okList("follows_film")) {
      const m = o.meta || {};
      const tvdb = (m.external_sources || []).find((s) => s.source === "tvdb");
      const val = { tvdb_id: tvdb ? Number(tvdb.id) : undefined, imdb_id: m.imdb_id || undefined };
      if (o.uuid) filmByUuid.set(o.uuid, val);
      if (m.uuid) filmByUuid.set(m.uuid, val);
    }
    // film risolti dal pass 4 (presenti solo nelle liste)
    for (const p of pulls) {
      const m = /^listmovie_(.+)$/.exec(p.label);
      if (m && p.ok) {
        const d = p.data?.data || p.data;
        filmByUuid.set(m[1], { tvdb_id: d?.tvdb_id, imdb_id: d?.imdb_id });
      }
    }
    // nome serie -> tvdb (per collegare rating/personaggi serie senza fuzzy match)
    const serieTvdbByName = new Map();
    for (const o of (okList("follows_serie_all").length ? okList("follows_serie_all") : okList("follows_serie"))) {
      const m = o.meta || {};
      if (m.name && m.id) serieTvdbByName.set(m.name, m.id);
    }

    // FILM
    const film = okList("follows_film").map((f) => {
      const m = f.meta || {}, ex = f.extended || {};
      const tvdb = (m.external_sources || []).find((s) => s.source === "tvdb");
      return {
        tvdb_id: tvdb ? Number(tvdb.id) : undefined,
        imdb_id: m.imdb_id || undefined,
        watched_at: cleanDate(f.watched_at),
        is_watched: ex.is_watched || undefined,
        rewatch_count: f.rewatch_count || 0,
      };
    });

    // SERIE annidate
    const STATO = { continuing:"in_corso", stopped:"abbandonata", up_to_date:"aggiornata",
                    not_started_yet:"da_iniziare", watch_later:"da_vedere", finished:"finita" };
    const serieSrc = okList("follows_serie_all").length ? okList("follows_serie_all") : okList("follows_serie");
    const structFor = (seriesId) => {
      const p = pulls.find((x) => x.label === `struct_${seriesId}` && x.ok);
      const d = p?.data?.episodes || p?.data?.data?.episodes;
      return Array.isArray(d) ? d : null;
    };
    const serie = serieSrc.map((s) => {
      const m = s.meta || {};
      const stato = (s.filter || []).map((f) => STATO[f]).find(Boolean);
      const wd = (s.sorting || []).find((x) => x.id === "watch_date");
      const struct = structFor(m.id);
      const base = { tvdb_id: m.id, stato: stato || undefined, follow_date: cleanDate(s.created_at), last_watch: cleanDate(wd ? wd.value : undefined) };
      if (!struct) {
        const flat = [...watchById.values()].filter((w) => w.series_id === m.id)
          .map((w) => ({ episode_id: w.episode_id, watched_at: cleanDate(w.watched_at), rewatch_count: w.rewatch_count || 0 }));
        return { ...base, _noStructure: true, episodi_visti: flat };
      }
      const bySeason = new Map();
      let epTotali = 0, epVisti = 0;
      for (const e of struct) {
        epTotali++;
        const w = watchById.get(e.id);
        if (!w) continue;              // solo episodi VISTI nel file (alleggerisce)
        epVisti++;
        const sn = e.season ?? 0;
        if (!bySeason.has(sn)) bySeason.set(sn, []);
        bySeason.get(sn).push({
          tvdb_id: e.id,
          imdb_id: e.imdb_id || undefined,
          number: e.number,
          name: e.name,
          special: e.is_special || undefined,
          watched_at: cleanDate(w.watched_at),
          rewatch_count: w.rewatch_count || 0,
        });
      }
      const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0])
        .map(([number, episodes]) => ({ number, episodes: episodes.sort((a, b) => (a.number || 0) - (b.number || 0)) }));
      // conteggio per contesto (senza elencare gli episodi non visti)
      return { ...base, episodi_totali: epTotali, episodi_visti: epVisti, seasons };
    });

    // LISTE
    const mapListItem = (o) => {
      if (o.type === "movie") {
        const bridge = filmByUuid.get(o.uuid) || {};
        return {
          tipo: "movie",
          uuid: o.uuid,
          tvdb_id: bridge.tvdb_id,   // collegato via mappa uuid->id
          imdb_id: bridge.imdb_id,
          custom_order: o.custom_order,
        };
      }
      return { tipo: "series", tvdb_id: o.id, custom_order: o.custom_order };
    };
    const mapList = (r) => r ? {
      id: r.id, name: r.name, description: r.description || undefined,
      is_public: r.is_public, created_at: cleanDate(r.created_at),
      items: (r.objects || []).map(mapListItem),
    } : null;
    const liste = {
      preferiti_serie: mapList(P("preferiti_serie")),
      preferiti_film: mapList(P("preferiti_film")),
      custom: okList("liste").map(mapList).filter(Boolean),
    };

    // COMMENTI
    // Mappa uuid EPISODIO -> tvdb della SERIE (dalla struct). Serve ai commenti
    // sugli episodi: il loro entity_uuid è l'uuid dell'EPISODIO, non della serie,
    // quindi non si trova in serieByUuid. Senza questo, i commenti-episodio
    // restavano senza tvdb_id e venivano scartati in import.
    const episodeUuidToTvdb = new Map();
    for (const p of pulls) {
      const mm = /^struct_(\d+)$/.exec(p.label || "");
      if (!mm || !p.ok) continue;
      const tvdb = Number(mm[1]);
      const eps = p?.data?.episodes || p?.data?.data?.episodes || [];
      for (const e of eps) if (e && e.uuid) episodeUuidToTvdb.set(e.uuid, tvdb);
    }

    // Mappa url originale -> data URI, per le foto scaricate in-pagina (referer
    // tvtime). Quando presente, l'export porta l'immagine incorporata invece del
    // link CloudFront che risponde 403 fuori da TV Time.
    const commentImages = P("commenti_immagini") || {};
    const commentiRaw = P("commenti");
    const commenti = (Array.isArray(commentiRaw) ? commentiRaw : []).map((c) => {
      // Aggancio l'entity_uuid al titolo vero, secondo il tipo.
      let tvdb_id, imdb_id;
      if (c.entity_type === "episode") {
        // entity_uuid = uuid episodio -> risolvo la serie; fallback: a volte è
        // già l'uuid della serie.
        tvdb_id = episodeUuidToTvdb.get(c.entity_uuid) ?? serieByUuid.get(c.entity_uuid)?.tvdb_id;
      } else if (c.entity_type === "series") {
        tvdb_id = serieByUuid.get(c.entity_uuid)?.tvdb_id;
      } else if (c.entity_type === "movie") {
        const b = filmByUuid.get(c.entity_uuid) || {};
        tvdb_id = b.tvdb_id; imdb_id = b.imdb_id;
      }
      // Immagine/meme allegato al commento: TV Time lo mette nel campo "image"
      // (con expand=all). Struttura: image.url + format/width/height/meme_id.
      const img = c.image && typeof c.image === "object" ? c.image : null;
      // Preferisci l'immagine incorporata (data URI): quella sopravvive alla
      // migrazione. Fallback all'URL CloudFront originale se non scaricata.
      const embedded = img?.url ? commentImages[img.url] : null;
      return {
        comment_id: c.comment_id,
        entity_type: c.entity_type,
        entity_uuid: c.entity_uuid,
        tvdb_id,
        imdb_id,
        text: c.text || undefined,
        image_url: embedded || img?.url || undefined,  // data URI se scaricata, altrimenti URL originale
        image_format: img?.url ? (img.format || undefined) : undefined,
        created_at: cleanDate(c.created_at),
        is_spoiler: c.is_spoiler || undefined,
        parent_uuid: c.parent_uuid || undefined,
      };
    });

    // RATING
    const RATING_ID = { 1:{nome:"bad",stelle:1}, 27:{nome:"ok",stelle:2}, 28:{nome:"good",stelle:3}, 29:{nome:"great",stelle:4}, 3:{nome:"wow",stelle:5} };
    const REAZIONE_STELLE = { bad:1, ok:2, good:3, great:4, wow:5 };
    const collectRatings = () => {
      const out = [];
      for (const p of pulls) {
        if (!/^rating_(ep|mv)_/.test(p.label) || !p.ok) continue;
        const d = p.data?.data || p.data;
        for (const uv of (d?.user_votes || [])) {
          const map = RATING_ID[uv.rating_id];
          const tipo = uv.type || (p.label.startsWith("rating_ep") ? "episode" : "movie");
          // per i film: aggancio uuid -> tvdb/imdb
          const bridge = tipo === "movie" ? (filmByUuid.get(uv.uuid) || {}) : {};
          out.push({
            tipo,
            episode_id: uv.episode_id || undefined,
            uuid: uv.uuid || undefined,
            tvdb_id: bridge.tvdb_id,
            imdb_id: bridge.imdb_id,
            nome: map?.nome, stelle: map?.stelle ?? null,
            data: uv.created ? new Date(uv.created * 1000).toISOString().slice(0,10) : undefined,
          });
        }
      }
      // RATING EPISODIO PRECISI (pass 5): stelle + data per singolo episodio.
      // RATING EPISODIO PRECISI (pass 5): può essere a blocchi (_0,_1,...) o
      // in un'unica label (versioni precedenti).
      const epRatingList = [];
      for (const p of pulls) {
        if (!p.ok) continue;
        if (p.label === "rating_episodi_precisi" || /^rating_episodi_precisi_\d+$/.test(p.label)) {
          const vs = p.data?.votes || p.data?.data?.votes || [];
          for (const v of vs) epRatingList.push(v);
        }
      }
      const coveredRatingSeries = new Set();
      for (const v of epRatingList) {
        const map = RATING_ID[v.rating_id];
        coveredRatingSeries.add(v.serie_tvdb);
        out.push({
          tipo: "series",
          serie_name: v.serie_name,
          tvdb_id: v.serie_tvdb,
          season: v.season,
          episode: v.episode,
          episode_name: v.episode_name || undefined,
          nome: map?.nome,
          stelle: map?.stelle ?? null,
          data: v.voted_at || undefined,
          preciso: true,           // rating del singolo episodio
        });
      }
      // AGGREGATO (serie non coperte): rating a livello serie, NON preciso.
      // SOLO se il bulk rating non è girato: il bulk (rating_episodi_precisi_0)
      // è completo, quindi l'aggregato aggiungerebbe solo eventuali fantasmi.
      const bulkRan = pulls.some(
        (p) => p.ok && (p.label === "rating_episodi_precisi_0" || p.label === "rating_episodi_bulk_meta"),
      );
      const agg = pulls.find((p) => p.label === "rating_serie_aggregato" && p.ok);
      const rows = agg?.data?.rows || agg?.data?.data?.rows || [];
      if (!bulkRan) {
        for (const r of rows) {
          const tvdb = serieTvdbByName.get(r.serie_name);
          if (coveredRatingSeries.has(tvdb)) continue;
          const nome = (r.reazione || "").toLowerCase();
          const m = /\(x(\d+)\)/.exec(r.reazione_raw || "");
          const volte = m ? Number(m[1]) : 1;
          out.push({
            tipo: "series",
            serie_name: r.serie_name,
            tvdb_id: tvdb,
            nome, stelle: REAZIONE_STELLE[nome] ?? null,
            volte,                    // in quante puntate hai votato (non quali)
            preciso: false,           // manca l'episodio: non è per-puntata
          });
        }
      }
      return out;
    };
    const collectCharacterVotes = () => {
      const out = [];
      for (const p of pulls) {
        const m = /^pers_film_(.+)$/.exec(p.label);
        if (!m || !p.ok) continue;
        const d = p.data?.data || p.data;
        const bridge = filmByUuid.get(m[1]) || {};
        for (const uv of (d?.user_votes || []))
          out.push({
            tipo: "movie", subject_uuid: m[1],
            tvdb_id: bridge.tvdb_id, imdb_id: bridge.imdb_id,
            entity_id: uv.entity_id, personaggio: uv.character_name || undefined,
          });
      }
      const agg = pulls.find((p) => p.label === "pers_serie_aggregato" && p.ok);
      const rows = agg?.data?.rows || agg?.data?.data?.rows || [];
      const epVoteList = [];
      for (const p of pulls) {
        if (!p.ok) continue;
        if (p.label === "voti_personaggio_episodi" || /^voti_personaggio_episodi_\d+$/.test(p.label)) {
          const vs = p.data?.votes || p.data?.data?.votes || [];
          for (const v of vs) epVoteList.push(v);
        }
      }

      // 1) Voti per-episodio precisi (pass 5): uno per personaggio/episodio.
      const coveredSeries = new Set();
      for (const v of epVoteList) {
        coveredSeries.add(v.serie_tvdb);
        out.push({
          tipo: "series",
          serie_name: v.serie_name,
          tvdb_id: v.serie_tvdb,
          season: v.season,
          episode: v.episode,
          episode_name: v.episode_name || undefined,
          personaggio: v.personaggio || undefined,
          attore: v.attore || undefined,
          character_id: v.character_id,
          preciso: true,           // episodio esatto
        });
      }
      // 2) Aggregato con conteggio (xN): SOLO se la scansione per-episodio non
      //    è girata. Quando la scansione c'è (voti_personaggio_scan_meta o
      //    blocchi voti_personaggio_episodi), essa è la verità completa: usare
      //    l'aggregato aggiungerebbe voti fantasma (l'aggregato di TV Time puo
      //    contenere residui/preferiti-show che NON esistono come voto puntata).
      const scanRan = pulls.some(
        (p) => p.ok && (p.label === "voti_personaggio_scan_meta" ||
          p.label === "voti_personaggio_episodi" || /^voti_personaggio_episodi_\d+$/.test(p.label)),
      );
      if (!scanRan) {
        for (const r of rows) {
          const tvdb = serieTvdbByName.get(r.serie_name);
          if (coveredSeries.has(tvdb)) continue;  // già coperta con dettaglio
          const m = /^(.*?)\s*\(x(\d+)\)\s*$/.exec(r.personaggio_raw || r.personaggio || "");
          const volte = m ? Number(m[2]) : 1;
          out.push({
            tipo: "series",
            serie_name: r.serie_name,
            tvdb_id: tvdb,
            personaggio: m ? m[1].trim() : r.personaggio,
            volte,                    // in quante puntate (non quali)
            preciso: false,           // manca l'episodio
          });
        }
      }
      return out;
    };
    const rating = collectRatings();
    const pers = collectCharacterVotes();

    const meta = { exportedAt: raw.exportedAt, source: "TV Time", consent: raw.consent || undefined };
    const serieOut = {
      ...meta, serie,
      rating_episodi: rating.filter((r) => r.tipo === "episode" || r.tipo === "series"),
      personaggi_votati: pers.filter((p) => p.tipo === "series"),
    };
    const filmOut = {
      ...meta, film,
      rating_film: rating.filter((r) => r.tipo === "movie"),
      personaggi_votati: pers.filter((p) => p.tipo === "movie"),
    };
    const listeOut = { ...meta, liste, commenti };

    return { serieOut, filmOut, listeOut };
  }

  // ---- sealing dei dati "difficili" ----------------------------------------
  // I dati base (serie/film/liste viste) restano leggibili nello ZIP. I dati che
  // ci sono costati reverse-engineering — rating, personaggi preferiti, commenti
  // — vengono cifrati con la chiave PUBBLICA di Kitazo (qui sotto), così solo il
  // nostro server (che ha la chiave privata) può rileggerli: un'altra app non può
  // sfruttare il nostro export. Schema ibrido RSA-OAEP(SHA-256) + AES-256-GCM.
  const KITAZO_PUB_SPKI_B64 =
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs8pTo4yTfOSchbpDtszgNtDITlA7rDpuBCQhAAYivvC7xmWLdq9GygSZZokeDoLugG4x53aeQbsmyWLrry3fBTHpTOefYhju33UKp/UUzR9aEe78K6DtZLkZH6rQ7cq4lUBA3zfzqS5hsSY18s5z4cVh/Aa9OS/EApeuQy/CC/06rimSziAgwmvsxteFcOGTUogMTyCARzHqG63Dv/aae0z2lclnPPbIlgmUFYZlzQyVAIZ7Ns2R5wwNf4RSrg/VSzKLabWTQkJ2FfOJua7zceXxHDovVC93TIAgO/UvVA1k9zcVND9aZDOB74ShuD+NS8b4uy3IFHvXNsKYlX5IHQIDAQAB";

  function b64FromBytes(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function bytesFromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  let pubKeyPromise = null;
  function getPubKey() {
    if (!pubKeyPromise) {
      pubKeyPromise = crypto.subtle.importKey(
        "spki",
        bytesFromB64(KITAZO_PUB_SPKI_B64),
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["encrypt"]
      );
    }
    return pubKeyPromise;
  }

  // Cifra un oggetto → envelope { v, k, iv, d } (tutti base64). Il server lo
  // rimette al posto di `_kitazo_sealed`.
  async function seal(obj) {
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = enc.encode(JSON.stringify(obj));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, pt)); // ciphertext||tag(16)
    const rawAes = new Uint8Array(await crypto.subtle.exportKey("raw", aesKey));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, await getPubKey(), rawAes));
    return { v: 1, k: b64FromBytes(wrapped), iv: b64FromBytes(iv), d: b64FromBytes(ct) };
  }

  // Sostituisce i campi indicati con un unico blob cifrato `_kitazo_sealed`.
  async function sealFields(out, fields) {
    const payload = {};
    for (const f of fields) {
      if (f in out) { payload[f] = out[f]; delete out[f]; }
    }
    out._kitazo_sealed = await seal(payload);
    return out;
  }

  async function buildZipBlob(raw) {
    const { serieOut, filmOut, listeOut } = convert(raw);
    try {
      await Promise.all([
        sealFields(serieOut, ["rating_episodi", "personaggi_votati"]),
        sealFields(filmOut, ["rating_film", "personaggi_votati"]),
        sealFields(listeOut, ["commenti"]),
      ]);
    } catch (e) {
      // Se la cifratura non è disponibile per qualunque motivo, meglio un export
      // in chiaro che un export mancato: i dati restano quelli, solo non protetti.
      console.warn("[kitazo] sealing non riuscito, export in chiaro:", e);
    }
    return makeZipBlob([
      { name: "tvtime-serie.json", text: JSON.stringify(serieOut, null, 2) },
      { name: "tvtime-film.json",  text: JSON.stringify(filmOut, null, 2) },
      { name: "tvtime-liste.json", text: JSON.stringify(listeOut, null, 2) },
    ]);
  }

  global.TVTimeConverter = { convert, buildZipBlob };
})(window);
