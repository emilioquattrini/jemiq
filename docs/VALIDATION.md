# Collaudo Jemiq 2

## Ambito

Solo riconoscimento fotografico, verifica bibliografica, cataloghi, persistenza ed export. La precedente funzionalità di generazione social è stata rimossa. I risultati storici non vanno presentati come prove della nuova distribuzione.

## Prove automatiche

Eseguire `npm run typecheck`, `npm test`, `npm run build`, `npm run build:standalone` e l’audit delle dipendenze di produzione. La build Sites e quella Node sono separate e usano la stessa implementazione API.

Le prove HTTP mantengono una connessione reale al server Node per verificare progressione dei libri, ammissione delle richieste, disconnessione, timeout e conservazione dei risultati parziali. I test del nuovo archivio eseguono SQL su SQLite reale, simulando solo il servizio oggetti R2. Gli errori pubblici devono essere privi di chiavi e dati grezzi del provider.

## Prova bibliografica del 11 ottobre 2026

Con un’osservazione sintetica contenente ISBN 9780156453806, titolo Invisible Cities e autore Italo Calvino, il servizio bibliografico ha trovato una corrispondenza coerente su Open Library (`OL16827152M`) in circa 8,3 secondi, mentre Google Books rispondeva HTTP 429. La prova riguarda il recupero dei metadati e il fallback: non coinvolge Gemini né misura la lettura fotografica.

## Verifica end-to-end

Sul sito pubblicato eseguire una sola chiamata esplicita di controllo testo e una scansione con immagine nota. Verificare gli eventi NDJSON, il titolo/autore osservato, gli avvisi e l’assenza di ISBN inventato. Registrare separatamente che il materiale di prova è sintetico quando non deriva da una foto di un libro reale.

Controllare anche un salvataggio con foto, il recupero della stessa foto, l’aggiornamento con revisione, il rifiuto di una revisione obsoleta, la separazione dei proprietari e l’eliminazione del catalogo di prova. Rimuovere i dati di collaudo creati appositamente e disattivare l’eventuale accesso tecnico temporaneo.

## Limiti del collaudo

L’ambiente corrente non dispone della capacità browser richiesta da Sites per il collaudo visivo: la nuova distribuzione non è stata verificata con una fotocamera fisica o tramite interazione browser automatizzata. I test unitari, HTTP e di build non sostituiscono una prova sul dispositivo dell’utente.

Prima di un impiego operativo esteso, usare un campione controllato di tavoli e scaffali reali, con ISBN noti, riprese inclinate, luce variabile e libri parzialmente coperti. Misurare separatamente libri rilevati, titolo/autore corretti, corrispondenze di edizione ed errori che l’utente deve correggere. Non dichiarare una percentuale di accuratezza senza questo campione.
