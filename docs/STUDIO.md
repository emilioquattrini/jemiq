# Jemiq Studio

Studio aggiunge un percorso dedicato a un libro: foto della copertina, identificazione, proposta di atmosfera e immagine per una recensione. Il marchio e l’interfaccia seguono il brand book Jemiq 1.0 fornito dal proprietario: tracciati originali del logo, Noto Sans distribuito localmente, colori e dimensioni dei token allegati.

## Uso

1. Apri **Studio**, oppure **Crea immagine** dalla scheda di un libro del catalogo.
2. Scatta o carica una foto di un solo libro chiuso, con tutta la copertina visibile. Preferisci una ripresa frontale o dall’alto, senza dita e riflessi sul titolo.
3. Allinea i quattro angoli alla copertina. Il ritaglio viene raddrizzato usando la fotografia originale. Controlla titolo e autore oppure cerca la scheda bibliografica.
4. Scegli **Atmosferico**, **Essenziale** o **Cinematografico**, aggiungi se vuoi un mood e una breve impressione personale, e prepara la proposta. Controlla descrizione, palette e oggetti prima della generazione.
5. Crea un’ambientazione, controlla l’anteprima e scarica JPEG **1080 × 1350 (post)** o **1080 × 1920 (storia)**. Formato, dimensione e inclinazione del libro si modificano localmente sullo stesso sfondo.

I progetti sono salvati nel browser, separati dai cataloghi, anche quando i campi della proposta sono temporaneamente vuoti durante una modifica. Una proposta incompleta deve essere completata prima della generazione. Cambiare libro o contesto dopo aver generato crea una nuova bozza e conserva l’originale nella cronologia. Sono disponibili fino a 20 progetti: non vengono eliminati automaticamente per fare spazio. Scarica i risultati prima di cancellare i dati del browser. Un altro dispositivo non vede questi progetti.

## Protezione della copertina

La foto del libro non viene inviata al modello che genera lo sfondo. Per il riconoscimento può essere inviata al modello visivo, come nel catalogo. La copertina viene poi ritagliata, raddrizzata e sovrapposta nel browser all’ambientazione generata, con un’ombra di contatto.

La grafica e il testo provengono dalla foto originale, senza rigenerazione. Raddrizzamento, ridimensionamento ed esportazione JPEG ricampionano i pixel: non si promette identità binaria con il file originale. La funzione non ricostruisce parti nascoste, dorso o spessore non visibili. Dita, riflessi e difetti della foto richiedono uno scatto migliore.

La foto locale viene ridotta al massimo a 2000 px sul lato lungo; il ritaglio è conservato in PNG fino a 1600 px. La trasparenza viene conservata nel percorso di composizione. Il JPEG destinato al riconoscimento è un derivato separato. I quattro punti correggono la prospettiva di una copertina piana; non costituiscono uno scontorno volumetrico automatico.

## Come nasce la proposta

Il server rilegge la scheda bibliografica scelta usando endpoint fissi Google Books o Open Library. Un URL inviato dal browser non viene aperto direttamente. Titolo, autori e dati dell’edizione devono risultare coerenti prima che la descrizione sia usata.

Descrizione e categorie sono limitate e ripulite. La proposta distingue elementi ispirati al catalogo, indicazioni del lettore e scelte decorative. Le fonti sono costruite dal server. Il modello non deve ricostruire la trama dal titolo o dalla memoria. La regola iniziale è usare la premessa, l’ambientazione e temi generali, evitando rivelazioni: l’assenza di spoiler non può essere garantita dalla sola validazione strutturale, quindi la proposta resta modificabile prima di generare.

Se mancano metadati, quota o un risultato utilizzabile, viene mostrata una composizione semplice dichiarata come tale, basata sullo stile e sul mood inserito. La nota personale non viene presentata come interpretata se il modello non l’ha elaborata. Questo fallback non effettua altre chiamate AI.

## Configurazione

| Variabile server | Valore / effetto |
| --- | --- |
| `GEMINI_API_KEY` | Chiave esistente per riconoscimento e proposta; usata anche per le immagini se non c’è una chiave dedicata |
| `GEMINI_MODEL` | Modello testuale e visivo esistente, predefinito `gemini-3.8-flash` |
| `GEMINI_IMAGE_MODEL` | Modello immagini, predefinito `gemini-nano-banana-2.1` |
| `GEMINI_IMAGE_API_KEY` | Facoltativa, consente una chiave/progetto separato per le immagini |
| `STUDIO_ENABLED` | `false` disabilita le nuove generazioni; qualsiasi altro valore mantiene il comportamento predefinito |

Tutte le chiavi restano sul server, senza prefissi `VITE_`. Il modello immagini richiede accesso e fatturazione nel progetto Google. `/api/health` riporta la presenza della configurazione, non prova la validità della chiave, le quote, il credito o la qualità dei risultati.

Su Render il modello predefinito è già nel codice: non serve una nuova chiave se la chiave esistente è abilitata a quel modello. Puoi impostare un progetto dedicato nelle variabili protette. Le generazioni partono soltanto dopo un’azione esplicita nell’app.

## Richieste, costi e recupero

- Al massimo una generazione di sfondo alla volta per processo. Un’azione crea una sola immagine 2K 4:5, poi riutilizzata per entrambi i formati.
- Limiti applicativi di 10 nuove richieste per IP ogni 10 minuti e 40 per processo ogni ora. Sono limiti in memoria, non un tetto di spesa persistente: un riavvio li azzera.
- La sessione Studio usa un cookie firmato, `HttpOnly`, `SameSite=Strict`, `Secure` in produzione, oltre al codice di accesso Jemiq. I job sono isolati per sessione.
- Il browser salva l’identificativo della richiesta prima dell’invio. Il server conserva l’identità per evitare una seconda chiamata dello stesso job. Una richiesta con stesso ID ma proposta diversa è respinta.
- La connessione alla pagina può interrompersi mentre il server lavora. Il browser recupera lo stato tramite GET; non reinvia automaticamente una generazione a pagamento.
- Gli sfondi temporanei restano al massimo 30 minuti e possono scadere prima per il limite di memoria: 4 risultati e circa 32 MiB di stringhe nel processo di produzione. Il browser salva il risultato ricevuto nel progetto locale.
- Le piccole registrazioni delle richieste restano fino a 24 ore, con un massimo di 256 job. Un job scaduto non viene rigenerato implicitamente.
- Timeout del generatore 150 secondi; limite complessivo del job 180 secondi. La proposta testuale ha un limite totale di 45 secondi.
- Annullare una richiesta non garantisce che il provider non l’abbia già elaborata o addebitata. Un timeout non comporta un retry automatico.

**Riavvii e più utenti:** questa versione usa un processo singolo e un archivio temporaneo in memoria. Un riavvio cancella job e firma delle sessioni. Il progetto locale sopravvive, ma un risultato non ancora ricevuto può essere perso. Per un servizio pubblico servono account, quote persistenti, coda durevole e archivio privato esterno; questa versione non simula tali capacità.

## Verifica prima dell’uso pubblico

I test automatici usano risposte dei provider simulate e contratti REST controllati sul Discovery Google e sulle regole specifiche dei modelli. Sono superati 338 test, typecheck e build di produzione. Le prove in Chromium verificano ritaglio, formato, salvataggio e recupero, con il percorso completo su desktop e viewport mobile a 390 e 320 px. Le [evidenze di collaudo](VALIDATION.md) distinguono controlli automatici, prove nel browser e verifiche ancora da eseguire. Per misurare pertinenza, qualità fotografica, tempi e costo effettivo servono generazioni reali sul progetto Google del proprietario.

Il protocollo suggerito comprende libri con copertine chiare, scure, lettering piccolo e generi diversi; confronto della copertina prima/dopo; controllo di oggetti, ombre e ritaglio nei due formati; prova di rete interrotta, quota esaurita e riavvio del servizio. Accettare il risultato soltanto dopo controllo visivo.

## Riferimenti

- [Gemini: generazione delle immagini](https://ai.google.dev/gemini-api/docs/image-generation)
- [Nano Banana 2.1: modello e capacità](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1)
- [Riferimento REST GenerateContent](https://ai.google.dev/api/generate-content)
- [Discovery REST v1beta](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta)
- [Google Books: Volume](https://developers.google.com/books/docs/v1/reference/volumes)
- [Gemini: prezzi aggiornati](https://ai.google.dev/gemini-api/docs/pricing)
- [Render: limiti del piano Free](https://render.com/docs/free)

## Identità visiva

I [token JSON](brand/design-tokens.json) conservano la specifica originale. Le [variabili CSS](../src/design-tokens.css) sono distribuite con il frontend. Il logo è estratto dai tracciati del brand book, senza ricomporre il nome con il font dell’interfaccia. I font web sono distribuiti con la [licenza OFL](../public/fonts/OFL.txt).
