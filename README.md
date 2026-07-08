# TV Time Extractor by Kitazo

Estensione Chrome (Manifest V3) che esporta i tuoi dati TV Time direttamente
dalla tua sessione, più uno script che li ripulisce per la migrazione.
Tutto resta sul tuo computer.

## File

Carica in Chrome l'**intera cartella**: serve tutta. I file dell'estensione:
- `manifest.json`, `inject.js`, `bridge.js`, `background.js`, `popup.html`,
  `popup.js`, `converter.js` (conversione al volo) e `icons/`.

Script di pulizia da riga di comando (opzionale, gira con Node):
- `convert-tvtime.mjs`

Lo schema completo dei file JSON prodotti è documentato in [`docs/SCHEMA.md`](docs/SCHEMA.md).

## Installazione (da GitHub, senza Chrome Web Store)

L'estensione **non è sul Chrome Web Store**: TV Time chiude il 15 luglio 2026 e
i tempi di revisione dello store sono troppo lunghi. Si installa "non
pacchettizzata" (modalità sviluppatore), procedura normale e sicura per uno
strumento one-shot come questo — il codice resta tutto sul tuo computer.

### 1. Scarica i file da GitHub
1. Vai alla pagina del repository su GitHub.
2. Premi il pulsante verde **`< > Code`** → **Download ZIP**.
3. Scompatta lo ZIP: ottieni una cartella (es. `kitazo-chrome-extension-main`)
   con dentro `manifest.json` e gli altri file.

### 2. Carica in Chrome
1. Apri `chrome://extensions`
2. Attiva **Modalità sviluppatore** (interruttore in alto a destra).
3. Premi **Carica estensione non pacchettizzata**.
4. Seleziona la **cartella scompattata** (quella che contiene `manifest.json`,
   non lo ZIP).
5. L'icona Kitazo compare nella barra. Se avevi una versione precedente,
   **rimuovila prima** per evitare mix di versioni.

Va bene anche Edge, Brave, Opera (stesso menu). Serve il browser **desktop**:
su mobile non funziona.

> **In English:** the extension is not on the Chrome Web Store. On the GitHub
> repo page click **`< > Code` → Download ZIP**, unzip it, then open
> `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and
> select the unzipped folder (the one containing `manifest.json`). Works on
> Chrome/Edge/Brave/Opera desktop. Use the **IT / EN** switch in the popup to
> change language.

## Come esportare

1. Apri `https://app.tvtime.com` e accedi.
2. Apri il popup dell'estensione: il pallino diventa verde con il tuo user id.
   In alto a destra puoi scegliere la lingua (**IT / EN**).
3. (Opzionale) La spunta **"Trova i personaggi preferiti dei singoli episodi"**
   serve SOLO a quello: scansiona gli episodi visti uno per uno (1-2 minuti). Se
   la togli, tutto il resto — visti, film, rating, liste, commenti, preferiti —
   viene scaricato comunque.
4. Premi **Scarica visti, film e show** e **ASPETTA che finisca**: il pulsante
   mostra l'avanzamento e l'export resta bloccato finché la raccolta non è
   completa.
5. Spunta la conferma di consenso, poi premi **Scarica i miei dati (ZIP)** per
   salvare `tvtime-migrazione-<data>.zip`.

Suggerimento: prima di avviare, apri anche la tua **pagina statistiche** (serie
e film) così la cattura passiva raccoglie eventuali endpoint extra.

## Cosa viene raccolto

- Storico episodi visti (id + date)
- Film visti (id + date)
- Serie seguite con **stato** (in corso / abbandonata / aggiornata / da vedere)
- Preferiti
- Commenti scritti da te
- **Rating a stelle** (1-5) di film ed episodi votati, con data
- **Personaggi votati** (film confermato; serie secondo lo schema TV Time)

## Cosa scarica l'utente

Premendo "Scarica i miei dati (ZIP)" l'estensione converte tutto al volo e
scarica un unico `tvtime-migrazione-<data>.zip` con 3 file JSON già puliti:
- `tvtime-serie.json`  — serie -> stagioni -> episodi (con watch), rating episodi, personaggi
- `tvtime-film.json`   — film, rating film, personaggi votati dei film
- `tvtime-liste.json`  — preferiti + liste custom + commenti

La conversione (in converter.js) tiene SOLO dato-utente + identificatori
(TVDB/IMDb id, uuid) e SCARTA i metadati di TV Time (nomi, copertine, cast,
badge), che vanno reidratati nella tua app da TVDB/TMDb.

## Convertitore da riga di comando (opzionale)

Per uso batch/debug è disponibile anche lo script standalone:

    node convert-tvtime.mjs tvtime-export-<data>.json   # produce tvtime-migrazione.zip

### Cosa tiene / cosa scarta

TIENE (dato personale + chiave per reidratare):
  episodi   episode_id, series_id, watched_at, rewatch_count
  film      tvdb_id, imdb_id, watched_at, is_watched, rewatch_count
  serie     tvdb_id, stato, follow_date, last_watch
  preferiti tvdb_id
  commenti  text, entity_uuid, created_at, is_spoiler
  rating    stelle 1-5, data, id titolo
  personaggi personaggio, entity_id, subject (film/serie)

SCARTA (metadato TV Time, da reidratare da TVDB/TMDb):
  nomi, anno, generi, is_ended, paese, copertine, cast, badge,
  metriche aggregate (like_count, comment_count)

## Note tecniche

- Endpoint privati non ufficiali (msapi.tvtime.com, api2.tozelabs.com,
  stats.tvtime.com, votes.tvtime.com), instradati via il proxy /sidecar.
- Scala rating: rating_id 1=bad 27=ok 28=good 29=great 3=wow -> 1..5 stelle.
- I personaggi votati dei film usano votes/subject/<uuid>; per le serie lo
  schema è tentato ma non garantito da tutti gli account.

## Legale / privacy

Questo strumento facilita la portabilità dei dati dell'utente (GDPR Art. 20)
durante la dismissione di TV Time (15 luglio 2026). Importa SOLO i dati
dell'utente esportante, non contenuti di altri utenti. Reidrata i metadati dei
titoli da fonti con licenza propria (TVDB/TMDb). Per un lancio pubblico, fai
validare il modello da un legale IP/data e raccogli consenso esplicito.

Dopo aver usato/condiviso un HAR: cambia la password di TV Time, perché l'HAR
contiene il tuo token di sessione.
