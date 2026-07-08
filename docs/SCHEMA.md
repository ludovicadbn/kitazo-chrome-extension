# TV Time Extractor by Kitazo — Schema dei file di export

L'estensione produce un archivio `tvtime-migrazione-<data>.zip` con 3 file JSON:

| File | Contenuto |
|------|-----------|
| `tvtime-serie.json` | Serie -> stagioni -> episodi VISTI, rating episodi, personaggi votati |
| `tvtime-film.json`  | Film visti, rating film, personaggi votati dei film |
| `tvtime-liste.json` | Preferiti, liste personalizzate, commenti |

> Schema verificato contro l'output reale dell'estensione v6.21.

## Principi generali

- **Solo dato dell'utente + identificatori.** Niente copertine, cast o
  descrizioni. I nomi (serie/episodi/personaggi) sono inclusi per comodità ma
  NON sono la fonte autorevole: reidrata i metadati da TVDB/TMDb usando gli id.
- **Solo episodi VISTI.** Dentro le stagioni ci sono solo gli episodi guardati.
  Ogni serie riporta `episodi_totali` ed `episodi_visti` per il contesto.
- **Identificatori** (per collegare i dati ai titoli):
  - `tvdb_id` (number) — id TheTVDB. Presente ovunque.
  - `imdb_id` (string, es. `"tt4520988"`) — quando disponibile.
  - `uuid` (string) — id interno TV Time. Riferimento/fallback.
- **Date**: ISO 8601 UTC o `YYYY-MM-DD`. Le date placeholder (epoch zero) sono
  già rimosse: campo data **assente** = "non disponibile", non è 1970.
- **Campi opzionali**: se un valore manca, la chiave è **assente** (non `null`,
  salvo dove indicato).

## Metadati comuni (in tutti e 3 i file)

```jsonc
{
  "exportedAt": "2026-07-08T16:40:35.000Z",  // ISO 8601 — data creazione export
  "source": "TV Time",                        // sempre "TV Time"
  "consent": {                                // consenso dell'utente (presente
    "given": true,                            //   nell'export reale)
    "statement": "...",
    "timestamp": "2026-07-08T16:40:35.000Z"
  }
}
```

---

## 1. `tvtime-serie.json`

Chiavi: `exportedAt`, `source`, `consent`, `serie`, `rating_episodi`,
`personaggi_votati`.

### `serie[]`

```jsonc
{
  "tvdb_id": 346328,               // number — id TheTVDB serie (chiave)
  "stato": "aggiornata",           // string — vedi "Stati serie"
  "follow_date": "2018-10-07T09:45:05Z",  // string ISO | assente
  "last_watch": "2022-04-24T15:34:14Z",   // string ISO | assente
  "episodi_totali": 64,            // number — episodi totali della serie
  "episodi_visti": 64,             // number — quanti visti
  "seasons": [
    {
      "number": 1,                 // number — stagione (0 = speciali)
      "episodes": [                // SOLO episodi visti
        {
          "tvdb_id": 6671792,      // number — id TheTVDB episodio
          "imdb_id": "tt7671662",  // string | assente
          "number": 1,             // number — numero episodio
          "name": "Welcome",       // string — titolo (comodità)
          "special": true,         // boolean | assente — se speciale
          "watched_at": "2022-01-11T18:47:59Z", // string ISO | assente
          "rewatch_count": 0       // number
        }
      ]
    }
  ]
}
```

Serie senza episodi visti: `seasons: []`. Se manca la struttura (raro):
`_noStructure: true` + `episodi_visti: [...]` (lista piatta con `episode_id`).

### `rating_episodi[]`

Rating a stelle. Due formati:

```jsonc
// PRECISO (opzione "voti per episodio" attiva): episodio esatto + data.
{
  "tipo": "series", "serie_name": "Answer Me 1988", "tvdb_id": 301078,
  "season": 1, "episode": 3, "episode_name": "Episode 3",
  "nome": "wow", "stelle": 5,      // bad|ok|good|great|wow -> 1..5
  "data": "2024-05-10",            // YYYY-MM-DD | assente
  "preciso": true
}
// AGGREGATO (default): sai serie + voto + in quante puntate, NON quali.
{
  "tipo": "series", "serie_name": "Answer Me 1988", "tvdb_id": 301078,
  "nome": "wow", "stelle": 5,
  "volte": 1,                      // number — in quante puntate hai votato
  "preciso": false
}
```

### `personaggi_votati[]`

```jsonc
// PRECISO (opzione attiva): un elemento per ogni voto, con episodio.
{
  "tipo": "series", "serie_name": "Friendly Rivalry", "tvdb_id": 445778,
  "season": 1, "episode": 4, "episode_name": "Episode 4",
  "personaggio": "Yoo Jae-yi",     // string
  "attore": "Lee Hye-ri",          // string | assente
  "character_id": 69095943,        // number — id personaggio TV Time
  "preciso": true
}
// AGGREGATO (default): personaggio top per serie + quante volte.
{
  "tipo": "series", "serie_name": "Nevertheless,", "tvdb_id": 398079,
  "personaggio": "Na-bi", "volte": 1, "preciso": false
}
```

### Stati serie (`stato`)

| Valore | Significato |
|--------|-------------|
| `in_corso` | La sta guardando |
| `abbandonata` | Ha smesso |
| `aggiornata` | In pari con gli episodi usciti |
| `da_iniziare` | Watchlist, non iniziata |
| `da_vedere` | Segnata per dopo |
| `finita` | Completata |

Assente se non determinabile.

---

## 2. `tvtime-film.json`

Chiavi: `exportedAt`, `source`, `consent`, `film`, `rating_film`,
`personaggi_votati`.

### `film[]`

```jsonc
{
  "tvdb_id": 9436,                 // number | assente
  "imdb_id": "tt4520988",          // string | assente
  "watched_at": "2020-07-19T15:28:15Z",  // string ISO | assente
  "is_watched": true,              // boolean | assente
  "rewatch_count": 0               // number
}
```

### `rating_film[]`

```jsonc
{
  "tipo": "movie",
  "uuid": "aa96c2e5-...",          // string — uuid film TV Time
  "tvdb_id": 9436,                 // number | assente
  "imdb_id": "tt4520988",          // string | assente
  "nome": "good", "stelle": 3,     // bad|ok|good|great|wow -> 1..5
  "data": "2026-07-08"             // YYYY-MM-DD — quando ha votato
}
```

### `personaggi_votati[]`

```jsonc
{
  "tipo": "movie",
  "subject_uuid": "aa96c2e5-...",  // string — uuid del film
  "tvdb_id": 9436,                 // number | assente
  "imdb_id": "tt4520988",          // string | assente
  "entity_id": "12316740",         // string — id personaggio
  "personaggio": "Elsa (voice)"    // string
}
```

---

## 3. `tvtime-liste.json`

Chiavi: `exportedAt`, `source`, `consent`, `liste`, `commenti`.

### `liste`

```jsonc
{
  "preferiti_serie": { ... } | null,
  "preferiti_film":  { ... } | null,
  "custom": [ { ... } ]            // liste create dall'utente (0..N)
}
```

Ogni lista: `id`, `name`, `is_public`, `created_at`, `items[]`.

Item:
```jsonc
{ "tipo": "series", "tvdb_id": 403245, "custom_order": 1 }
{ "tipo": "movie", "uuid": "b0a8...", "tvdb_id": 9436, "imdb_id": "tt...", "custom_order": 0 }
```
(per i film, `tvdb_id`/`imdb_id` possono mancare se il film è solo in lista e
mai seguito.)

### `commenti[]`

```jsonc
{
  "comment_id": 1927926,           // number
  "entity_type": "series",         // series|episode|movie
  "entity_uuid": "2be5b307-...",   // string — uuid oggetto commentato
  "tvdb_id": 344643,               // number | assente — serie/film collegato
                                   //   (per episodi: tvdb della SERIE)
  "imdb_id": "tt...",              // string | assente — solo film
  "text": "...",                   // string | assente (assente se solo immagine)
  "image_url": "https://...jpg",   // string | assente — foto/meme allegato
  "image_format": "meme",          // string | assente
  "created_at": "2026-07-08T08:21:43Z", // string ISO
  "is_spoiler": true,              // boolean | assente
  "parent_uuid": "..."             // string | assente — se è una risposta
}
```

Le immagini sono URL su server TV Time (CloudFront): dopo la chiusura potrebbero
sparire. Scaricale durante l'import se vuoi conservarle.

---

## Scala rating (reazioni -> stelle)

| nome | stelle |
|------|--------|
| bad | 1 | ok | 2 | good | 3 | great | 4 | wow | 5 |

`stelle` è già calcolato; `nome` è la reazione originale.

## Note per l'import

1. **Collega ai titoli** con `tvdb_id`/`imdb_id`, mai col nome.
2. **Solo visti**: usa `episodi_totali`/`episodi_visti` per il completamento.
3. **Reidrata** nome/copertina/cast da TVDB/TMDb via id.
4. **Date assenti** = sconosciuto, non convertire.
5. **`preciso`**: `true` = episodio esatto noto (opzione "voti per episodio").
   `false` = dall'aggregato (serie + `volte`, senza episodio).
6. **Commenti su episodi**: collegati al `tvdb_id` della serie.
7. **Liste vuote/null** possibili.
