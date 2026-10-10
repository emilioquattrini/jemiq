# Collaudo di Jemiq

## Esito software e limite attuale

La suite automatica verifica il comportamento del codice con risposte controllate dei provider, inclusi errori e interruzioni. Non misura l’accuratezza dell’AI. La nuova implementazione deve ancora essere provata su foto reali con la chiave Gemini dell’ambiente operativo.

Una richiesta bibliografica reale con ISBN `9780156453806` ha restituito il volume corretto tramite Open Library mentre Google Books rispondeva HTTP 429. Questo prova il fallback per quella richiesta, non la copertura dell’intero catalogo italiano.

La pausa del provider dopo HTTP 429/503 è verificata con test a tempo controllato: durante il periodo previsto le richieste successive evitano quel catalogo e possono utilizzare l’altro; alla scadenza una nuova richiesta riprova. Il valore predefinito è 30 secondi, con `Retry-After` valido limitato a 60 secondi. Questa verifica automatica è distinta dalla singola prova bibliografica reale.

## Verifiche eseguite il 10 ottobre 2026

| Verifica | Esito |
| --- | --- |
| Suite automatica | 150 test superati in 6 file |
| TypeScript e build di produzione | Superati su Node 24 |
| Audit dipendenze di produzione | Nessuna vulnerabilità nota segnalata da `npm audit --omit=dev` |
| Browser desktop | Chromium 153, viewport 1440 px; avvio del bundle di produzione con CSP attiva |
| Browser mobile emulato | Viewport 390 e 320 px; tabella, editor e conferma senza overflow orizzontale |
| Conferma edizione | Un candidato della demo diventa confermato solo dopo la scelta esplicita |
| Download | XLSX e CSV scaricati dal browser; XLSX riaperto e ISBN verificato come testo |
| Cronologia | Nome, quantità ed edizione confermata ritrovati dopo la ricarica |
| Inserimento manuale | ISBN invalido bloccato, conferma richiesta per un codice valido, annullamento senza righe vuote |
| Immagine di collaudo | PNG caricato, convertito in JPEG e ruotato di 90 gradi |
| Rete assente nella ricerca | Errore in italiano e catalogo conservato |
| Stream interrotto simulato | Riga ricevuta e avviso di interruzione conservati anche dopo la ricarica |

Le schermate in [screenshots](screenshots/) provengono dall’app in esecuzione, con dati della demo esplicitamente indicati. Non sono risultati di riconoscimento su fotografie reali. I test browser non hanno rilevato errori JavaScript nell’app.

Restano da verificare nell’ambiente operativo: riconoscimento Gemini con credenziali reali, fotocamera fisica e formati HEIC sui dispositivi, Safari e Android reali, build Docker e comportamento del proxy di hosting.

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

Controllare HTTPS, `APP_ORIGIN`, proxy fidati, codice di accesso di almeno 16 caratteri, chiavi solo sul server e quote dei provider. Usare una singola istanza finché i limiti non sono condivisi. Verificare che il proxy non bufferizzi `application/x-ndjson` e consenta richieste di tre minuti.

Pubblicazione e collegamento delle credenziali reali sono passaggi distinti dalla consegna del codice in GitHub.
