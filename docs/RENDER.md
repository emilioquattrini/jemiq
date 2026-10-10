# Attivare Jemiq su Render

Il file [`render.yaml`](../render.yaml) prepara un servizio Node 24 nella regione di Francoforte, sul piano **Free per le prime prove**. Catalogo e [Jemiq Studio](STUDIO.md) funzionano nello stesso servizio. Le due credenziali iniziali si inseriscono direttamente nel pannello Render; Studio riutilizza la chiave Gemini esistente. Nessun valore segreto deve essere aggiunto al repository.

## 1. Apri la configurazione

**[Configura Jemiq su Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Femilioquattrini%2Fjemiq%2Ftree%2Fcodex%2Fjemiq-product)**

Accedi o crea un account Render. Il collegamento seleziona il ramo `codex/jemiq-product`, che contiene l'app e la configurazione; il ramo `main` non contiene ancora questa versione. Se Render chiede un nome per il Blueprint, usa `jemiq`.

Nella schermata di riepilogo deve comparire **un solo Web Service**, chiamato `jemiq`, con piano **Free**. Non servono database né dischi aggiuntivi.

## 2. Compila i due campi protetti

| Campo | Valore da inserire |
| --- | --- |
| `GEMINI_API_KEY` | La chiave creata in Google AI Studio. Incollala direttamente in Render. |
| `JEMIQ_ACCESS_TOKEN` | Una password dedicata a Jemiq, lunga almeno **16 caratteri**, preferibilmente generata dal gestore password. Conservala: sarà il codice da inserire nell'app. |

La chiave Gemini permette al server di riconoscere le foto, preparare la proposta Studio e generare gli sfondi, se il progetto Google ha accesso ai rispettivi modelli. Il codice di accesso permette a te di usare Jemiq: sono due valori diversi. Non incollare la chiave Gemini nel campo del codice di accesso dell’app.

Gli altri parametri sono già configurati: Node 24, porta assegnata da Render, ascolto sulla rete e URL pubblico. `APP_ORIGIN` usa automaticamente il valore `RENDER_EXTERNAL_URL` dello stesso servizio.

I segnaposto `sync: false` fanno chiedere le credenziali durante la **prima** creazione. Per modificarle in seguito, apri il servizio **jemiq → Environment → Environment Variables**, aggiorna il valore e scegli **Save and deploy**. Il solo salvataggio senza deploy non aggiorna il processo in esecuzione.

### Configurazione Studio su un servizio esistente

Non occorre aggiungere un altro servizio o un database. Dopo il deploy del codice Studio, la chiave `GEMINI_API_KEY` già presente è usata anche per gli sfondi. Nella stessa sezione **Environment** puoi impostare:

| Variabile | Quando serve |
| --- | --- |
| `GEMINI_IMAGE_MODEL` | Facoltativa: il codice usa già `gemini-nano-banana-2.1` come modello immagini predefinito. |
| `GEMINI_IMAGE_API_KEY` | Facoltativa: una chiave separata per le immagini. Se vuota o assente, viene usata `GEMINI_API_KEY`. |
| `STUDIO_ENABLED` | Imposta esattamente `false` per disabilitare nuove generazioni di sfondi; i progetti locali e la preparazione restano disponibili. |

`GEMINI_MODEL` continua a configurare riconoscimento e proposta testuale, con valore predefinito `gemini-3.8-flash`. Le chiavi restano variabili protette del server, senza prefissi `VITE_`. Salvare una nuova configurazione con deploy riavvia il processo: prima attendi la fine delle generazioni in corso e scarica le immagini che vuoi conservare.

## 3. Avvia e apri l'app

Completa la creazione del Blueprint e attendi che il servizio risulti **Live**. Apri l'indirizzo HTTPS `onrender.com` mostrato da Render; il nome effettivo può includere un suffisso.

Nel campo «Codice di accesso» di Jemiq inserisci il valore scelto per `JEMIQ_ACCESS_TOKEN`. Per il primo controllo del catalogo carica una foto nitida di pochi libri e verifica gli ISBN sulla copia fisica prima di esportare. Per Studio, carica la copertina di un solo libro, conferma il ritaglio e controlla l’atmosfera proposta prima di premere **Crea immagine**. [Guida al flusso Studio](STUDIO.md#uso).

Il controllo `/api/health` verifica l’avvio del server e la presenza della configurazione. `recognitionReady` riguarda la lettura, `studioReady` la generazione configurata e abilitata, `accessRequired` il codice di accesso. **Non prova che le chiavi siano valide, che i modelli siano accessibili o che il progetto abbia credito/quota.** Per confermare i due servizi servono una scansione e una generazione reali. Senza un codice di accesso valido in produzione, anche i campi di disponibilità rimangono falsi e le API sono chiuse.

## Costi e limiti delle prime prove

- Il Blueprint seleziona il piano Free del servizio, entro le quote Render. Dopo **15 minuti senza traffico** il server si sospende; alla visita successiva la riattivazione richiede circa **un minuto**. Per uso professionale quotidiano occorre un servizio sempre attivo.
- Render applica quote mensili a ore, traffico e build. Con un metodo di pagamento, alcuni superamenti possono generare addebiti; controlla il riepilogo del tuo account prima di attivare servizi a pagamento.
- L’uso dell’API Gemini ha quote e costi separati, legati al tuo progetto Google e ai modelli scelti. La generazione delle immagini non è inclusa nel piano Render. Le varianti Studio richiedono una nuova generazione esplicita; il cambio Post/Storia riutilizza localmente lo sfondo già ricevuto.
- Cataloghi e progetti Studio sono conservati nel browser: aprire l’app da un altro dispositivo o cancellare i dati del browser non li recupera. Esporta i cataloghi e scarica i JPEG che vuoi conservare.
- L’indirizzo dell’app è raggiungibile online. Il codice di accesso protegge le API del catalogo e di Studio; non è un sistema di account personali. Una sessione Studio con cookie firmato isola i job fra browser che usano lo stesso codice.

### Una sola istanza, memoria temporanea

Mantieni **una sola istanza** di Jemiq. I job Studio, le firme delle sessioni e i contatori di richieste sono in memoria, senza coda o archivio durevole. Un riavvio, un deploy o la sospensione del servizio possono perdere un risultato non ancora ricevuto dal browser. Il progetto locale conserva la foto e l’identificativo, ma non può ricostruire uno sfondo perso sul server.

Il processo ammette una generazione alla volta e applica limiti di 10 nuove richieste per IP ogni 10 minuti e 40 per ora complessive. Conserva al massimo 4 risultati, entro circa 32 MiB di stringhe, per non più di 30 minuti; i risultati possono scadere prima se la memoria disponibile è esaurita. Le registrazioni leggere per evitare duplicazioni restano fino a 24 ore, massimo 256 job. I contatori si azzerano al riavvio: non sono un tetto di spesa permanente del progetto Google.

Se la connessione cade, riapri il progetto e verifica lo stato: il recupero usa GET e non reinvia automaticamente una richiesta a pagamento. Se compare una sessione scaduta o un job non disponibile dopo un riavvio, una nuova generazione richiede una nuova azione dell’utente. [Tutti i limiti di Studio](STUDIO.md#richieste-costi-e-recupero).

## Aggiornamenti e manutenzione

Gli aggiornamenti automatici sono disabilitati nel Blueprint: un nuovo commit su GitHub non sostituisce da solo la versione online. Per distribuire Studio e il marchio aggiornato usa **jemiq → Deploys → Manual Deploy → Deploy latest commit** sul ramo **codex/jemiq-product** dopo aver verificato la nuova versione. Attendi **Live** e ricarica l’app. Se in futuro il codice viene unito a `main`, aggiorna anche il ramo collegato in Render e nel Blueprint.

La configurazione `TRUST_PROXY=1` presuppone l’accesso diretto tramite il proxy di Render, senza un proxy aggiuntivo scelto dall’utente. Prima dell’uso con più persone, verifica nel servizio effettivo che i limiti distinguano correttamente i client. Per più istanze occorrono limiti, sessioni, job e archivio dei risultati condivisi: aggiungere repliche all’attuale processo non fornisce queste capacità.

Per un servizio operativo è raccomandata anche una chiave `GOOGLE_BOOKS_API_KEY`, da aggiungere nella stessa sezione Environment. È facoltativa per le prime prove; senza quota Books disponibile interviene il fallback Open Library.

## Stato della verifica

Configurazione preparata il 10 ottobre 2026 sulla documentazione ufficiale e validata rispetto allo schema JSON Render. Avvio di produzione verificato localmente con `HOST=0.0.0.0`, porta assegnata e origine HTTPS: homepage e health check raggiungibili, origine corretta e codice valido ammessi, origine estranea respinta con 403, codice assente respinto con 401. Nessuna chiamata a Gemini o ai cataloghi durante questa prova.

Le prove precedenti sul servizio Render riguardano il catalogo e l’apertura dell’interfaccia sul telefono. Dopo la correzione del formato di output REST, una scansione successiva ha mostrato ancora un rifiuto. Nel codice è stato individuato e rimosso anche `candidateCount`, parametro non supportato dal modello Gemini 3.8. La correzione precedente dell’enum MIME `APPLICATION_JSON` resta valida. Studio conserva queste correzioni; le richieste dei nuovi servizi rispettano i contratti REST verificati senza reintrodurre `candidateCount`.

La suite estesa supera **338 test in 12 file**, TypeScript e build di produzione; l’audit delle dipendenze di produzione non segnala vulnerabilità note. Il percorso grafico Studio è stato verificato in Chromium su immagini di prova: PNG intermedio, prospettiva e JPEG nei formati 1080 × 1350 e 1080 × 1920. Il flusso UI completo, il recupero senza un secondo POST e i download sono verificati su desktop e viewport mobile di 390 e 320 px, senza overflow nei tre passaggi, con provider simulato. Non sono stati rilevati errori JavaScript. Queste prove non sono un deploy su Render né generazioni eseguite con credenziali reali.

Dopo il deploy manuale, la correzione del riconoscimento deve ancora essere confermata con una scansione nel servizio aggiornato. Per Studio restano da verificare accesso effettivo al modello, qualità dello sfondo, pertinenza, tempi e costo di una generazione reale. Restano inoltre da controllare il proxy e i dispositivi fisici. I dettagli sono nel [protocollo di collaudo](VALIDATION.md).

## Documentazione Render

- [Collegamento Deploy to Render e selezione del ramo](https://render.com/docs/deploy-to-render)
- [Blueprint: campi, variabili e credenziali al primo avvio](https://render.com/docs/blueprint-spec)
- [Variabili d'ambiente e segreti](https://render.com/docs/configure-environment-variables)
- [Variabili predefinite, incluso RENDER_EXTERNAL_URL](https://render.com/docs/environment-variables)
- [Piano Free e limiti](https://render.com/docs/free)
- [Versione Node](https://render.com/docs/node-version)
- [Aggiornamento manuale del servizio](https://render.com/docs/deploys#manual-deploys)
