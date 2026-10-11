# Collaudo Jemiq 2

## Ambito

Solo riconoscimento fotografico, verifica bibliografica, cataloghi, persistenza ed export. La precedente funzionalità di generazione social è stata rimossa. I risultati storici non vanno presentati come prove della nuova distribuzione.

## Prove automatiche

Eseguire `npm run check:runtime`, `npm run typecheck`, `npm test`, `npm run build` e `npm run build:standalone`. La build Sites e quella Node sono separate e usano la stessa implementazione API. Il controllo locale delle dipendenze impedisce regressioni sotto le versioni runtime già verificate; non consulta un database di nuove vulnerabilità.

Le prove HTTP mantengono una connessione reale al server Node per verificare progressione dei libri, ammissione delle richieste, disconnessione, timeout e conservazione dei risultati parziali. I test del nuovo archivio eseguono SQL su SQLite reale, simulando solo il servizio oggetti R2. Gli errori pubblici devono essere privi di chiavi e dati grezzi del provider.

## Prova bibliografica del 11 ottobre 2026

Con un’osservazione sintetica contenente ISBN 9780156453806, titolo Invisible Cities e autore Italo Calvino, il servizio bibliografico ha trovato una corrispondenza coerente su Open Library (`OL16827152M`) in circa 8,3 secondi, mentre Google Books rispondeva HTTP 429. La prova riguarda il recupero dei metadati e il fallback: non coinvolge Gemini né misura la lettura fotografica.

## Verifica end-to-end

### Esito operativo del 11 ottobre 2026

Versione Sites dal commit `b184327c44354a5963ee78b9046c1927ea1c0b8b`, corrispondente al tree GitHub `35d87b2a698248ae8e0e4f110b0c838299c518da` del commit `a44cbf4abd2b3e155d78c1b30196bf2bd017c0fd`.

- Controllo di testo Gemini reale: riuscito.
- Scansione di `tests/fixtures/synthetic-cover.png`: riuscita in **5.691 ms**, titolo **PRIDE AND PREJUDICE**, autore **JANE AUSTEN**. L’ISBN non stampato nella copertina è stato lasciato vuoto.
- Google Books ha risposto 429 e Open Library 521 durante questa prova. La riga è rimasta «Da completare», con titolo/autore conservati e avvisi nelle note: nessun dato bibliografico è stato simulato.
- Salvataggio catalogo con foto in D1/R2, lista senza byte della foto, dettaglio con foto identica verificata tramite hash: riusciti.
- Aggiornamento con revisione e mantenimento della foto: riuscito. Revisione obsoleta: 409. Richiesta senza revisione: 400. Proprietario discordante: 403.
- Cancellazione del catalogo temporaneo e successiva lettura 404: riuscite. I dati di collaudo sono stati rimossi.
- Suite completa, typecheck, build Sites, build Node e audit produzione senza vulnerabilità: riusciti anche nella [CI GitHub](https://github.com/emilioquattrini/jemiq/actions/runs/38116481351).

Il primo probe sul Worker aveva evidenziato che il runtime non supporta `redirect: error`, pur essendo accettato da Node. I tre servizi esterni ora usano `manual` e rifiutano esplicitamente i redirect, con regressioni dedicate: non inoltrano foto o credenziali a una nuova destinazione.

Lo script `tests/live-smoke.mjs` documenta il collaudo ripetibile. È escluso dalla suite automatica ordinaria perché esegue due chiamate AI reali; richiede credenziali via stdin nascosto e un accesso tecnico esplicitamente abilitato. Un token di bypass scaduto va rinnovato dal progetto: non fornisce un’identità utente.

### Protocollo per le prossime versioni

Sul sito pubblicato eseguire una sola chiamata esplicita di controllo testo e una scansione con immagine nota. Verificare gli eventi NDJSON, il titolo/autore osservato, gli avvisi e l’assenza di ISBN inventato. Registrare separatamente che il materiale di prova è sintetico quando non deriva da una foto di un libro reale.

Controllare anche un salvataggio con foto, il recupero della stessa foto, l’aggiornamento con revisione, il rifiuto di una revisione obsoleta, la separazione dei proprietari e l’eliminazione del catalogo di prova. Rimuovere i dati di collaudo creati appositamente e disattivare l’eventuale accesso tecnico temporaneo.

## Controllo delle dipendenze effettivamente pubblicate

Il controllo esteso del pacchetto Worker ha individuato `react-server-dom-webpack` tra i componenti incorporati nel server, benché fosse classificato come dipendenza di sviluppo. React, React DOM e RSC sono stati allineati a `19.2.8`, la correzione indicata nell'[advisory React GHSA-wx67-qw84-cm4g](https://github.com/react/react/security/advisories/GHSA-wx67-qw84-cm4g). RSC è ora una dipendenza di produzione, verificata dal controllo locale della CI e inclusa in un eventuale audit di produzione.

La ripetizione dell'audit online dopo questo aggiornamento è stata bloccata dalla revisione automatica degli accessi, perché invia al registro npm l'albero delle dipendenze e metadati del progetto. Non viene presentata come eseguita. Per evitare lo stesso invio indiretto, la CI ordinaria installa con `--no-audit` ed esegue `check:runtime`; il workflow «Audit npm su richiesta» è separato e richiede avvio esplicito. Il precedente esito dell'audit resta riferito alla versione e alla classificazione delle dipendenze allora testate.

Il precedente audit esteso segnalava inoltre dipendenze degli strumenti di build e collaudo (`braces`, `image-size`, `undici`, `ws` e relativi pacchetti dipendenti). Nell'artefatto Worker esaminato non sono stati riscontrati il loro codice o import esterni che li carichino: `image-size`, in particolare, è usato da Vinext per i metadati durante la build. Queste segnalazioni della toolchain restano distinte dal controllo delle dipendenze di produzione; non si dichiara un audit esteso interamente privo di segnalazioni.

## Limiti del collaudo

L’ambiente corrente non dispone della capacità browser richiesta da Sites per il collaudo visivo: la nuova distribuzione non è stata verificata con una fotocamera fisica o tramite interazione browser automatizzata. I test unitari, HTTP e di build non sostituiscono una prova sul dispositivo dell’utente.

Prima di un impiego operativo esteso, usare un campione controllato di tavoli e scaffali reali, con ISBN noti, riprese inclinate, luce variabile e libri parzialmente coperti. Misurare separatamente libri rilevati, titolo/autore corretti, corrispondenze di edizione ed errori che l’utente deve correggere. Non dichiarare una percentuale di accuratezza senza questo campione.
