# Distribuire Jemiq senza Render

## Sorgente condiviso

- `server/fetch-app.ts`: API HTTP, autenticazione, streaming, limiti, cataloghi e impostazioni.
- `server/vision.ts`: lettura Gemini e validazione indipendente dei libri.
- `server/catalog.ts`: confronto delle edizioni e fallback bibliografico.
- `server/storage/d1-r2.ts`: archivio dell’installazione Sites.
- `server/storage/file.ts`: archivio portabile per una singola istanza Node.
- `src/lib/storage.ts`: copia locale, sincronizzazione, conflitti e backup.
- `app/api/[...path]/route.ts`: adattatore Sites con identità della piattaforma.
- `server/app.ts`: adattatore Express della medesima API.

## Sites

Il progetto privato usa i binding `DB` per D1 e `BUCKET` per R2. Il database contiene cataloghi separati per proprietario, impostazioni cifrate e contatori delle richieste. R2 conserva le foto su chiavi costruite dal server a partire da hash di proprietario e catalogo; non sono ammesse destinazioni fornite dal browser.

Le variabili server si configurano nell’ambiente del progetto. Nessuna chiave va in `.openai/hosting.json`, nel bundle client, in `NEXT_PUBLIC_*` o in `VITE_*`. Le impostazioni salvate nell’app usano AES-256-GCM, con il proprietario autenticato come dato associato, e una chiave di cifratura conservata nei secrets dell’hosting.

L’accesso tecnico è disattivato salvo `JEMIQ_SERVICE_ACCESS_ENABLED=true`. Quando attivo, il token assegna esclusivamente il proprietario `service`, separato dagli account reali. Non è un modo per impersonare un utente; non abilitarlo per gli utenti ordinari.

La build usa il runtime Vinext fornito da Sites. `npm run build` prepara `dist/`; le migrazioni Drizzle devono essere incluse nel sorgente pubblicato. Il comando di generazione non applica migrazioni alla produzione.

## Node o Docker

Il server autonomo usa gli stessi servizi di lettura e catalogazione; l’archivio è una directory con file atomici, foto e controllo della revisione. Il codice di accesso autentica un unico spazio condiviso dell’installazione: non è un sistema multiutente. Il server non dipende da DB o R2 e non contatta Sites.

1. Configurare `.env` dalla copia `.env.example`.
2. Impostare Gemini, un codice di accesso casuale e l’origine HTTPS.
3. Eseguire `npm ci`, `npm run build:standalone`, `npm start`, oppure `docker compose up --build -d`.
4. Conservare e sottoporre a backup `JEMIQ_DATA_DIR` o il volume Docker `jemiq_data`.
5. Usare una sola istanza Node con questa directory. Per più istanze serve un adattatore di persistenza condiviso.

Un normale riavvio non elimina cataloghi e foto. Un nuovo container conserva i dati solo se il volume è mantenuto. I backup JSON dell’app sono il formato portabile per trasferire i cataloghi tra installazioni.

## Migrazione da una vecchia origine

Il browser isola i dati per origine. Il nuovo sito non può aprire la memoria locale di un vecchio indirizzo Render. Se la vecchia UI supporta solo CSV/Excel, esportare quei file per conservare i dati tabellari; per trasferire foto e struttura interna occorre un backup completo prodotto dalla vecchia origine. Non promettere una migrazione automatica da un browser o dispositivo diverso.

I dati della nuova applicazione possono essere trasferiti dal comando **Backup**, quindi **Importa backup** nell’installazione di destinazione. Importare non sovrascrive gli identificativi già presenti: crea copie con nuovi identificativi.

## Ripristino e aggiornamento

Prima di una migrazione strutturale, esportare un backup completo. Pubblicare solo un commit che supera test e le due build. In caso di problemi del nuovo codice, distribuire una versione precedente compatibile con lo schema corrente: il rollback del codice non annulla automaticamente una migrazione dati.

Non ruotare `SETTINGS_ENCRYPTION_KEY` senza una migrazione delle configurazioni salvate: i vecchi record cifrati diventerebbero illeggibili. La normale sostituzione della chiave Gemini avviene dal pannello privato con verifica prima del salvataggio. Sul server Node si aggiorna il secret nell’ambiente e si riavvia il processo.
