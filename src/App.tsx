import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Camera, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Columns3, Download, FileSpreadsheet, FileText, History, ImagePlus, LayoutGrid, LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw, RotateCw, ScanLine, Search, ShieldCheck, Sparkles, Square, Trash2, Upload, X } from 'lucide-react';
import type { BookRecord, HealthStatus, PreparedImage, ScanEvent, ScanSession } from '../shared/types';
import { getHealth, hasAccessToken, scanImage, setAccessToken } from './lib/api';
import { prepareImage, rotateImage } from './lib/image';
import { loadSessions, saveSession, deleteSession } from './lib/storage';
import { exportCsv, exportXlsx } from './lib/export';
import { createManualBook, findDuplicates, updateBook } from './lib/books';
import { createDemoSession } from './lib/demo';
import BookEditor from './components/BookEditor';
import Studio from './components/Studio';
import './styles.css';

const STATUS_TEXT: Record<BookRecord['status'], string> = {
  verified: 'ISBN riscontrato', confirmed: 'Confermato da te', review: 'Da verificare', unresolved: 'Da completare',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Si è verificato un problema. Riprova.';
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

function newSession(mode: 'shelf' | 'table', image: string | null): ScanSession {
  const now = new Date().toISOString();
  const date = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long' }).format(new Date());
  return { id: crypto.randomUUID(), name: `Catalogo del ${date}`, createdAt: now, updatedAt: now, mode, image, books: [], warnings: [], isDemo: false };
}

function ready(book: BookRecord): boolean { return book.status === 'verified' || book.status === 'confirmed'; }

function Logo({ compact = false }: { compact?: boolean }) {
  return <span className={`brand${compact ? ' brand-compact' : ''}`}><img src="/logo.svg" alt="Jemiq" width="152" height="54" /></span>;
}

function ShelfIllustration() {
  return <div className="shelf-illustration" aria-hidden="true"><div className="illustration-halo"/><div className="focus-corner tl"/><div className="focus-corner tr"/><div className="focus-corner bl"/><div className="focus-corner br"/><div className="illustrated-books"><span className="illustrated-book book-1"><i/><b/></span><span className="illustrated-book book-2"><i/><b/></span><span className="illustrated-book book-3"><i/><b/></span><span className="illustrated-book book-4"><i/><b/></span><span className="illustrated-book book-5"><i/><b/></span><span className="illustrated-book book-6"><i/><b/></span></div><div className="illustration-shelf"/><div className="illustration-cursor"><ScanLine size={17}/></div></div>;
}

function StatusBadge({ book }: { book: BookRecord }) {
  return <span className={`status-badge status-${book.status}`}>{ready(book) ? <Check size={11} strokeWidth={2.5}/> : <span className="status-dot"/>}{STATUS_TEXT[book.status]}</span>;
}

function BookCover({ book }: { book: BookRecord }) {
  return <div className={`book-cover cover-${book.title.length % 5}`}>{book.thumbnail ? <img src={book.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = 'none'; }}/> : <BookOpen size={19} strokeWidth={1.4}/>}</div>;
}

function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(true);
  const [accessCode, setAccessCode] = useState('');
  const [accessProvided, setAccessProvided] = useState(hasAccessToken);
  const [view, setView] = useState<'scan' | 'history' | 'studio'>('scan');
  const [studioVisited, setStudioVisited] = useState(false);
  const [studioLaunch, setStudioLaunch] = useState<{ book: BookRecord; key: string } | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const accessDialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'shelf' | 'table'>('shelf');
  const [prepared, setPrepared] = useState<PreparedImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [current, setCurrent] = useState<ScanSession | null>(null);
  const [sessions, setSessions] = useState<ScanSession[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [scanning, setScanning] = useState(false);
  const [stage, setStage] = useState('');
  const [total, setTotal] = useState<number | null>(null);
  const [completed, setCompleted] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'review' | 'ready'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [manualDraft, setManualDraft] = useState<BookRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const photoDialog = useRef<HTMLDialogElement>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const allCheckbox = useRef<HTMLInputElement>(null);
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const scanLock = useRef(false);
  const pendingSaves = useRef(0);
  const historyDeleted = useRef(new Set<string>());
  const fileGeneration = useRef(0);

  function openStudio(book?: BookRecord) {
    if (book) setStudioLaunch({ book, key: crypto.randomUUID() });
    setStudioVisited(true); setView('studio'); setEditingId(null); setManualDraft(null);
  }

  useEffect(() => {
    if (accessOpen) accessDialog.current?.showModal(); else accessDialog.current?.close();
  }, [accessOpen]);

  async function refreshHealth() {
    setCheckingHealth(true);
    setHealthError(null);
    try { setHealth(await getHealth()); }
    catch (cause) { setHealthError(errorMessage(cause)); setHealth(null); }
    finally { setCheckingHealth(false); }
  }

  useEffect(() => {
    void refreshHealth();
    let mounted = true;
    loadSessions().then((loaded) => { if (mounted) setSessions((existing) => { const activeIds = new Set(existing.map((session) => session.id)); return [...existing, ...loaded.filter((session) => !activeIds.has(session.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }); }).catch((cause) => { if (mounted) setStorageError(errorMessage(cause)); }).finally(() => { if (mounted) setHistoryReady(true); });
    return () => { mounted = false; controllerRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!current || historyDeleted.current.has(current.id)) return;
    setSessions((previous) => [current, ...previous.filter((session) => session.id !== current.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    setSaveState('saving');
    const snapshot = current;
    pendingSaves.current += 1;
    void Promise.resolve().then(() => saveSession(snapshot)).then(() => {
      pendingSaves.current -= 1;
      if (pendingSaves.current === 0) { setSaveState('saved'); setStorageError(null); }
    }).catch((cause) => {
      pendingSaves.current -= 1;
      setSaveState('error'); setStorageError(errorMessage(cause));
    });
  }, [current]);

  useEffect(() => {
    const warnOnExit = (event: BeforeUnloadEvent) => {
      if (scanLock.current || pendingSaves.current > 0) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warnOnExit);
    return () => window.removeEventListener('beforeunload', warnOnExit);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view, current?.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (photoOpen) photoDialog.current?.showModal(); else photoDialog.current?.close();
  }, [photoOpen]);

  useEffect(() => {
    if (helpOpen) helpDialog.current?.showModal(); else helpDialog.current?.close();
  }, [helpOpen]);

  const books = current?.books || [];
  const selectedCount = books.filter((book) => book.selected).length;
  const reviewCount = books.filter((book) => !ready(book)).length;
  const readyCount = books.length - reviewCount;
  const duplicates = useMemo(() => findDuplicates(books), [books]);
  const visibleBooks = useMemo(() => books.filter((book) => {
    if (filter === 'review' && ready(book)) return false;
    if (filter === 'ready' && !ready(book)) return false;
    const needle = query.trim().toLocaleLowerCase('it-IT');
    return !needle || [book.title, ...book.authors, book.isbn13 || '', book.publisher || ''].join(' ').toLocaleLowerCase('it-IT').includes(needle);
  }), [books, query, filter]);
  const allVisibleSelected = visibleBooks.length > 0 && visibleBooks.every((book) => book.selected);
  const editingBook = books.find((book) => book.id === editingId) || (manualDraft?.id === editingId ? manualDraft : null);
  const canAnalyze = !!prepared && !scanning && !preparing && !!health?.recognitionReady && (!health.accessRequired || accessProvided);
  const hasResults = current !== null;
  const imageUrl = current?.image || prepared?.dataUrl || null;

  useEffect(() => {
    if (allCheckbox.current) allCheckbox.current.indeterminate = !allVisibleSelected && visibleBooks.some((book) => book.selected);
  }, [allVisibleSelected, visibleBooks]);

  function changeCurrent(transform: (session: ScanSession) => ScanSession) {
    setCurrent((previous) => previous ? { ...transform(previous), updatedAt: new Date().toISOString() } : previous);
  }

  function changeBook(bookId: string, patch: Partial<BookRecord>) {
    changeCurrent((session) => ({ ...session, books: session.books.map((book) => book.id === bookId ? updateBook(book, patch) : book) }));
  }

  function reset() {
    if (scanLock.current) return;
    fileGeneration.current += 1;
    setPrepared(null); setPreparing(false); setCurrent(null); setImageError(null); setScanError(null); setStopped(false); setElapsed(null); setQuery(''); setFilter('all'); setFileName(''); setView('scan'); setPhotoOpen(false); setSaveState('idle'); setEditingId(null); setManualDraft(null);
    if (cameraInput.current) cameraInput.current.value = '';
    if (uploadInput.current) uploadInput.current.value = '';
  }

  async function receiveFile(file: File) {
    if (scanLock.current) return;
    const generation = ++fileGeneration.current;
    setPreparing(true); setImageError(null); setScanError(null); setStopped(false); setElapsed(null);
    try {
      const image = await prepareImage(file);
      if (generation !== fileGeneration.current) return;
      setPrepared(image); setCurrent(null); setFileName(file.name); setQuery(''); setFilter('all'); setView('scan');
    } catch (cause) { if (generation === fileGeneration.current) setImageError(errorMessage(cause)); }
    finally { if (generation === fileGeneration.current) setPreparing(false); }
  }

  function fileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void receiveFile(file);
    event.target.value = '';
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); setDragOver(false);
    if (event.dataTransfer.files.length > 1) { setImageError('Scegli una foto alla volta. Ogni foto diventa un catalogo.'); return; }
    const file = event.dataTransfer.files[0];
    if (file) void receiveFile(file);
  }

  async function rotate() {
    if (!prepared || preparing) return;
    const generation = ++fileGeneration.current;
    setPreparing(true); setImageError(null);
    try { const image = await rotateImage(prepared); if (generation === fileGeneration.current) setPrepared(image); }
    catch (cause) { if (generation === fileGeneration.current) setImageError(errorMessage(cause)); }
    finally { if (generation === fileGeneration.current) setPreparing(false); }
  }

  async function startScan() {
    if (!canAnalyze || !prepared || scanLock.current) return;
    scanLock.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const session = newSession(mode, prepared.dataUrl);
    setCurrent(session); setScanning(true); setScanError(null); setStopped(false); setTotal(null); setCompleted(0); setElapsed(null); setStage('Lettura dei titoli nella foto…'); setQuery(''); setFilter('all');
    let eventError = false;
    const onEvent = (event: ScanEvent) => {
      if (controller.signal.aborted) return;
      if (event.type === 'stage') setStage(event.message);
      if (event.type === 'observations') {
        setTotal(event.total);
        setCurrent((previous) => previous?.id === session.id ? { ...previous, warnings: event.warnings, updatedAt: new Date().toISOString() } : previous);
      }
      if (event.type === 'book') {
        setCompleted(event.completed); setTotal(event.total);
        setCurrent((previous) => previous?.id === session.id ? { ...previous, books: [...previous.books.filter((book) => book.id !== event.book.id), event.book], updatedAt: new Date().toISOString() } : previous);
      }
      if (event.type === 'done') {
        setElapsed(event.elapsedMs);
        setCurrent((previous) => previous?.id === session.id ? { ...previous, warnings: [...new Set([...previous.warnings, ...event.warnings])], updatedAt: new Date().toISOString() } : previous);
      }
      if (event.type === 'error') { eventError = true; setScanError(event.error); }
    };
    try {
      await scanImage(prepared, mode, onEvent, controller.signal);
      if (!controller.signal.aborted && !eventError) setStage('Analisi completata');
    } catch (cause) {
      if (controller.signal.aborted) { setStopped(true); setStage('Analisi interrotta'); }
      else {
        setScanError(errorMessage(cause));
        setCurrent((previous) => previous?.id === session.id ? { ...previous, warnings: [...new Set([...previous.warnings, `Analisi interrotta: ${errorMessage(cause)}`])], updatedAt: new Date().toISOString() } : previous);
        if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 401) { setAccessProvided(false); setAccessToken(''); }
      }
    } finally { setScanning(false); scanLock.current = false; if (controllerRef.current === controller) controllerRef.current = null; }
  }

  function stopScan() {
    controllerRef.current?.abort(); setStopped(true); setStage('Analisi interrotta');
    changeCurrent((session) => ({ ...session, warnings: [...new Set([...session.warnings, 'Analisi interrotta: il catalogo contiene soltanto i risultati già ricevuti.'])] }));
  }

  function useDemo() {
    if (scanLock.current) return;
    fileGeneration.current += 1; setPreparing(false);
    setCurrent(createDemoSession()); setPrepared(null); setView('scan'); setScanError(null); setImageError(null); setStopped(false); setElapsed(null); setQuery(''); setFilter('all'); setStage('Esempio dimostrativo');
  }

  function manualBook() {
    fileGeneration.current += 1; setPreparing(false);
    const book = createManualBook();
    if (!current) setCurrent(newSession(mode, prepared?.dataUrl || null));
    setManualDraft(book); setEditingId(book.id); setView('scan');
  }

  function openSession(session: ScanSession) {
    if (scanLock.current) return;
    fileGeneration.current += 1; setPreparing(false);
    setCurrent(session); setMode(session.mode); setPrepared(null); setView('scan'); setQuery(''); setFilter('all'); setStopped(session.warnings.some((warning) => warning.startsWith('Analisi interrotta:'))); setScanError(null); setImageError(null); setElapsed(null); setStage('');
  }

  async function removeSession(session: ScanSession) {
    if (scanning && current?.id === session.id) return;
    historyDeleted.current.add(session.id);
    try {
      await deleteSession(session.id);
      setSessions((previous) => previous.filter((item) => item.id !== session.id));
      if (current?.id === session.id) reset();
      setToast('Catalogo eliminato dalla cronologia.');
    } catch (cause) { historyDeleted.current.delete(session.id); setStorageError(errorMessage(cause)); }
  }

  async function download(format: 'csv' | 'xlsx') {
    if (!current || !selectedCount || exporting) return;
    if (exportMenu.current) exportMenu.current.open = false;
    setExporting(true); setExportError(null);
    try {
      const selection = { ...current, books: current.books.filter((book) => book.selected) };
      if (format === 'csv') exportCsv(selection); else await exportXlsx(selection);
      setToast(`${selectedCount} ${selectedCount === 1 ? 'libro esportato' : 'libri esportati'} in ${format === 'csv' ? 'CSV' : 'Excel'}.`);
    } catch (cause) { setExportError(errorMessage(cause)); }
    finally { setExporting(false); }
  }

  function accessSubmit(event: FormEvent) { event.preventDefault(); if (!accessCode.trim()) return; setAccessToken(accessCode.trim()); setAccessProvided(true); setAccessCode(''); setScanError(null); setAccessOpen(false); }

  function accessPanel() {
    if (!health?.accessRequired || accessProvided) return null;
    return <form className="access-panel" onSubmit={accessSubmit}><div><LockKeyhole size={17}/><strong>Accesso alla scansione</strong></div><p>Inserisci il codice condiviso dal gestore di Jemiq.</p><div className="access-fields"><label className="sr-only" htmlFor="access-code">Codice di accesso</label><input id="access-code" type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="Codice di accesso" autoComplete="off"/><button className="button secondary" type="submit" disabled={!accessCode.trim()}>Continua<ArrowRight size={15}/></button></div></form>;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Vai al contenuto</a>
      <aside className="sidebar">
        <button className="brand-link" onClick={reset} disabled={scanning} aria-label="Jemiq, nuova scansione"><Logo/><span className="brand-tagline">RICONOSCIMENTO E VERIFICA</span></button>
        <div className="sidebar-workspace"><span className="workspace-avatar"><BookOpen size={17}/></span><div><strong>Il tuo spazio</strong><span>Cataloghi personali</span></div><span className="workspace-dot" aria-label="Salvataggio locale"/></div>
        <nav className="main-navigation" aria-label="Navigazione principale">
          <button className={`nav-item ${view === 'scan' ? 'active' : ''}`} onClick={() => setView('scan')}><ScanLine size={18}/><span>Scansiona libri</span>{view === 'scan' && <span className="nav-active-dot"/>}</button>
          <button className={`nav-item ${view === 'studio' ? 'active' : ''}`} onClick={() => openStudio()}><ImagePlus size={20}/><span>Studio</span>{view === 'studio' && <span className="nav-active-dot"/>}</button>
          <button className={`nav-item ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}><History size={18}/><span>I tuoi cataloghi</span><span className="nav-count">{sessions.length}</span></button>
        </nav>
        <div className="sidebar-recents">
          <div className="sidebar-section-heading"><span>RECENTI</span><button className="icon-button" onClick={reset} disabled={scanning} aria-label="Nuovo catalogo"><Plus size={15}/></button></div>
          {sessions.length ? sessions.slice(0, 4).map((session) => <button key={session.id} className={`recent-link ${current?.id === session.id && view === 'scan' ? 'is-current' : ''}`} onClick={() => openSession(session)} disabled={scanning}><FileText size={15}/><span>{session.name}</span>{session.isDemo && <small>demo</small>}</button>) : <p className="sidebar-empty">Le tue scansioni appariranno qui.</p>}
        </div>
        <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={18}/><div><strong>Salvato sul tuo dispositivo</strong><p>Il catalogo resta in questo browser. Esportalo per conservarlo.</p></div></div><button className="nav-item help-link" onClick={() => setHelpOpen(true)}><CircleHelp size={18}/>Una mano con Jemiq<ArrowUpRight size={14}/></button><span className="sidebar-version">Fotografa. Controlla. Esporta.</span></div>
      </aside>

      <div className="main-shell">
        <header className="topbar"><div className="mobile-brand"><Logo compact/></div><div className="breadcrumb"><span>Il tuo spazio</span><span className="breadcrumb-slash">/</span><strong>{view === 'studio' ? 'Studio' : view === 'history' ? 'I tuoi cataloghi' : current ? 'Il tuo catalogo' : 'Nuova scansione'}</strong></div><div className="topbar-right"><span className="private-label"><span/>Senza account</span><button className="icon-button mobile-help" onClick={() => setHelpOpen(true)} aria-label="Guida a Jemiq"><CircleHelp size={20}/></button><span className="profile-mark" aria-hidden="true"><img src="/favicon.svg" alt="" width="28" height="28"/></span></div></header>
        <nav className="mobile-navigation" aria-label="Sezioni"><button className={view === 'scan' ? 'active' : ''} onClick={() => setView('scan')}><ScanLine size={16}/>Scansiona</button><button className={view === 'studio' ? 'active' : ''} onClick={() => openStudio()}><ImagePlus size={20}/>Studio</button><button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><History size={16}/>Cataloghi<span>{sessions.length}</span></button></nav>

        <main id="main-content" className={`main-content ${hasResults && view === 'scan' ? 'has-results' : ''} ${view === 'studio' ? 'studio-main' : ''}`}>
          {storageError && <div className="inline-alert warning storage-alert" role="alert"><AlertCircle size={18}/><span>{storageError}</span><button className="icon-button" onClick={() => setStorageError(null)} aria-label="Chiudi avviso"><X size={15}/></button></div>}

          {studioVisited && <div hidden={view !== 'studio'}><Studio launch={studioLaunch} health={health} accessProvided={accessProvided} onRequestAccess={() => setAccessOpen(true)} onAccessRequired={() => { setAccessToken(''); setAccessProvided(false); setAccessOpen(true); }} /></div>}
          {view === 'studio' ? null : view === 'history' ? (
            <>
              <div className="page-heading"><div><div className="eyebrow"><span/>LA TUA RACCOLTA</div><h1>I tuoi cataloghi<span className="accent-period">.</span></h1><p>Ritrova le scansioni, completa i dati e riparti da dove eri.</p></div><button className="button primary" onClick={reset} disabled={scanning}><Plus size={17}/>Nuova scansione</button></div>
              {scanning && <button className="scan-in-background" onClick={() => setView('scan')}><LoaderCircle size={17} className="spin"/>Scansione in corso. {completed > 0 && `${completed} libri pronti.`}<span>Torna alla scansione<ArrowRight size={15}/></span></button>}
              {!historyReady ? <div className="history-empty" role="status"><LoaderCircle size={26} className="spin"/><p>Caricamento dei cataloghi…</p></div> : !sessions.length ? <div className="history-empty"><span className="empty-state-icon"><History size={30} strokeWidth={1.4}/></span><h2>La tua prossima raccolta inizia qui</h2><p>Fotografa i libri o inserisci il primo a mano.<br/>Ogni catalogo viene salvato automaticamente.</p><button className="button primary" onClick={reset}><Camera size={18}/>Crea il primo catalogo</button></div> : <div className="history-grid">{sessions.map((session) => <article className="history-card" key={session.id}><button className="history-card-main" onClick={() => openSession(session)} disabled={scanning}><div className={`history-image ${!session.image ? 'history-image-empty' : ''}`}>{session.image ? <img src={session.image} alt=""/> : <><BookOpen size={42} strokeWidth={1.1}/><span>{session.isDemo ? 'UN CATALOGO DI ESEMPIO' : 'IL TUO CATALOGO'}</span></>}{session.isDemo && <span className="demo-chip">Demo</span>}<span className="history-open"><ArrowUpRight size={20}/></span></div><div className="history-card-title"><h2>{session.name}</h2><p>{session.books.length} libri<span>·</span>{session.books.filter((book) => !ready(book)).length} da verificare</p></div></button><footer><span><Clock3 size={13}/>{formatDate(session.updatedAt)}</span><button className="icon-button" type="button" onClick={() => { void removeSession(session); }} disabled={scanning && current?.id === session.id} aria-label={`Elimina catalogo ${session.name}`}><Trash2 size={15}/></button></footer></article>)}</div>}
              <p className="history-footnote"><ShieldCheck size={15}/>Questi cataloghi sono memorizzati nel browser che stai usando. Esporta una copia prima di cancellare i dati di navigazione.</p>
            </>
          ) : (
            <>
              <div className="page-heading"><div><div className="eyebrow"><span/>{hasResults ? 'DALLA FOTO AL CATALOGO' : 'ACQUISIZIONE'}</div><h1>{hasResults ? 'Il tuo catalogo' : 'Dalla foto ai dati dei tuoi libri'}<span className="accent-period">.</span></h1><p>{hasResults ? 'Controlla l’edizione, completa i dettagli. Poi esporta.' : 'Fotografa. Controlla. Esporta.'}</p></div>{hasResults ? <button className="button secondary new-scan-button" onClick={reset} disabled={scanning}><Plus size={17}/>Nuova scansione</button> : <div className="workflow-steps" aria-label="Tre passaggi: foto, verifica, esporta"><span className="current-step"><b>1</b>Foto</span><i/><span><b>2</b>Verifica</span><i/><span><b>3</b>Esporta</span></div>}</div>

              {!hasResults ? (
                <div className="capture-workspace">
                  <section className={`capture-card ${dragOver ? 'is-dragging' : ''}`} aria-labelledby="capture-title" onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={drop}>
                    <div className="capture-card-header"><div><span className="step-tag">01</span><h2 id="capture-title">Parti da una foto</h2></div><span className="image-formats">JPG, PNG, WEBP</span></div>
                    <div className="capture-mode"><span>Cosa stai fotografando?</span><div className="segmented-control" role="group" aria-label="Tipo di foto"><button type="button" aria-pressed={mode === 'shelf'} className={mode === 'shelf' ? 'selected' : ''} onClick={() => setMode('shelf')}><Columns3 size={16}/>Scaffale</button><button type="button" aria-pressed={mode === 'table'} className={mode === 'table' ? 'selected' : ''} onClick={() => setMode('table')}><LayoutGrid size={16}/>Tavolo</button></div></div>

                    {prepared ? <div className="photo-preview"><img src={prepared.dataUrl} alt="Foto dei libri da analizzare"/><span className="photo-dimensions">{prepared.width} × {prepared.height}</span><div className="photo-actions"><button className="photo-tool" onClick={() => { void rotate(); }} disabled={preparing} aria-label="Ruota foto di 90 gradi"><RotateCw size={16}/>Ruota</button><button className="photo-tool" onClick={() => uploadInput.current?.click()} disabled={preparing}><ImagePlus size={16}/>Cambia foto</button></div>{preparing && <div className="preview-loading" role="status"><LoaderCircle size={26} className="spin"/><span>Preparo la foto…</span></div>}</div> : <div className={`capture-dropzone ${preparing ? 'preparing' : ''}`}><ShelfIllustration/>{preparing ? <><LoaderCircle size={26} className="spin"/><h3>Preparo la tua foto…</h3><p>Un momento e siamo pronti.</p></> : <><h3>Fotografa i tuoi libri</h3><p>Inquadra i dorsi o le copertine,<br/>con i titoli ben leggibili.</p><div className="capture-buttons"><button className="button primary camera-button" type="button" onClick={() => cameraInput.current?.click()}><Camera size={18}/>Scatta una foto</button><button className="button secondary" type="button" onClick={() => uploadInput.current?.click()}><Upload size={17}/>Carica foto</button></div><span className="drop-hint">oppure trascina qui un’immagine</span></>}</div>}

                    {imageError && <div className="inline-alert error capture-alert" role="alert"><AlertCircle size={17}/><span>{imageError}</span></div>}
                    {prepared && <div className="ready-to-scan"><div><span className="file-icon"><Check size={16}/></span><div><strong>Foto pronta</strong><span>{fileName || 'Immagine selezionata'}</span></div></div><button className="button primary" type="button" onClick={() => { void startScan(); }} disabled={!canAnalyze}>{checkingHealth ? <LoaderCircle size={17} className="spin"/> : <ScanLine size={18}/>}Riconosci i libri<ArrowRight size={16}/></button></div>}
                    {accessPanel()}
                    {!checkingHealth && (!health?.recognitionReady || healthError) && <div className="service-note"><span className="service-note-icon"><AlertCircle size={16}/></span><div><strong>{healthError ? 'Servizio momentaneamente non raggiungibile' : 'La scansione non è ancora configurata'}</strong><p>{healthError ? 'Riprova tra poco. Puoi esplorare la demo o inserire i libri a mano.' : 'Puoi già provare la demo o creare un catalogo a mano.'}</p></div><button className="icon-button" onClick={() => { void refreshHealth(); }} disabled={checkingHealth} aria-label="Ricontrolla disponibilità del servizio"><RefreshCw size={15}/></button></div>}
                    <div className="capture-footer"><ShieldCheck size={15}/><span>La foto viene inviata per l’analisi. Il catalogo resta in questo browser.</span></div>
                  </section>

                  <aside className="guidance-column">
                    <section className="how-it-works"><span className="eyebrow">DALL’IMMAGINE AL FOGLIO</span><h2>Dallo scatto<br/>al file di lavoro.</h2><ol><li><span className="guide-step-icon"><ScanLine size={19}/></span><div><h3>Fotografa i tuoi libri</h3><p>Dorsi sullo scaffale o copertine sul tavolo, anche più libri insieme.</p></div></li><li><span className="guide-step-icon"><CheckCircle2 size={19}/></span><div><h3>Controlla il risultato</h3><p>Titolo, autore e possibili edizioni. Se un ISBN è incerto, te lo segnaliamo.</p></div></li><li><span className="guide-step-icon"><ArrowDownToLine size={19}/></span><div><h3>Portalo dove vuoi</h3><p>Esporta in Excel o CSV, con quantità, fonti e stato di verifica.</p></div></li></ol></section>
                    <section className="demo-card"><div className="demo-card-top"><span className="demo-symbol"><Sparkles size={20} strokeWidth={1.5}/></span><span className="sample-label">SENZA CARICARE FOTO</span></div><h3>Esplora un esempio</h3><p>Esplora un catalogo di esempio e prova modifica ed esportazione.</p><button className="demo-button" onClick={useDemo}>Apri la demo<ArrowRight size={17}/></button></section>
                    <button className="manual-entry-button" onClick={manualBook}><Plus size={16}/>Oppure inserisci un libro a mano<ArrowUpRight size={14}/></button>
                  </aside>
                </div>
              ) : (
                <>
                  {current.isDemo && <div className="demo-banner"><span><Sparkles size={17}/><strong>Stai esplorando una demo</strong><span>Dati di esempio, liberamente modificabili.</span></span><button onClick={reset} disabled={scanning}>Prova con i tuoi libri<ArrowRight size={15}/></button></div>}
                  <section className={`scan-summary ${scanning ? 'is-scanning' : ''}`} aria-label="Riepilogo della scansione"><button className={`summary-image ${!imageUrl ? 'summary-image-empty' : ''}`} onClick={() => { if (imageUrl) setPhotoOpen(true); }} disabled={!imageUrl} aria-label="Ingrandisci la foto analizzata">{imageUrl ? <img src={imageUrl} alt="Foto della scansione"/> : <BookOpen size={27} strokeWidth={1.3}/>} {imageUrl && <span><Search size={13}/></span>}</button><div className="scan-summary-content"><div className="session-name-row"><label className="sr-only" htmlFor="session-name">Nome del catalogo</label><input id="session-name" className="session-name" value={current.name} onChange={(event) => changeCurrent((session) => ({ ...session, name: event.target.value }))} onBlur={() => { if (!current.name.trim()) changeCurrent((session) => ({ ...session, name: 'Il mio catalogo' })); }} maxLength={100} aria-label="Nome del catalogo"/><Pencil size={13}/></div><div className="summary-meta"><span>{current.isDemo ? 'Catalogo dimostrativo' : current.image ? current.mode === 'shelf' ? 'Scaffale' : 'Tavolo' : 'Inserimento manuale'}</span><span>·</span><span>{formatDate(current.createdAt)}</span>{elapsed !== null && !scanning && <><span>·</span><span>{Math.max(1, Math.round(elapsed / 1000))} s</span></>}</div><div className={`scan-status ${scanning ? 'scanning' : stopped || scanError ? 'interrupted' : ''}`} role="status">{scanning ? <><LoaderCircle size={14} className="spin"/><span>{stage}</span>{total !== null && total > 0 && <strong>{completed}/{total}</strong>}</> : stopped ? <><Square size={12}/><span>Interrotta · i risultati ricevuti sono conservati</span></> : scanError ? <><AlertCircle size={14}/><span>Analisi da completare</span></> : <><CheckCircle2 size={14}/><span>{current.isDemo ? 'Pronto da esplorare' : current.image ? 'Risultati disponibili' : 'Pronto da compilare'}</span></>}</div></div><div className="summary-actions">{scanning ? <button className="button secondary" onClick={stopScan}><Square size={13}/>Interrompi</button> : (scanError || stopped) && prepared ? <button className="button secondary" onClick={() => { void startScan(); }} disabled={!canAnalyze}><RefreshCw size={15}/>Riprova</button> : <span className={`autosave-status ${saveState === 'error' ? 'save-error' : ''}`}>{saveState === 'saving' ? <LoaderCircle size={13} className="spin"/> : saveState === 'error' ? <AlertCircle size={13}/> : <Check size={14}/>}<span>{saveState === 'saving' ? 'Salvataggio…' : saveState === 'error' ? 'Non salvato' : 'Salvato in locale'}</span></span>}</div>{scanning && <div className="scan-activity-bar"/>}</section>
                  {scanError && <div className="inline-alert error scan-error" role="alert"><AlertCircle size={18}/><div><strong>La scansione non è stata completata</strong><p>{scanError}</p>{books.length > 0 && <p>I {books.length} libri già ricevuti sono disponibili qui sotto.</p>}</div></div>}
                  {accessPanel()}
                  {current.warnings.length > 0 && <details className="scan-warnings"><summary><AlertCircle size={16}/>Note sulla lettura della foto<span>{current.warnings.length}</span><ChevronDown size={15}/></summary><ul>{current.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}

                  <section className="results-card" aria-labelledby="results-title" aria-busy={scanning}>
                    <div className="results-heading"><div><span className="step-tag">02</span><h2 id="results-title">{current.image || current.isDemo ? 'I libri riconosciuti' : 'I tuoi libri'}</h2><span className="results-count">{books.length}</span>{scanning && <LoaderCircle size={16} className="spin scanning-inline"/>}</div><div className="results-actions"><button className="button text-button add-book-button" aria-label="Aggiungi libro" onClick={manualBook}><Plus size={16}/><span>Aggiungi libro</span></button><details className="export-menu" ref={exportMenu}><summary className={`button primary ${!selectedCount || exporting ? 'is-disabled' : ''}`} aria-disabled={!selectedCount || exporting} onClick={(event) => { if (!selectedCount || exporting) event.preventDefault(); }}>{exporting ? <LoaderCircle size={16} className="spin"/> : <Download size={16}/>}<span>Esporta</span><ChevronDown size={14}/></summary><div className="export-popover"><span>{selectedCount} {selectedCount === 1 ? 'libro selezionato' : 'libri selezionati'}</span><button onClick={() => { void download('xlsx'); }} disabled={!selectedCount || exporting}><FileSpreadsheet size={18}/><div><strong>Excel</strong><small>Cartella di lavoro .xlsx</small></div></button><button onClick={() => { void download('csv'); }} disabled={!selectedCount || exporting}><FileText size={18}/><div><strong>CSV</strong><small>Compatibile con fogli e gestionali</small></div></button></div></details></div></div>
                    {books.length > 0 && <><div className="results-toolbar"><div className="results-tabs" role="group" aria-label="Filtra per verifica"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Tutti<span>{books.length}</span></button><button className={filter === 'review' ? 'active' : ''} onClick={() => setFilter('review')}>Da verificare<span className={reviewCount ? 'review-tab-count' : ''}>{reviewCount}</span></button><button className={filter === 'ready' ? 'active' : ''} onClick={() => setFilter('ready')}>Confermati<span>{readyCount}</span></button></div><div className="search-input results-search"><Search size={16}/><label className="sr-only" htmlFor="book-search">Cerca nel catalogo</label><input id="book-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca titolo, autore, ISBN…"/>{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="Cancella ricerca"><X size={14}/></button>}</div></div>
                      {visibleBooks.length > 0 ? <div className="books-table-wrap"><table className="books-table"><thead><tr><th className="select-column"><input ref={allCheckbox} type="checkbox" checked={allVisibleSelected} onChange={(event) => { const selected = event.target.checked; const ids = new Set(visibleBooks.map((book) => book.id)); changeCurrent((session) => ({ ...session, books: session.books.map((book) => ids.has(book.id) ? { ...book, selected } : book) })); }} aria-label="Seleziona tutti i libri visibili"/></th><th>LIBRO</th><th className="isbn-column">ISBN / EDIZIONE</th><th className="status-column">STATO</th><th className="quantity-column">QTÀ</th><th className="edit-column"><span className="sr-only">Azioni</span></th></tr></thead><tbody>{visibleBooks.map((book) => <tr key={book.id} className={!book.selected ? 'unselected-row' : ''}><td className="select-column"><input type="checkbox" checked={book.selected} onChange={(event) => changeBook(book.id, { selected: event.target.checked })} aria-label={`Seleziona ${book.title || 'libro senza titolo'}`}/></td><td><button className="book-title-button" onClick={() => setEditingId(book.id)}><BookCover book={book}/><span className="book-text"><strong>{book.title || 'Titolo da completare'}</strong><span>{book.authors.join(', ') || 'Autore da completare'}</span><span className="mobile-book-isbn">{book.isbn13 || 'ISBN da verificare'}</span>{book.source && <span className="mobile-book-source">Fonte: {book.source}</span>}<span className="mobile-book-status"><StatusBadge book={book}/></span>{duplicates.has(book.id) && <small className="duplicate-tag">Possibile duplicato</small>}</span></button></td><td className="isbn-column"><div className="book-isbn">{book.isbn13 ? <span className={ready(book) ? 'isbn-number' : 'isbn-number unconfirmed-isbn'}>{book.isbn13}</span> : <button className="isbn-pending" onClick={() => setEditingId(book.id)}><span/>ISBN da verificare</button>}{book.publisher && <span className="publisher-line">{book.publisher}{book.publishedDate ? ` · ${book.publishedDate.slice(0, 4)}` : ''}</span>}{book.source && book.sourceUrl && <a className="book-source" href={book.sourceUrl} target="_blank" rel="noreferrer noopener">{book.source}<ArrowUpRight size={11}/></a>}</div></td><td className="status-column"><StatusBadge book={book}/></td><td className="quantity-column"><input className="quantity-input" onFocus={(event) => event.currentTarget.select()} type="number" min="1" max="9999" step="1" value={book.quantity} aria-label={`Quantità di ${book.title || 'libro senza titolo'}`} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 9999) changeBook(book.id, { quantity: value }); }}/></td><td className="edit-column"><button className="icon-button edit-book" onClick={() => setEditingId(book.id)} aria-label={`Modifica ${book.title || 'libro senza titolo'}`}><Pencil size={16}/></button></td></tr>)}</tbody></table></div> : <div className="filtered-empty"><Search size={26}/><h3>Nessun libro corrisponde</h3><p>Prova un’altra ricerca o cambia filtro.</p><button className="button text-button" onClick={() => { setQuery(''); setFilter('all'); }}>Mostra tutti i libri</button></div>}
                      <div className="results-footer"><span><strong>{selectedCount}</strong> di {books.length} selezionati per l’esportazione</span><span className="quantity-note">Quantità iniziale: 1 per riga. Controlla le copie.</span></div></>}
                    {books.length === 0 && <div className={`results-empty ${scanning ? 'is-loading' : ''}`}>{scanning ? <><div className="scan-loader"><ScanLine size={32} strokeWidth={1.4}/></div><h3>{total === null ? 'Leggiamo la foto.' : 'Cerchiamo le edizioni.'}</h3><p>{total !== null && total > 0 ? `${total} ${total === 1 ? 'libro individuato' : 'libri individuati'}. I risultati appariranno uno alla volta.` : 'I risultati compariranno qui, appena disponibili.'}</p><span className="loading-subtext">Puoi interrompere in qualsiasi momento.</span></> : <><span className="empty-state-icon"><BookOpen size={29} strokeWidth={1.4}/></span><h3>{scanError ? 'Puoi ripartire da qui' : stopped ? 'Nessun risultato ricevuto' : current.image ? 'Non abbiamo trovato titoli leggibili' : 'Il primo libro lo scegli tu'}</h3><p>{current.image ? 'Prova una foto più vicina, con meno libri e titoli ben visibili, oppure aggiungili a mano.' : 'Inserisci un titolo o cerca l’edizione con il suo ISBN.'}</p><div><button className="button secondary" onClick={manualBook}><Plus size={16}/>Aggiungi un libro</button>{current.image && <button className="button text-button" onClick={reset}>Scegli un’altra foto<ArrowRight size={15}/></button>}</div></>}</div>}
                    {exportError && <div className="inline-alert error export-error" role="alert"><AlertCircle size={17}/><span>{exportError}</span></div>}
                  </section>
                  {books.length > 0 && <div className="verification-note"><span className="verification-icon"><ShieldCheck size={20} strokeWidth={1.5}/></span><div><strong>Un titolo riconosciuto non basta a confermare l’ISBN.</strong><p>Apri i libri da verificare e confronta l’edizione con la tua copia. Nell’esportazione trovi anche stato e fonte.</p></div>{reviewCount > 0 && <button onClick={() => { setFilter('review'); setQuery(''); setEditingId(books.find((book) => !ready(book))?.id || null); }}>Verifica il prossimo<ArrowRight size={15}/></button>}</div>}
                </>
              )}

              {!hasResults && <div className="bottom-notes"><span><CheckCircle2 size={15}/>ISBN e fonti sempre distinguibili</span><i/><span><FileSpreadsheet size={15}/>Excel e CSV pronti da usare</span><i/><span><History size={15}/>Riprendi quando vuoi</span></div>}
            </>
          )}
        </main>
        <footer className="app-footer"><span>jemiq<span> · </span>Foto, corrispondenze, dati.</span><button onClick={() => setHelpOpen(true)}>Come funziona<ArrowUpRight size={12}/></button></footer>
      </div>

      <input ref={cameraInput} className="sr-only" type="file" accept="image/*" capture="environment" onChange={fileChange} tabIndex={-1} aria-label="Scatta una foto ai libri"/>
      <input ref={uploadInput} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={fileChange} tabIndex={-1} aria-label="Carica una foto dei libri"/>
      {editingBook && <BookEditor key={editingBook.id} book={editingBook} onSave={(updated) => changeCurrent((session) => ({ ...session, books: session.books.some((book) => book.id === updated.id) ? session.books.map((book) => book.id === updated.id ? updated : book) : [...session.books, updated] }))} onDelete={(id) => changeCurrent((session) => ({ ...session, books: session.books.filter((book) => book.id !== id) }))} onCreateImage={() => { if (editingBook.title.trim()) openStudio(editingBook); }} onAccessRequired={() => { setAccessProvided(false); setAccessToken(''); }} onClose={() => { setEditingId(null); setManualDraft(null); }}/>}
      <dialog ref={accessDialog} className="access-dialog" aria-labelledby="access-dialog-title" onCancel={() => setAccessOpen(false)}><div className="dialog-header"><div><h2 id="access-dialog-title">Accedi a Jemiq</h2><p>Inserisci il codice condiviso dal gestore.</p></div><button className="icon-button" onClick={() => setAccessOpen(false)} aria-label="Chiudi accesso"><X size={20}/></button></div><form onSubmit={accessSubmit}><label className="field-label">Codice di accesso<input type="password" autoComplete="off" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} required/></label><button className="button primary" type="submit" disabled={!accessCode.trim()}>Continua<ArrowRight size={20}/></button></form></dialog>
      <dialog ref={photoDialog} className="photo-dialog" onCancel={() => setPhotoOpen(false)} aria-label="Foto analizzata" onClick={(event) => { if (event.target === event.currentTarget) setPhotoOpen(false); }}><div><button className="photo-dialog-close" onClick={() => setPhotoOpen(false)} aria-label="Chiudi foto"><X size={23}/></button>{imageUrl && <img src={imageUrl} alt="Foto originale della scansione, ingrandita"/>}</div></dialog>
      <dialog ref={helpDialog} className="help-dialog" onCancel={() => setHelpOpen(false)} aria-labelledby="help-title" onClick={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><div className="help-content"><header><span className="eyebrow">BASTA UNA BUONA FOTO</span><button className="icon-button" onClick={() => setHelpOpen(false)} aria-label="Chiudi guida"><X size={20}/></button></header><h2 id="help-title">Facciamo ordine,<br/>un libro alla volta.</h2><div className="help-item"><Camera size={21}/><div><h3>Prima dello scatto</h3><p>Usa luce uniforme, evita i riflessi e tieni la fotocamera di fronte ai libri. Meglio una porzione leggibile dello scaffale che una foto troppo lontana. Su computer, “Scatta una foto” può aprire il selettore di immagini.</p></div></div><div className="help-item"><CheckCircle2 size={21}/><div><h3>Una verifica fa la differenza</h3><p>Jemiq legge i titoli e cerca nei cataloghi. Le edizioni suggerite vanno confrontate con la copia fisica. “ISBN riscontrato” indica un ISBN leggibile nella foto e coerente con il catalogo; “Confermato da te” indica una tua scelta esplicita.</p></div></div><div className="help-item"><FileSpreadsheet size={21}/><div><h3>Il file, come serve a te</h3><p>Seleziona le righe e scegli Excel o CSV. La quantità parte da 1: verifica e modifica il numero delle copie. Nell’esportazione sono incluse anche le informazioni sulla verifica e sulle fonti.</p></div></div><div className="help-item"><ShieldCheck size={21}/><div><h3>Dove finiscono i dati</h3><p>La foto viene inviata al servizio di riconoscimento; titolo e autore possono essere cercati nei cataloghi esterni. La cronologia è salvata in questo browser, senza sincronizzazione. Esporta i cataloghi per conservarne una copia.</p></div></div><button className="button primary" onClick={() => setHelpOpen(false)}>Tutto chiaro<Check size={17}/></button></div></dialog>
      {toast && <div className="toast" role="status"><CheckCircle2 size={18}/><span>{toast}</span><button className="icon-button" onClick={() => setToast(null)} aria-label="Chiudi notifica"><X size={15}/></button></div>}
    </div>
  );
}

export default App;
