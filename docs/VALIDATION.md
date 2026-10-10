# Collaudo di Jemiq

## Esito software e limite attuale

La suite automatica verifica il comportamento del catalogo e di [Jemiq Studio](STUDIO.md) con risposte controllate dei provider, inclusi errori e interruzioni. Non misura l’accuratezza dell’AI né la qualità fotografica degli sfondi. Le scansioni precedenti sul servizio Render hanno mostrato una richiesta Gemini rifiutata. Dopo la correzione del formato JSON è stato individuato un secondo parametro incompatibile con il modello, `candidateCount`, ora rimosso. Il commit `64f90a1` è stato distribuito con successo su Render, ma una scansione effettiva nell’app con una copertina sintetica di prova ha restituito ancora il rifiuto. È stata quindi aggiunta una diagnostica limitata a codici e campi ammessi per individuare la causa upstream senza registrare dati riservati. Le nuove generazioni Studio con credenziali reali non sono ancora collaudate.

Una richiesta bibliografica reale con ISBN `9780156453806` ha restituito il volume corretto tramite Open Library mentre Google Books rispondeva HTTP 429. Questo prova il fallback per quella richiesta, non la copertura dell’intero catalogo italiano.

La pausa del provider dopo HTTP 429/503 è verificata con test a tempo controllato: durante il periodo previsto le richieste successive evitano quel catalogo e possono utilizzare l’altro; alla scadenza una nuova richiesta riprova. Il valore predefinito è 30 secondi, con `Retry-After` valido limitato a 60 secondi. Questa verifica automatica è distinta dalla singola prova bibliografica reale.

## Verifiche eseguite il 10 ottobre 2026

| Verifica | Esito |
| --- | --- |
| Suite automatica estesa | 344 test superati in 13 file, inclusi catalogo, Studio e regressioni sui contratti REST e sui parametri dei modelli |
| TypeScript e build di produzione | Superati su Node 24 |
| Audit delle dipendenze di produzione | Nessuna vulnerabilità nota segnalata da `npm audit --omit=dev --audit-level=high` |
| Catalogo, browser desktop | Chromium 153, viewport 1440 px; avvio del bundle di produzione con CSP attiva |
| Catalogo, browser mobile emulato | Viewport 390 e 320 px; tabella, editor e conferma senza overflow orizzontale |
| Conferma edizione | Un candidato della demo diventa confermato solo dopo la scelta esplicita |
| Download | XLSX e CSV scaricati dal browser; XLSX riaperto e ISBN verificato come testo |
| Cronologia | Nome, quantità ed edizione confermata ritrovati dopo la ricarica |
| Inserimento manuale | ISBN invalido bloccato, conferma richiesta per un codice valido, annullamento senza righe vuote |
| Immagine di collaudo | PNG caricato, convertito in JPEG e ruotato di 90 gradi |
| Rete assente nella ricerca | Errore in italiano e catalogo conservato |
| Stream interrotto simulato | Riga ricevuta e avviso di interruzione conservati anche dopo la ricarica |
| Studio, HTTP e job | Sessione firmata, accesso/origine, isolamento browser, idempotenza, conflitto 409, polling, cancellazione e limiti verificati con provider simulato |
| Studio, proposta testuale | Scheda scelta riletta dal server, identità e riscontri delle fonti controllati, fallback esplicito e nessun retry automatico |
| Studio, grafica in Chromium | Conservazione di pixel e alpha nel percorso PNG su fixture, ritaglio prospettico ed export JPEG 1080 × 1350 / 1080 × 1920 verificati |
| Studio, persistenza | Progetti salvati in IndexedDB; bozze con testo temporaneamente vuoto conservate, generazione bloccata finché la proposta non è valida |
| Studio, UI desktop | Chromium 153.0.8010.0, 1440 × 1050; flusso completo con provider simulato, CSP attiva, font locali e nessun errore JavaScript |
| Studio, UI mobile emulata | 390 × 844 e 320 × 740, senza overflow nei tre passaggi; controlli touch di almeno 48 px e download JPEG Post/Storia verificati |

Le [schermate Studio](screenshots/jemiq-studio-start-desktop.png) mostrano l’app in esecuzione con copertina sintetica e ambientazione di collaudo, contrassegnate come tali: [ritaglio](screenshots/jemiq-studio-crop-desktop.png), [proposta](screenshots/jemiq-studio-brief-desktop.png), [risultato desktop](screenshots/jemiq-studio-result-desktop.png) e [mobile](screenshots/jemiq-studio-result-mobile.png). Non sono generazioni Gemini reali. Anche le schermate iniziali e della demo del catalogo, nella stessa cartella, sono state rigenerate con il nuovo marchio durante questo collaudo; i dati dimostrativi non provano il riconoscimento su fotografie reali.

Il collaudo UI Studio ha completato sette gruppi di prove, senza chiamate reali ai provider:

1. Bundle di produzione, CSP, font locali, accesso e passaggio Catalogo → Studio.
2. Ritaglio con controlli da tastiera e preparazione della proposta.
3. Bozza con campo vuoto conservata dopo ricarica, doppio clic con un solo POST, nessuna immagine nel POST di generazione e download JPEG nelle due dimensioni previste.
4. Modifica di un progetto completato con nuova bozza e originale conservato; gestione della ricerca lenta.
5. Risposta al POST persa e recupero soltanto con GET.
6. Ricarica durante un job in esecuzione, recupero soltanto con GET e cancellazione.
7. Flusso mobile, dimensioni dei controlli, assenza di overflow e download nei due formati.

Restano da verificare nell’ambiente operativo: riconoscimento e generazione Gemini con credenziali reali, fotocamera fisica e formati HEIC sui dispositivi, Safari e Android reali, build Docker e comportamento del proxy di hosting. Il deploy della nuova versione Studio non è parte delle prove locali riportate qui.

## Correzione del contratto REST Gemini

La prima scansione reale ha mostrato un errore di richiesta rifiutata. È stato individuato un difetto concreto nel payload: `generationConfig.responseFormat.text.mimeType` conteneva `application/json`, mentre il riferimento REST e il discovery ufficiale richiedono l'enum `APPLICATION_JSON`.

Il valore è stato corretto e il contratto viene confrontato con un estratto del discovery Google, revisione `20261008`. I MIME dell'immagine (`image/jpeg`, `image/png`, `image/webp`) restano stringhe IANA: il requisito dell'enum riguarda esclusivamente il formato dell'output. Lo schema bibliografico e i controlli ISBN non sono coinvolti.

Il precedente test del payload si aspettava lo stesso valore errato dell'implementazione e non intercettava il difetto. La regressione usa ora un riferimento indipendente. Non sono state eseguite chiamate Gemini con credenziali reali durante questa correzione; dopo l'aggiornamento del servizio Render occorre riprovare la scansione.

Fonti: [riferimento TextResponseFormat](https://ai.google.dev/api/generate-content#TextResponseFormat), [discovery REST v1beta](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta).

## Correzione dei parametri del modello dopo il secondo rifiuto

La richiesta conteneva ancora `generationConfig.candidateCount: 1`. La guida specifica di Gemini 3.8, aggiornata il 9 ottobre 2026, richiede di omettere `candidate_count` per Gemini 3 e successivi. Il discovery generale continua a elencare il campo perché descrive anche modelli precedenti: il controllo del solo enum JSON non intercettava questa incompatibilità.

Rimosso `candidateCount`, mantenendo il modello `gemini-3.8-flash`, l'enum REST `APPLICATION_JSON` e lo schema bibliografico. Non sono stati aggiunti tentativi automatici o chiamate a modelli alternativi.

La nuova regressione usa una fixture ricavata dalle restrizioni documentate del modello e un trasporto simulato che rifiuta i campi non supportati con HTTP 400. Eseguita prima della correzione, fallisce con lo stesso messaggio generico mostrato dall’app; dopo la rimozione del parametro passa. La regressione è mantenuta nella suite estesa di 344 test, con TypeScript e build superati. Anche le richieste Studio omettono `candidateCount`: il servizio testuale usa l’enum `APPLICATION_JSON`, il generatore immagini gli enum del proprio formato REST.

Questa verifica dimostra la rimozione di un difetto documentato del payload, non il successo di una scansione Gemini reale. Non sono state utilizzate credenziali operative durante la correzione. Il corpo dell'errore di produzione non è disponibile, quindi eventuali problemi di chiave, quota o account restano da verificare soltanto se il rifiuto persiste dopo il deploy aggiornato.

Fonti: [Gemini 3.8 — Migration checklist](https://ai.google.dev/gemini-api/docs/generate-content/latest-model), [Gemini 3.6 — Migration checklist](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6).

## Diagnostica dei rifiuti del provider

Il server registra `Jemiq Gemini rejection:` seguito da HTTP status, status RPC, motivi noti, categorie fisse, nomi di campi ammessi e brevi messaggi diagnostici ripuliti. I messaggi sono limitati a quattro estratti di 600 caratteri: chiave configurata, immagine, prompt, valori tra virgolette, URL e lunghe sequenze codificate vengono rimossi. Il corpo originale e gli oggetti con metadati dell’account vengono scartati. Anche i dettagli `BadRequest.fieldViolations` vengono esaminati per individuare il parametro rifiutato. Il corpo di errore viene letto entro 16 KiB e 1,5 secondi; una diagnostica non disponibile o un errore del logger non sostituiscono la classificazione HTTP originale.

Google documenta anche `400 / INVALID_ARGUMENT / API_KEY_INVALID`, quindi il solo HTTP 400 non dimostra un difetto del payload. Fonte: [GenerateContent API errors](https://ai.google.dev/gemini-api/docs/generate-content/api-errors).

## Studio: evidenze e confini delle prove

I test dei servizi Studio usano risposte simulate. Verificano che una stessa richiesta non avvii una seconda generazione, che un brief differente con la stessa UUID venga rifiutato, che altri browser non possano leggere o annullare il job e che perdita di connessione, timeout, quota e risposta malformata non producano un’immagine di successo fittizia. Il recupero utilizza GET; la scelta di generare una nuova immagine resta esplicita.

Il contesto bibliografico viene recuperato con endpoint fissi, controllando la scheda e l’identità del libro. Sinossi e categorie inviate dal client non sono accettate come fonti. I dati Open Library provengono dalla singola edizione. La proposta distingue origine `catalog`, `reader` e `style`; i riscontri testuali riducono le attribuzioni arbitrarie, ma non provano automaticamente l’assenza di spoiler o la pertinenza di ogni oggetto.

Le prove grafiche in Chromium usano immagini di collaudo, senza chiamare il generatore. Coprono il ritaglio a quattro punti, la trasformazione prospettica e il percorso PNG che mantiene la grafica della copertina e la trasparenza. La composizione finale è deterministica nel browser. I JPEG scaricabili hanno dimensioni 1080 × 1350 e 1080 × 1920; il ricampionamento e la compressione JPEG non conservano l’identità binaria dei pixel originali. Il modello genera soltanto l’ambientazione e non riceve la foto da sovrapporre.

La nuova identità visiva usa i [token del brand](brand/design-tokens.json), le [variabili CSS](../src/design-tokens.css), il logo originale e Noto Sans distribuito localmente con [licenza OFL](../public/fonts/OFL.txt). Il caricamento dei font locali e il layout desktop/mobile sono verificati in Chromium. La verifica del browser non sostituisce un controllo di accessibilità con tecnologie assistive e dispositivi reali.

### Protocollo UI Studio

1. Aprire Studio direttamente e dalla scheda di un libro. Caricare una foto, allineare gli angoli, controllare il ritaglio e verificare titolo/autore.
2. Preparare una proposta con una scheda disponibile e una senza metadati: nel secondo caso non devono comparire dettagli di trama attribuiti al catalogo. Modificare mood, elementi e palette.
3. Svuotare temporaneamente un campo del brief, cambiare progetto e riaprirlo: la bozza deve sopravvivere; l’invio al generatore deve restare bloccato finché i campi necessari non sono completati.
4. Verificare che l’identificativo sia salvato prima del POST. Simulare la perdita dell’acknowledgement, ricaricare e riaprire il progetto: soltanto GET di recupero, senza un secondo POST di generazione.
5. Simulare errore o cancellazione: nessuno sfondo fittizio, foto e bozza conservate. Una risposta tardiva di un altro progetto non deve essere applicata al libro corrente.
6. Su un progetto completato modificare libro, ISBN, stile o proposta: creare una nuova bozza, mantenendo coerenti immagine e dati dell’originale in cronologia. Una correzione dell’ISBN deve invalidare la vecchia provenienza.
7. Alternare Post e Storia e regolare scala/rotazione: controllo visivo di copertina, ombre e margini; nessuna chiamata aggiuntiva al generatore. Scaricare entrambi i JPEG e verificarne dimensioni e leggibilità.
8. Aprire due sessioni browser con lo stesso codice di accesso: un job deve essere recuperabile soltanto dalla sessione proprietaria. Verificare il messaggio di sessione scaduta dopo un riavvio.
9. Controllare che una ricerca lenta non permetta operazioni incompatibili e che annullamento o cambio progetto liberino i controlli. Verificare che salvataggio fallito prima dell’invio non avvii una generazione.
10. Impostare `STUDIO_ENABLED=false`, riavviare e verificare `studioReady: false` e blocco delle nuove generazioni. La configurazione non deve cancellare i progetti nel browser.

### Campione reale per Studio

Usare pochi libri di generi diversi, con copertine chiare/scure, titoli piccoli e fotografie inclinate. Per ogni generazione registrare modello, durata, errore eventuale e costo effettivo nel progetto Google. Controllare che scena e oggetti rispecchino la proposta, che non anticipino rivelazioni indesiderate e che titolo e grafica della copertina restino quelli fotografati. Valutare separatamente resa della fotografia, pertinenza della proposta e qualità dello sfondo.

Le prove di 429, scadenza e duplicazione vanno eseguite con i provider simulati della suite; non occorre consumare generazioni reali per raggiungere i limiti. Una verifica `/api/health` positiva indica configurazione presente, non credenziali verificate o costo nullo.

## Verifica funzionale

1. Senza chiave: stato da configurare. Demo solo tramite il comando esplicito.
2. Modificare un libro della demo, confermare un’edizione, esportare XLSX/CSV. Controllare il marcatore di esempio e gli ISBN come testo nel file XLSX.
3. Creare un elenco manuale, rinominarlo, modificare quantità, ricaricare e riaprirlo dalla cronologia.
4. Configurare Gemini e fotografare cinque libri. I risultati devono apparire progressivamente.
5. Annullare durante l’arricchimento: righe ricevute conservate, stato di lavoro incompleto.
6. Interrompere la rete o simulare 429/503: errore utile e dati conservati, mai sostituiti con la demo. Verificare che la pausa riguardi soltanto il provider che ha fallito. Se entrambi i cataloghi sono indisponibili, la ricerca manuale deve mostrare un errore temporaneo, mentre la scansione deve conservare le osservazioni con le relative note.
7. Correggere titolo o ISBN: la vecchia verifica non deve sopravvivere alla correzione.
8. Due copie dello stesso libro: segnalazione di possibile duplicato, senza accorpamento o inferenza di copie nascoste.

## Campione reale

Preparare almeno 20 fotografie con un elenco di riferimento compilato leggendo i libri fisici. Usare materiale del proprio negozio e mantenere le foto nel gruppo di lavoro.

| Gruppo | Casi |
| --- | --- |
| Tavoli | Copertine dritte, inclinate, parzialmente sovrapposte |
| Scaffali | Dorsi verticali e orizzontali, caratteri piccoli, sezioni affollate |
| Luce | Buona illuminazione, riflessi e ombra |
| Edizioni | Stessa opera in tascabile/cartonato, traduzioni, editori diversi |
| Catalogo | Titoli noti, piccoli editori italiani, fuori catalogo, senza ISBN |
| Negativi | Foto senza libri e libri interamente illeggibili |

Registrare per foto: modello, dimensioni immagine, durata, libri visibili e rilevati, titoli corretti, ISBN corretti e sbagliati, record lasciati correttamente da verificare e costo riportato dal provider.

Non misurare soltanto quanti libri sono riconosciuti: un ISBN errato dichiarato riscontrato è più dannoso di un titolo lasciato da verificare. Non fissare percentuali di affidabilità prima del collaudo.

## Dispositivi

Provare fotocamera e caricamento su Safari iPhone, Chrome Android, Safari macOS e Chrome/Edge desktop. Verificare HEIC su dispositivo compatibile, rotazione EXIF, tastiera virtuale, download e ripristino delle sessioni. L’emulazione di un viewport mobile non prova l’accesso alla fotocamera fisica.

## Hosting

Controllare HTTPS, `APP_ORIGIN`, proxy fidati, codice di accesso di almeno 16 caratteri, chiavi solo sul server e quote dei provider. Usare una singola istanza finché i limiti, le sessioni e i job non sono condivisi. Verificare che il proxy non bufferizzi `application/x-ndjson` e consenta richieste di tre minuti.

Per Studio provare polling, scadenza dei risultati e riavvio con un job simulato in corso. In produzione il processo conserva al massimo 4 sfondi e circa 32 MiB di stringhe, per non più di 30 minuti; le registrazioni leggere delle richieste durano fino a 24 ore. Il riavvio perde memoria e firma dei cookie. Il progetto locale sopravvive, ma un risultato non ancora ricevuto può andare perso. I limiti in memoria non costituiscono un tetto di spesa persistente.

Il modello immagini predefinito è `gemini-nano-banana-2.1`: usa `GEMINI_IMAGE_API_KEY` se presente, altrimenti `GEMINI_API_KEY`. Proposta testuale e riconoscimento usano la chiave e il modello già configurati. Verificare separatamente i permessi dei due modelli. Per applicare il codice usare **Manual Deploy → Deploy latest commit** come descritto in [Render](RENDER.md); un commit su GitHub non aggiorna il servizio quando l’auto-deploy è disabilitato.

Pubblicazione e collegamento delle credenziali reali sono passaggi distinti dalla consegna del codice in GitHub.
