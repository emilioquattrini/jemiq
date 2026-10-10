# Attivare Jemiq su Render

Il file [`render.yaml`](../render.yaml) prepara un servizio Node 24 nella regione di Francoforte, sul piano **Free per le prime prove**. Le due credenziali si inseriscono direttamente nel pannello Render. Nessun valore segreto deve essere aggiunto al repository.

## 1. Apri la configurazione

**[Configura Jemiq su Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Femilioquattrini%2Fjemiq%2Ftree%2Fcodex%2Fjemiq-product)**

Accedi o crea un account Render. Il collegamento seleziona il ramo `codex/jemiq-product`, che contiene l'app e la configurazione; il ramo `main` non contiene ancora questa versione. Se Render chiede un nome per il Blueprint, usa `jemiq`.

Nella schermata di riepilogo deve comparire **un solo Web Service**, chiamato `jemiq`, con piano **Free**. Non servono database né dischi aggiuntivi.

## 2. Compila i due campi protetti

| Campo | Valore da inserire |
| --- | --- |
| `GEMINI_API_KEY` | La chiave creata in Google AI Studio. Incollala direttamente in Render. |
| `JEMIQ_ACCESS_TOKEN` | Una password dedicata a Jemiq, lunga almeno **16 caratteri**, preferibilmente generata dal gestore password. Conservala: sarà il codice da inserire nell'app. |

La chiave Gemini permette al server di riconoscere le foto. Il codice di accesso permette a te di usare Jemiq: sono due valori diversi.

Gli altri parametri sono già configurati: Node 24, porta assegnata da Render, ascolto sulla rete e URL pubblico. `APP_ORIGIN` usa automaticamente il valore `RENDER_EXTERNAL_URL` dello stesso servizio.

I segnaposto `sync: false` fanno chiedere le credenziali durante la **prima** creazione. Per modificarle in seguito, apri il servizio **jemiq → Environment → Environment Variables**, aggiorna il valore e scegli **Save and deploy**. Il solo salvataggio senza deploy non aggiorna il processo in esecuzione.

## 3. Avvia e apri l'app

Completa la creazione del Blueprint e attendi che il servizio risulti **Live**. Apri l'indirizzo HTTPS `onrender.com` mostrato da Render; il nome effettivo può includere un suffisso.

Nel campo «Codice di accesso» di Jemiq inserisci il valore scelto per `JEMIQ_ACCESS_TOKEN`. Per il primo controllo carica una foto nitida di pochi libri e verifica gli ISBN sulla copia fisica prima di esportare.

Il controllo `/api/health` verifica l'avvio del server e la presenza della configurazione: **non prova che la chiave Gemini sia valida o che il progetto abbia credito/quota**. Questo si verifica con una scansione reale. Se manca la configurazione, la demo resta disponibile ed è dichiarata come tale.

## Costi e limiti delle prime prove

- Il Blueprint seleziona il piano Free del servizio, entro le quote Render. Dopo **15 minuti senza traffico** il server si sospende; alla visita successiva la riattivazione richiede circa **un minuto**. Per uso professionale quotidiano occorre un servizio sempre attivo.
- Render applica quote mensili a ore, traffico e build. Con un metodo di pagamento, alcuni superamenti possono generare addebiti; controlla il riepilogo del tuo account prima di attivare servizi a pagamento.
- L'uso dell'API Gemini ha quote e costi separati, legati al tuo progetto Google.
- La cronologia è conservata nel browser: aprire l'app da un altro dispositivo o cancellare i dati del browser non recupera quei cataloghi. Esporta i file che vuoi conservare.
- L'indirizzo dell'app è raggiungibile online. Il codice di accesso protegge le API di scansione e ricerca; non è un sistema di account personali.

## Aggiornamenti e manutenzione

Gli aggiornamenti automatici sono disabilitati nel Blueprint: un nuovo commit su GitHub non sostituisce da solo la versione online. Per aggiornare il servizio usa **Manual Deploy** dopo aver verificato la nuova versione. Se in futuro il codice viene unito a `main`, aggiorna anche il ramo collegato in Render e nel Blueprint.

La configurazione `TRUST_PROXY=1` presuppone l'accesso diretto tramite il proxy di Render, senza un proxy aggiuntivo scelto dall'utente. Prima dell'uso con più persone, verifica nel servizio effettivo che i limiti distinguano correttamente i client. Per più istanze occorrono limiti e cache condivisi.

Per un servizio operativo è raccomandata anche una chiave `GOOGLE_BOOKS_API_KEY`, da aggiungere nella stessa sezione Environment. È facoltativa per le prime prove; senza quota Books disponibile interviene il fallback Open Library.

## Stato della verifica

Configurazione preparata il 10 ottobre 2026 sulla documentazione ufficiale e validata rispetto allo schema JSON Render. Avvio di produzione verificato localmente con `HOST=0.0.0.0`, porta assegnata e origine HTTPS: homepage e health check raggiungibili, origine corretta e codice valido ammessi, origine estranea respinta con 403, codice assente respinto con 401. Nessuna chiamata a Gemini o ai cataloghi durante questa prova.

La creazione dell'account, l'inserimento delle credenziali e il primo deploy devono ancora essere completati nel pannello Render. La disponibilità e le prestazioni del servizio, il proxy effettivo e il riconoscimento su foto reali si verificano dopo questo passaggio.

## Documentazione Render

- [Collegamento Deploy to Render e selezione del ramo](https://render.com/docs/deploy-to-render)
- [Blueprint: campi, variabili e credenziali al primo avvio](https://render.com/docs/blueprint-spec)
- [Variabili d'ambiente e segreti](https://render.com/docs/configure-environment-variables)
- [Variabili predefinite, incluso RENDER_EXTERNAL_URL](https://render.com/docs/environment-variables)
- [Piano Free e limiti](https://render.com/docs/free)
- [Versione Node](https://render.com/docs/node-version)
