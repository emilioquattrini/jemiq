# Jemiq

**Fotografa. Controlla. Esporta.**

Jemiq trasforma la foto di un tavolo o di uno scaffale di libri in un catalogo modificabile: titolo, autore, ISBN quando riscontrato, editore e altri metadati disponibili. L’interfaccia è in italiano e segue il brand book Jemiq: colore #172A31, accento #F36B4F, logo originale e Noto Sans servito localmente.

## Il prodotto

1. Scatta una foto con la fotocamera o scegli un’immagine JPEG, PNG o WebP.
2. Seleziona **Scaffale** o **Tavolo** e avvia la lettura.
3. I libri compaiono progressivamente. Controlla le corrispondenze, scegli un’edizione quando necessario o modifica i dati.
4. Esporta l’elenco selezionato in **CSV o Excel**. Crea un **backup JSON** per trasferire l’intero archivio, comprese le foto.

L’app contiene esclusivamente il riconoscimento fotografico e la gestione del catalogo. La funzione di creazione di immagini per social è stata rimossa su richiesta del proprietario.

### ISBN e affidabilità

Un ISBN non viene inventato a partire dal titolo. Lo stato **ISBN riscontrato** richiede un ISBN visibile valido e metadati coerenti. Una scelta esplicita dell’utente è marcata **Confermato da te**. Le altre righe restano **Da verificare** o **Da completare**.

Un errore su un singolo libro nella risposta AI non elimina gli altri libri validi. Gli avvisi restano nel catalogo e negli export. Un’indisponibilità di Google Books o Open Library non diventa una ricerca riuscita senza risultati: il problema è segnalato e i dati visibili nella foto sono mantenuti.

La demo è un esempio dichiarato, incluso nei file esportati. Non sostituisce automaticamente una scansione fallita. L’accuratezza dipende da luce, dimensione dei caratteri, sovrapposizioni e porzione di copertina o dorso visibile.

## Due modalità di esecuzione

| Modalità | Applicazione | Archivio | Accesso |
| --- | --- | --- | --- |
| Hosting Sites | React/Vinext e Worker Cloudflare | D1 per cataloghi, R2 per fotografie | Identità verificata dalla piattaforma, cataloghi separati per account |
| Server autonomo | React/Vite ed Express su Node 24 | Directory persistente `JEMIQ_DATA_DIR` | Codice di accesso privato; archivio condiviso della singola installazione |

Il codice API, il motore di lettura e le regole bibliografiche sono condivisi. **Render non è richiesto.** La modalità Node può essere spostata su un server o un container compatibile, senza riscrivere il prodotto.

L’indipendenza dal servizio di hosting non elimina la necessità di un modello AI: il riconoscimento usa Gemini via API; i metadati sono ricercati su Google Books e Open Library. Demo, inserimento manuale ed export restano disponibili senza chiamate AI.

## Salvataggio e backup

Il catalogo viene scritto prima nella copia locale del browser e sincronizzato con l’archivio del server. La UI distingue salvataggio confermato, operazioni in attesa, errore e conflitto con un’altra modifica. I cataloghi di account diversi usano archivi locali separati. Le API controllano l’identità autenticata e rifiutano un proprietario diverso da quello catturato dal client.

La cronologia carica i metadati; la foto completa viene recuperata all’apertura del catalogo o durante il backup. Gli aggiornamenti usano una revisione del server per evitare sovrascritture silenziose. Un backup JSON include foto, libri, selezioni e avvisi. Un’importazione con identificativi già esistenti crea nuove copie.

**Un nuovo dominio non può leggere l’IndexedDB del vecchio dominio.** I vecchi cataloghi presenti soltanto nel browser della precedente installazione vanno esportati da quell’installazione. Se è disponibile solo CSV/Excel, quei file restano consultabili ma non ricostruiscono automaticamente le foto e tutte le informazioni interne. La migrazione locale esplicita dell’app nuova riguarda i dati presenti sul medesimo dominio; non accede alla memoria di altri siti.

## Avvio autonomo

Requisito: **Node.js 24**.

```bash
npm ci
cp .env.example .env
npm run dev:standalone
```

Apri `http://localhost:3000`. Configura `GEMINI_API_KEY` in `.env` e un `JEMIQ_ACCESS_TOKEN` casuale di almeno 16 caratteri prima della produzione. Non inserire i segreti in Git o nei file pubblici del browser.

Produzione:

```bash
npm run build:standalone
npm start
```

Il risultato autonomo è in `dist-node/`; il risultato per Sites è separato in `dist/`. Con Docker:

```bash
docker compose up --build -d
```

Il volume `jemiq_data` conserva cataloghi e fotografie. Il servizio è esposto su `127.0.0.1:3000`. Per usarlo da telefono configura un reverse proxy HTTPS e `APP_ORIGIN` con l’URL effettivo: la fotocamera richiede un contesto sicuro. Imposta `TRUST_PROXY` solo per il numero reale di proxy fidati. La modalità file è progettata per un solo processo Node; non condividere la directory tra più istanze.

## Configurazione

| Variabile | Uso |
| --- | --- |
| `GEMINI_API_KEY` | Segreto per il riconoscimento fotografico |
| `GEMINI_MODEL` | Modello, predefinito `gemini-3.8-flash` |
| `GOOGLE_BOOKS_API_KEY` | Facoltativa, chiave dedicata per le ricerche Google Books |
| `JEMIQ_ACCESS_TOKEN` | Accesso al server autonomo, almeno 16 caratteri |
| `APP_ORIGIN` | Origine HTTPS ammessa per le richieste |
| `JEMIQ_DATA_DIR` | Directory persistente del server Node, predefinita `.data` |
| `HOST`, `PORT`, `TRUST_PROXY` | Rete del server Node |
| `SETTINGS_ENCRYPTION_KEY` | Chiave server per cifrare le configurazioni salvate su Sites |
| `JEMIQ_SERVICE_ACCESS_ENABLED` | Accesso tecnico isolato tramite token su Sites; disattivato normalmente |

Nel pannello **Impostazioni** del sito privato la configurazione esistente è visibile senza mostrare le chiavi. Una nuova chiave viene salvata solo dopo una verifica esplicita riuscita. La verifica è una breve chiamata di testo: non sostituisce il collaudo di una fotografia. Il server autonomo legge le proprie chiavi dall’ambiente e presenta il pannello in sola lettura.

## Limiti operativi

Il server effettua una singola chiamata AI per scansione, senza retry AI automatici. Le ricerche bibliografiche hanno timeout, concorrenza limitata, cache con limite di memoria e interruzione su cancellazione. La pipeline conserva i risultati già arrivati anche in caso di errore successivo.

I budget predefiniti sono 20 scansioni ogni 10 minuti per account/IP e 100 all’ora complessive. Le verifiche AI hanno limiti separati. Su Sites i contatori sono atomici in D1 e persistono tra riavvii; sul server Node i contatori e il limite di concorrenza appartengono al singolo processo e si azzerano al riavvio. Questi sono limiti di richieste, non un tetto monetario garantito: costi e quote dipendono dall’account Gemini.

Ogni catalogo ha al massimo 1 MiB di metadati e ogni fotografia 8 MiB. Le immagini inviate sono ricodificate e ridimensionate nel browser. Il server non registra immagini, chiavi, testo integrale delle risposte del provider o dati dell’account negli errori pubblici.

## Dati e riservatezza

La foto preparata viene inviata a Jemiq e a Gemini per il riconoscimento. Foto e catalogo vengono conservati nell’archivio privato dell’installazione e nella copia locale del browser. Titoli, autori e ISBN necessari alle ricerche vengono inviati ai cataloghi bibliografici. La conservazione applicata dai provider dipende dalle loro condizioni e dalla configurazione dell’account.

Eliminare un catalogo rimuove la copia attiva locale e quella sul server, compresa la foto; i file esportati o eventuali backup esterni restano sotto il controllo dell’utente. Un errore di sincronizzazione deve essere risolto prima di considerare completata una cancellazione remota.

## Sviluppo e verifica

```bash
npm run typecheck
npm test
npm run build
npm run build:standalone
npm audit --omit=dev --audit-level=high
```

La CI verifica entrambe le build. Le prove coprono checksum ISBN, corrispondenze e conflitti tra edizioni, risposta AI parzialmente invalida, timeout, cancellazione, flusso NDJSON reale su HTTP, isolamento degli account, concorrenza degli aggiornamenti, backup e import, CSV ed Excel riaperti per verificare i dati.

Per Sites: lo schema è in `db/schema.ts`; genera e controlla le migrazioni con `npm run db:generate`. Le migrazioni in `drizzle/` vengono applicate dalla pubblicazione. Non creare tabelle durante le richieste. I binding richiesti sono `DB` e `BUCKET`, dichiarati in `.openai/hosting.json`.

Vedi [architettura e distribuzione](docs/DEPLOYMENT.md) e [protocollo di collaudo](docs/VALIDATION.md). Le schermate storiche in `docs/screenshots/` illustrano la precedente UI di riconoscimento: non costituiscono un collaudo della nuova distribuzione.
