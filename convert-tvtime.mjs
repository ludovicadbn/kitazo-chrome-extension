#!/usr/bin/env node
// Converte un export dell'estensione TV Time nel JSON finale per la migrazione.
// Tiene solo il recuperabile utile; scarta profilo, following, stats e zavorra.
// Uso: node convert-tvtime.mjs <export.json>  ->  3 file JSON (serie, film, liste)


import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

// --- generatore ZIP minimale (nessuna dipendenza esterna) ------------------
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const comp = deflateRawSync(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

const args = process.argv.slice(2);
const inPath = args.find((a) => !a.startsWith("--"));

if (!inPath) {
  console.error("Uso: node convert-tvtime.mjs <export.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(inPath, "utf8"));
const pulls = raw.pulls || [];
const P = (l) => { const p = pulls.find((x) => x.label === l); let x = p?.data; return (x && x.data !== undefined) ? x.data : x; };
const objs = (x) => (x && Array.isArray(x.objects)) ? x.objects : (Array.isArray(x) ? x : []);
const okList = (l) => { const p = pulls.find((x) => x.label === l); return p && p.ok ? objs(P(l)) : []; };

const cleanDate = (v) => {
  if (!v || typeof v !== "string") return undefined;
  if (v.startsWith("1970-01-01") || v.startsWith("1969-12-31") || v.startsWith("0001-")) return undefined;
  return v;
};

// --- WATCH LOG (indicizzato per episode_id) --------------------------------
// I watch degli episodi: li aggancio alla struttura tramite episode_id.
const watchById = new Map();
for (const w of okList("visti_episodi")) {
  if (w.episode_id != null) watchById.set(w.episode_id, w);
}

// --- FILM ------------------------------------------------------------------
// Solo identificatori (per reidratare da TVDB/TMDb) + dato dell'utente.
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

// --- SERIE ANNIDATE (serie -> stagioni -> episodi) -------------------------
// Struttura completa: usa la struttura episodi (pass 3, struct_<id>) come
// scheletro e aggancia i watch dell'utente per episode_id.
const STATO = { continuing:"in_corso", stopped:"abbandonata", up_to_date:"aggiornata",
                not_started_yet:"da_iniziare", watch_later:"da_vedere", finished:"finita" };
const serieSrc = okList("follows_serie_all").length ? okList("follows_serie_all") : okList("follows_serie");

// mappa tvdb_id serie -> struttura episodi (dai pull struct_<id>)
function structFor(seriesId) {
  const p = pulls.find((x) => x.label === `struct_${seriesId}` && x.ok);
  const d = p?.data?.episodes || p?.data?.data?.episodes;
  return Array.isArray(d) ? d : null;
}

const serie = serieSrc.map((s) => {
  const m = s.meta || {};
  const stato = (s.filter || []).map((f) => STATO[f]).find(Boolean);
  const wd = (s.sorting || []).find((x) => x.id === "watch_date");
  const struct = structFor(m.id);

  const base = {
    tvdb_id: m.id,
    stato: stato || undefined,
    follow_date: s.created_at,
    last_watch: wd ? wd.value : undefined,
  };

  if (!struct) {
    // Nessuna struttura disponibile: elenco piatto degli episodi visti.
    const flat = [...watchById.values()]
      .filter((w) => w.series_id === m.id)
      .map((w) => ({ episode_id: w.episode_id, watched_at: w.watched_at, rewatch_count: w.rewatch_count || 0 }));
    return { ...base, _noStructure: true, episodi_visti: flat };
  }

  // Raggruppo gli episodi della struttura per stagione, agganciando i watch.
  const bySeason = new Map();
  for (const e of struct) {
    const w = watchById.get(e.id);
    const sn = e.season ?? 0;
    if (!bySeason.has(sn)) bySeason.set(sn, []);
    bySeason.get(sn).push({
      tvdb_id: e.id,
      imdb_id: e.imdb_id || undefined,
      number: e.number,
      name: e.name,
      special: e.is_special || undefined,
      is_watched: Boolean(w),
      watched_at: w ? cleanDate(w.watched_at) : undefined,
      rewatch_count: w ? (w.rewatch_count || 0) : undefined,
    });
  }
  const seasons = [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, episodes]) => ({
      number,
      episodes: episodes.sort((a, b) => (a.number || 0) - (b.number || 0)),
    }));

  return { ...base, seasons };
});

// Serie VISTE ma non seguite: hanno una struttura (sono nel watch log) ma nessun
// follow object, quindi il map sopra le salta. Le ricostruisco così i loro
// episodi visti non spariscono dall'export.
{
  const followedIds = new Set(serieSrc.map((s) => String(s.meta?.id)).filter(Boolean));
  for (const p of pulls) {
    const mm = /^struct_(\d+)$/.exec(p.label || "");
    if (!mm || !p.ok || followedIds.has(mm[1])) continue;
    const struct = structFor(mm[1]);
    if (!struct) continue;
    const bySeason = new Map();
    let anyWatched = false;
    for (const e of struct) {
      const w = watchById.get(e.id);
      if (w) anyWatched = true;
      const sn = e.season ?? 0;
      if (!bySeason.has(sn)) bySeason.set(sn, []);
      bySeason.get(sn).push({
        tvdb_id: e.id,
        imdb_id: e.imdb_id || undefined,
        number: e.number,
        name: e.name,
        special: e.is_special || undefined,
        is_watched: Boolean(w),
        watched_at: w ? cleanDate(w.watched_at) : undefined,
        rewatch_count: w ? (w.rewatch_count || 0) : undefined,
      });
    }
    if (!anyWatched) continue;
    const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0])
      .map(([number, episodes]) => ({ number, episodes: episodes.sort((a, b) => (a.number || 0) - (b.number || 0)) }));
    serie.push({ tvdb_id: Number(mm[1]) || mm[1], seasons });
  }
}

// --- LISTE (preferiti + liste custom dell'utente) --------------------------
// Ogni lista: nome, descrizione, visibilità, e items (con id per reidratare).
function mapListItem(o) {
  return {
    tipo: o.type,                                  // series / movie
    tvdb_id: o.type === "series" ? o.id : undefined,
    uuid: o.type === "movie" ? o.uuid : undefined, // i film usano uuid
    custom_order: o.custom_order,
  };
}
function mapList(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description || undefined,
    is_public: raw.is_public,
    created_at: raw.created_at,
    items: (raw.objects || []).map(mapListItem),
  };
}

const listaPrefSerie = mapList(P("preferiti_serie"));
const listaPrefFilm  = mapList(P("preferiti_film"));
const listeCustom = okList("liste").map(mapList).filter(Boolean);

const liste = {
  preferiti_serie: listaPrefSerie,
  preferiti_film: listaPrefFilm,
  custom: listeCustom,
};

// --- COMMENTI --------------------------------------------------------------
// Testo scritto dall'utente + a cosa si riferisce. Dato personale suo.
const commentiRaw = P("commenti");
const commenti = (Array.isArray(commentiRaw) ? commentiRaw : []).map((c) => ({
  comment_id: c.comment_id,
  entity_type: c.entity_type,        // series / episode / movie
  entity_uuid: c.entity_uuid,        // uuid dell'oggetto commentato (identificatore)
  text: c.text,
  created_at: c.created_at,
  is_spoiler: c.is_spoiler || undefined,
  parent_uuid: c.parent_uuid || undefined,  // se è una risposta
}));


// Scala rating TV Time (stars_wording_scalev2): id sparsi -> stelle 1..5.
// order = "1,27,28,29,3" quindi la posizione+1 è il numero di stelle.
const RATING_ID = { 1: {nome:"bad",stelle:1}, 27:{nome:"ok",stelle:2}, 28:{nome:"good",stelle:3}, 29:{nome:"great",stelle:4}, 3:{nome:"wow",stelle:5} };

// L'aggregato stats (episode/voted) è una vista testuale: dà nomi-serie senza
// id, quindi non è portabile in modo pulito. Usiamo solo il PASS 2 (sotto),
// che ha gli identificatori. Le reazioni con stelle stanno in rating_titoli.


// --- VOTI DETTAGLIATI (pass 2) --------------------------------------------
// Label dinamiche prodotte dall'estensione:
//   rating_ep_<id> / rating_mv_<uuid>  -> rating stelle
//   pers_film_<uuid> / pers_serie_<uuid> -> personaggio votato
// Scala reazione testuale -> stelle (per l'aggregato serie).
const REAZIONE_STELLE = { bad: 1, ok: 2, good: 3, great: 4, wow: 5 };

function collectRatings() {
  const out = [];
  // Film ed episodi con id preciso (dal pass 2)
  for (const p of pulls) {
    if (!/^rating_(ep|mv)_/.test(p.label) || !p.ok) continue;
    const d = p.data?.data || p.data;
    for (const uv of (d?.user_votes || [])) {
      const map = RATING_ID[uv.rating_id];
      out.push({
        tipo: uv.type || (p.label.startsWith("rating_ep") ? "episode" : "movie"),
        episode_id: uv.episode_id || undefined,
        uuid: uv.uuid || undefined,
        nome: map?.nome,
        stelle: map?.stelle ?? null,
        data: uv.created ? new Date(uv.created * 1000).toISOString().slice(0,10) : undefined,
      });
    }
  }
  // Rating episodi a livello SERIE (dall'aggregato): "Wow su Grey's" = 5★.
  // Non ha l'episodio esatto, ma preserva il voto per serie.
  const agg = pulls.find((p) => p.label === "rating_serie_aggregato" && p.ok);
  const rows = agg?.data?.rows || agg?.data?.data?.rows || [];
  for (const r of rows) {
    const nome = (r.reazione || "").toLowerCase();
    out.push({
      tipo: "series",
      serie_name: r.serie_name,
      nome,
      stelle: REAZIONE_STELLE[nome] ?? null,
    });
  }
  return out;
}
function collectCharacterVotes() {
  const out = [];
  // Film (dal pass 2, con id): pers_film_<uuid>
  for (const p of pulls) {
    const m = /^pers_film_(.+)$/.exec(p.label);
    if (!m || !p.ok) continue;
    const d = p.data?.data || p.data;
    for (const uv of (d?.user_votes || [])) {
      out.push({
        tipo: "movie",
        subject_uuid: m[1],
        entity_id: uv.entity_id,
        personaggio: uv.character_name || undefined,
      });
    }
  }
  // Serie (dall'aggregato, con nome serie ma senza uuid episodio)
  const agg = pulls.find((p) => p.label === "pers_serie_aggregato" && p.ok);
  const rows = agg?.data?.rows || agg?.data?.data?.rows || [];
  for (const r of rows) {
    out.push({
      tipo: "series",
      serie_name: r.serie_name,   // nome serie (identificatore da reidratare)
      personaggio: r.personaggio,
    });
  }
  return out;
}
const rating_titoli = collectRatings();
const personaggi_votati_dettaglio = collectCharacterVotes();

// --- output JSON -----------------------------------------------------------
// --- OUTPUT: 3 file JSON separati ------------------------------------------
const meta = {
  exportedAt: raw.exportedAt,
  source: "TV Time",
  consent: raw.consent || undefined,
};

// smisto rating e personaggi tra film e serie
const ratingFilm = rating_titoli.filter((r) => r.tipo === "movie");
const ratingSerie = rating_titoli.filter((r) => r.tipo === "episode" || r.tipo === "series");
const persFilm = personaggi_votati_dettaglio.filter((p) => p.tipo === "movie");
const persSerie = personaggi_votati_dettaglio.filter((p) => p.tipo === "series");

// Copertine/fanart personalizzate scelte dall'utente su TV Time → reimportate
// come poster/banner scelti in Kitazo (chiave = tvdb id, tipo = series/movie).
const copertine = okList("copertine").map((o) => {
  const poster = o.poster && typeof o.poster === "object" ? o.poster.url : undefined;
  const fanart = o.fanart && typeof o.fanart === "object" ? o.fanart.url : undefined;
  const tvdb_id = o.entity_id ?? o.tvdb_id ?? o.id;
  const type = o.entity_type === "movie" ? "movie" : "series";
  if (tvdb_id == null || (!poster && !fanart)) return null;
  return { type, tvdb_id, poster_url: poster || undefined, fanart_url: fanart || undefined };
}).filter(Boolean);

const serieOut = {
  ...meta,
  serie,                       // serie -> stagioni -> episodi (con watch)
  rating_episodi: ratingSerie, // stelle su episodi
  personaggi_votati: persSerie,
};

const filmOut = {
  ...meta,
  film,
  rating_film: ratingFilm,     // stelle sui film
  personaggi_votati: persFilm,
};

const listeOut = {
  ...meta,
  liste,                       // preferiti + custom
  commenti,
  copertine,                   // poster/fanart personalizzati
};

// Impacchetta i 3 JSON in un unico zip.
const zip = makeZip([
  { name: "tvtime-serie.json", data: Buffer.from(JSON.stringify(serieOut, null, 2), "utf8") },
  { name: "tvtime-film.json",  data: Buffer.from(JSON.stringify(filmOut, null, 2), "utf8") },
  { name: "tvtime-liste.json", data: Buffer.from(JSON.stringify(listeOut, null, 2), "utf8") },
]);
writeFileSync("tvtime-migrazione.zip", zip);

// --- report ----------------------------------------------------------------
let epVisti = 0, conStruttura = 0, senzaStruttura = 0;
for (const s of serie) {
  if (s.seasons) { conStruttura++; for (const se of s.seasons) for (const e of se.episodes) if (e.is_watched) epVisti++; }
  else { senzaStruttura++; epVisti += (s.episodi_visti || []).length; }
}
const nCustom = liste.custom.length;
const nPref = (liste.preferiti_serie?.items.length || 0) + (liste.preferiti_film?.items.length || 0);
console.log("Convertito in 3 file JSON:");
console.log(`  tvtime-serie.json  → ${serie.length} serie (${conStruttura} con struttura, ${senzaStruttura} senza), ${epVisti} episodi visti`);
console.log(`                       ${ratingSerie.length} rating episodi, ${persSerie.length} personaggi`);
console.log(`  tvtime-film.json   → ${film.length} film, ${ratingFilm.length} rating, ${persFilm.length} personaggi`);
console.log(`  tvtime-liste.json  → ${nPref} preferiti, ${nCustom} liste custom, ${commenti.length} commenti`);
console.log(`\n  -> tutto in: tvtime-migrazione.zip`);
