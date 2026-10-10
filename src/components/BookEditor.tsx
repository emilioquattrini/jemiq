import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, ArrowUpRight, BookOpen, Check, CheckCheck, ChevronDown, LoaderCircle, Search, X } from 'lucide-react';
import type { BookRecord, CatalogCandidate } from '../../shared/types';
import { isValidIsbn, toIsbn13 } from '../../shared/isbn';
import { searchCatalog } from '../lib/api';
import { confirmCandidate, updateBook } from '../lib/books';

interface BookEditorProps {
  book: BookRecord;
  onSave: (book: BookRecord) => void;
  onDelete: (id: string) => void;
  onAccessRequired: () => void;
  onClose: () => void;
}

function editionDetails(candidate: CatalogCandidate): string {
  return [candidate.publisher, candidate.publishedDate, candidate.language?.toUpperCase()].filter(Boolean).join(' · ') || 'Altri dati non disponibili';
}

export default function BookEditor({ book, onSave, onDelete, onAccessRequired, onClose }: BookEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  const searchController = useRef<AbortController | null>(null);
  const [title, setTitle] = useState(book.title);
  const [authors, setAuthors] = useState(book.authors.join('; '));
  const [isbn, setIsbn] = useState(book.isbn13 || '');
  const [publisher, setPublisher] = useState(book.publisher || '');
  const [publishedDate, setPublishedDate] = useState(book.publishedDate || '');
  const [language, setLanguage] = useState(book.language || '');
  const [notes, setNotes] = useState(book.notes || '');
  const [quantity, setQuantity] = useState(String(book.quantity));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState([book.title, book.authors[0]].filter(Boolean).join(' ').slice(0, 240));
  const [candidates, setCandidates] = useState(book.candidates);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [accessRequired, setAccessRequired] = useState(false);
  const [tab, setTab] = useState<'details' | 'editions'>(book.status === 'review' && book.candidates.length ? 'editions' : 'details');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { searchController.current?.abort(); element?.close(); };
  }, []);

  useEffect(() => {
    if (error) errorNotice.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!title.trim()) { setError('Inserisci almeno il titolo del libro.'); return; }
    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1 || count > 9999) { setError('La quantità deve essere un numero intero tra 1 e 9999.'); return; }
    if (isbn.trim() && !isValidIsbn(isbn)) { setError('L’ISBN non è valido: controlla tutte le cifre oppure lascia il campo vuoto.'); return; }
    const editedAuthors = authors.split(';').map((author) => author.trim()).filter(Boolean);
    if (editedAuthors.length > 30 || editedAuthors.some((author) => author.length > 2000)) { setError('Inserisci al massimo 30 autori, separati da un punto e virgola.'); return; }
    const bibliographyChanged = title.trim() !== book.title || JSON.stringify(editedAuthors) !== JSON.stringify(book.authors) || toIsbn13(isbn) !== book.isbn13 || (publisher.trim() || null) !== book.publisher || (publishedDate.trim() || null) !== book.publishedDate || (language.trim() || null) !== book.language;
    if (isbn.trim() && !confirmed && (bibliographyChanged || (book.status !== 'verified' && book.status !== 'confirmed'))) {
      setError('Conferma che l’ISBN corrisponde alla tua edizione, oppure lascia il campo ISBN vuoto per salvare i dati da verificare.');
      return;
    }
    try {
      const patch: Partial<BookRecord> = {
        title: title.trim(),
        authors: editedAuthors,
        isbn13: isbn.trim() || null,
        publisher: publisher.trim() || null,
        publishedDate: publishedDate.trim() || null,
        language: language.trim() || null,
        notes: notes.trim(),
        quantity: count,
      };
      if (confirmed) patch.status = 'confirmed';
      onSave(updateBook(book, patch));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Controlla i dati del libro.');
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setSearchError(null);
    setAccessRequired(false);
    setSearched(false);
    try {
      const results = await searchCatalog(query.trim(), controller.signal);
      if (!controller.signal.aborted) { setCandidates(results); setSearched(true); }
    } catch (cause) {
      if (!controller.signal.aborted) setSearchError(cause instanceof Error ? cause.message : 'Ricerca non disponibile. Riprova tra poco.');
      if (!controller.signal.aborted && typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 401) { onAccessRequired(); setAccessRequired(true); }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  function selectEdition(candidate: CatalogCandidate) {
    try {
      const updated = confirmCandidate(book, candidate);
      onSave(updated);
      onClose();
    } catch (cause) {
      setSearchError(cause instanceof Error ? cause.message : 'Non è stato possibile usare questa edizione.');
    }
  }

  return (
    <dialog ref={dialog} className="book-dialog" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="book-editor-title">
      <div className="dialog-shell">
        <header className="dialog-header">
          <div><span className="eyebrow">IL TUO CATALOGO</span><h2 id="book-editor-title">Controlla il libro</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Chiudi dettagli del libro"><X size={20} /></button>
        </header>

        <div className="editor-book-heading">
          <div className="editor-cover"><BookOpen size={26} strokeWidth={1.4} /></div>
          <div><h3>{book.title || 'Nuovo libro'}</h3><p>{book.authors.join(', ') || 'Autore da completare'}</p></div>
        </div>

        <div className="editor-tabs" role="tablist" aria-label="Dettagli del libro" onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'details' : event.key === 'End' ? 'editions' : tab === 'details' ? 'editions' : 'details';
          setTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus();
        }}>
          <button id="tab-details" type="button" role="tab" tabIndex={tab === 'details' ? 0 : -1} aria-selected={tab === 'details'} aria-controls="panel-details" onClick={() => setTab('details')}>Dati del libro</button>
          <button id="tab-editions" type="button" role="tab" tabIndex={tab === 'editions' ? 0 : -1} aria-selected={tab === 'editions'} aria-controls="panel-editions" onClick={() => setTab('editions')}>Cerca l’edizione {book.candidates.length > 0 && <span>{book.candidates.length}</span>}</button>
        </div>

        {tab === 'details' ? (
          <form className="editor-form" id="panel-details" role="tabpanel" aria-labelledby="tab-details" onSubmit={save}>
            <div className="dialog-scroll">
              {(book.observation.evidence || book.observation.visibleIsbn) && <div className="evidence-note"><BookOpen size={16} /><div><strong>Letto nella foto</strong>{book.observation.evidence && <p>{book.observation.evidence}</p>}{book.observation.visibleIsbn && <p>ISBN osservato: <strong>{book.observation.visibleIsbn}</strong></p>}{book.observation.position && <small>Posizione: {book.observation.position}</small>}</div></div>}
              <label className="field-label">Titolo<input value={title} onChange={(event) => { setTitle(event.target.value); setConfirmed(false); }} required maxLength={2000} autoComplete="off" placeholder="Titolo del libro" /></label>
              <label className="field-label">Autore<input value={authors} onChange={(event) => { setAuthors(event.target.value); setConfirmed(false); }} maxLength={2000} autoComplete="off" placeholder="Nome e cognome" /><small>Separa più autori con un punto e virgola.</small></label>
              <div className="form-grid">
                <label className="field-label">ISBN<input value={isbn} onChange={(event) => { setIsbn(event.target.value); setConfirmed(false); }} maxLength={32} inputMode="text" autoComplete="off" placeholder="ISBN-10 o ISBN-13" aria-describedby="isbn-help" /></label>
                <label className="field-label">Quantità<input value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min="1" max="9999" step="1" required /></label>
              </div>
              <p id="isbn-help" className="field-explanation">L’ISBN identifica una specifica edizione. Una copertina simile può avere un ISBN diverso.</p>
              {isbn.trim() && (
                <label className="confirmation-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Ho verificato che questo ISBN corrisponde all’edizione fotografata.</span></label>
              )}
              <div className="form-grid">
                <label className="field-label">Editore<input value={publisher} onChange={(event) => { setPublisher(event.target.value); setConfirmed(false); }} maxLength={2000} autoComplete="off" placeholder="Se disponibile" /></label>
                <label className="field-label">Data di pubblicazione<input value={publishedDate} onChange={(event) => { setPublishedDate(event.target.value); setConfirmed(false); }} maxLength={2000} autoComplete="off" placeholder="Anno o data" /></label>
              </div>
              <label className="field-label">Lingua<input value={language} onChange={(event) => { setLanguage(event.target.value); setConfirmed(false); }} maxLength={2000} autoComplete="off" placeholder="Es. it, en" /></label>
              <label className="field-label">Note<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={3} placeholder="Scaffale, condizioni o altre informazioni…" /></label>
              {book.source && book.sourceUrl && <p className="source-line">Fonte della scheda <a href={book.sourceUrl} target="_blank" rel="noreferrer noopener">{book.source}<ArrowUpRight size={13} /></a></p>}
              {error && <div ref={errorNotice} className="inline-alert error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
            </div>
            <footer className="dialog-footer"><button className="button text-button danger-text" type="button" onClick={() => { onDelete(book.id); onClose(); }}>Rimuovi libro</button><button className="button primary" type="submit"><Check size={17} />Salva modifiche</button></footer>
          </form>
        ) : (
          <section id="panel-editions" role="tabpanel" aria-labelledby="tab-editions" className="editions-panel">
            <div className="dialog-scroll">
              <div className="edition-explanation"><AlertCircle size={18} /><p>Confronta <strong>editore, anno e ISBN</strong> con la copia che hai davanti. Conferma soltanto l’edizione corretta.</p></div>
              <form className="catalog-search" onSubmit={search}>
                <label className="sr-only" htmlFor="edition-search">Cerca per titolo, autore o ISBN</label>
                <div className="search-input"><Search size={17} /><input id="edition-search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={240} placeholder="Titolo, autore o ISBN" autoComplete="off" /></div>
                <button className="button secondary" type="submit" disabled={searching || query.trim().length < 2}>{searching ? <LoaderCircle className="spin" size={18} /> : 'Cerca'}</button>
              </form>
              {searchError && <div className="inline-alert error" role="alert"><AlertCircle size={17} /><span>{searchError}</span></div>}
              {accessRequired && <button className="button secondary" type="button" onClick={onClose}>Torna al catalogo per inserire il codice</button>}
              {searching && <p className="search-status" role="status">Ricerca nei cataloghi bibliografici…</p>}
              {!searching && candidates.length === 0 && <div className="editions-empty"><Search size={29} strokeWidth={1.5} /><h3>{searched ? 'Nessuna edizione trovata' : 'Trova la tua edizione'}</h3><p>{searched ? 'Prova con il titolo completo o con l’ISBN stampato sul retro.' : 'Cerca per titolo, autore o ISBN. Puoi anche compilare i dati a mano.'}</p><button className="button text-button" type="button" onClick={() => setTab('details')}>Inserisci i dati manualmente</button></div>}
              {candidates.length > 0 && <div className="candidate-list" aria-busy={searching}>
                <p className="candidate-count">{candidates.length} {candidates.length === 1 ? 'edizione da confrontare' : 'edizioni da confrontare'}</p>
                {candidates.map((candidate) => (
                  <article className="candidate-card" key={candidate.id}>
                    <div className="candidate-top">
                      <div className="candidate-cover">{candidate.thumbnail ? <img src={candidate.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <BookOpen size={23} strokeWidth={1.4} />}</div>
                      <div><h3>{candidate.title}</h3><p>{candidate.authors.join(', ') || 'Autore non disponibile'}</p><small>{editionDetails(candidate)}</small></div>
                    </div>
                    <div className="candidate-isbn"><span>ISBN</span><strong>{candidate.isbn13 || 'Non disponibile'}</strong></div>
                    {candidate.matchReason && <p className="candidate-reason">{candidate.matchReason}</p>}
                    <footer><a href={candidate.sourceUrl} target="_blank" rel="noreferrer noopener">{candidate.source}<ArrowUpRight size={13} /></a><button className="button secondary" type="button" onClick={() => selectEdition(candidate)}><CheckCheck size={16} />{candidate.isbn13 ? 'Conferma edizione' : 'Usa questa scheda'}</button></footer>
                  </article>
                ))}
              </div>}
              <details className="edition-disclosure"><summary>Perché possono esserci più risultati?<ChevronDown size={15} /></summary><p>Ristampe, tascabili, traduzioni e formati diversi possono avere titoli simili. Jemiq conserva il riferimento della fonte e ti chiede di scegliere quando la foto non basta.</p></details>
            </div>
            <footer className="dialog-footer"><button className="button text-button" type="button" onClick={() => setTab('details')}>Modifica i dati a mano</button><button className="button secondary" type="button" onClick={onClose}><X size={16} />Chiudi</button></footer>
          </section>
        )}
      </div>
    </dialog>
  );
}
