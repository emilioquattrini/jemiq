import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent, PointerEvent } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Camera, Check, CheckCircle2, ChevronDown, Clapperboard, Crop, Download, History, ImagePlus, Layers, LoaderCircle, LockKeyhole, Maximize2, Minus, Plus, RefreshCw, RotateCw, ScanLine, Search, ShieldCheck, Square, Sun, Trash2, Upload, X } from 'lucide-react';
import type { BookRecord, CatalogCandidate, HealthStatus } from '../../shared/types';
import { isValidIsbn, toIsbn13 } from '../../shared/isbn';
import { DEFAULT_STUDIO_CORNERS, EMPTY_STUDIO_BOOK, STUDIO_STYLES, studioBookSchema, studioBriefSchema } from '../../shared/studio';
import type { StudioBook, StudioBrief, StudioComposition, StudioJob, StudioPoint, StudioProject, StudioQuad, StudioStyle } from '../../shared/studio';
import { scanImage, searchCatalog } from '../lib/api';
import { cancelStudioJob, createStudioBrief, getStudioJob, startStudioGeneration } from '../lib/studio-api';
import { cropStudioCover, downloadStudioImage, exportStudioImage, prepareStudioPhoto, renderStudioComposition, rotateStudioPhoto, studioPhotoToPreparedImage } from '../lib/studio-image';
import { deleteStudioProject, loadStudioProjects, saveStudioProject } from '../lib/studio-storage';
import '../studio.css';

interface StudioProps {
  launch: { book: BookRecord; key: string } | null;
  health: HealthStatus | null;
  accessProvided: boolean;
  onRequestAccess: () => void;
  onAccessRequired: () => void;
}

type StudioPhase = 'idle' | 'submitting' | 'running' | 'recovering' | 'failed' | 'cancelled' | 'completed';
const CORNER_NAMES = ['alto sinistra', 'alto destra', 'basso destra', 'basso sinistra'];
const INITIAL_ROTATION = -6;
const copyCorners = (): StudioQuad => DEFAULT_STUDIO_CORNERS.map((point) => ({ ...point })) as StudioQuad;
const errorText = (error: unknown, fallback = 'Operazione non completata. Riprova.') => error instanceof Error ? error.message : fallback;
const isAccessError = (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
const safeUrl = (url: string | null | undefined) => url && /^https?:\/\//i.test(url) ? url : undefined;
const parseAuthors = (value: string) => value.split(';').map((author) => author.trim()).filter(Boolean).slice(0, 12).map((author) => author.slice(0, 200));
const readableDate = (date: string) => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date));

function toStudioBook(book: BookRecord | CatalogCandidate): StudioBook {
  return {
    title: book.title.trim().slice(0, 400), authors: book.authors.slice(0, 12).map((author) => author.slice(0, 200)),
    isbn13: toIsbn13(book.isbn13), publisher: book.publisher?.slice(0, 240) || null,
    language: book.language?.slice(0, 30) || null, source: book.source, sourceUrl: safeUrl(book.sourceUrl) || null,
  };
}

function makeProject(book: StudioBook = { ...EMPTY_STUDIO_BOOK, authors: [] }): StudioProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), createdAt: now, updatedAt: now, photo: null, cover: null, corners: copyCorners(), book,
    style: 'atmospheric', readerNote: '', mood: '', brief: null, image: null, format: 'post', scale: 1,
    rotation: INITIAL_ROTATION, offsetX: 0, offsetY: 0, caption: '', jobId: null, requestId: null,
  };
}

function StyleIcon({ style }: { style: StudioStyle }) {
  return style === 'atmospheric' ? <Sun size={20}/> : style === 'minimal' ? <Minus size={20}/> : <Clapperboard size={20}/>;
}

export default function Studio({ launch, health, accessProvided, onRequestAccess, onAccessRequired }: StudioProps) {
  const [project, setProject] = useState<StudioProject>(() => makeProject(launch ? toStudioBook(launch.book) : undefined));
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [authorsDraft, setAuthorsDraft] = useState(project.book.authors.join('; '));
  const [cropEditing, setCropEditing] = useState(false);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionMessage, setRecognitionMessage] = useState('');
  const [recognized, setRecognized] = useState<BookRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchResults, setSearchResults] = useState<CatalogCandidate[]>([]);
  const [briefLoading, setBriefLoading] = useState(false);
  const [phase, setPhase] = useState<StudioPhase>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [exporting, setExporting] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const cropSurface = useRef<HTMLDivElement>(null);
  const previewCanvas = useRef<HTMLCanvasElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  const workController = useRef<AbortController | null>(null);
  const photoSequence = useRef(0);
  const lastLaunch = useRef(launch?.key);
  const deleted = useRef(new Set<string>());
  const saveSequence = useRef(0);
  const dragCorner = useRef<number | null>(null);
  const projectRef = useRef(project);
  const generationLock = useRef(false);
  const accessCallback = useRef(onAccessRequired);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  projectRef.current = project;
  accessCallback.current = onAccessRequired;

  const accessBlocked = !!health?.accessRequired && !accessProvided;
  const generationAvailable = !!(health as (HealthStatus & { studioReady?: boolean }) | null)?.studioReady;
  const generating = submitting || phase === 'running' || phase === 'recovering';
  const busy = preparing || cropping || recognizing || searching || briefLoading || generating || cancelling;
  const projectHasContent = !!(project.photo || project.book.title || project.image || project.requestId);

  function update(patch: Partial<StudioProject>): StudioProject {
    const previous = projectRef.current;
    const contextChanged = ['book', 'style', 'readerNote', 'mood', 'brief', 'photo', 'corners', 'cover'].some((key) => key in patch);
    const fork = contextChanged && !!(previous.image || previous.requestId);
    const now = new Date().toISOString();
    const next: StudioProject = { ...previous, ...(fork ? { id: crypto.randomUUID(), createdAt: now, image: null, requestId: null, jobId: null } : {}), ...patch, updatedAt: now };
    projectRef.current = next;
    setProject(next);
    if (fork) setPhase('idle');
    return next;
  }

  function invalidateWork() {
    photoSequence.current += 1;
    workController.current?.abort(); workController.current = null;
    setPreparing(false); setCropping(false); setRecognizing(false); setSearching(false); setBriefLoading(false); setCropEditing(false);
    setRecognized([]); setSearchResults([]); setSearched(false); setError(null); setNotice(null);
  }

  useEffect(() => {
    let active = true;
    loadStudioProjects().then((items) => { if (active) setProjects((existing) => { const ids = new Set(existing.map((item) => item.id)); return [...existing, ...items.filter((item) => !ids.has(item.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }); }).catch((cause) => { if (active) setHistoryError(errorText(cause)); }).finally(() => { if (active) setHistoryLoaded(true); });
    return () => { active = false; photoSequence.current += 1; workController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!launch || launch.key === lastLaunch.current) return;
    lastLaunch.current = launch.key;
    invalidateWork();
    setProject(makeProject(toStudioBook(launch.book))); setStep(0); setPhase('idle'); setHistoryOpen(false);
  }, [launch]);

  useEffect(() => {
    setAuthorsDraft((value) => JSON.stringify(parseAuthors(value)) === JSON.stringify(project.book.authors) ? value : project.book.authors.join('; '));
  }, [project.id, project.book.authors]);

  useEffect(() => {
    if (!projectHasContent || deleted.current.has(project.id) || cropEditing) return;
    setProjects((items) => [project, ...items.filter((item) => item.id !== project.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    const sequence = ++saveSequence.current;
    setSaveState('saving');
    void Promise.resolve().then(() => saveStudioProject(project)).then(() => { if (sequence === saveSequence.current) { setSaveState('saved'); setSaveError(null); } }).catch((cause) => { if (sequence === saveSequence.current) { setSaveState('error'); setSaveError(errorText(cause)); } });
  }, [project, projectHasContent, cropEditing]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (saveState === 'saving' || preparing || cropping || recognizing || briefLoading || cropEditing) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveState, preparing, cropping, recognizing, briefLoading, cropEditing]);

  useEffect(() => { if (error) errorNotice.current?.scrollIntoView({ block: 'nearest' }); }, [error]);

  const composition = useMemo<StudioComposition | null>(() => project.cover && project.image ? {
    cover: project.cover, background: project.image, format: project.format, scale: project.scale,
    rotation: project.rotation, offsetX: project.offsetX, offsetY: project.offsetY, caption: project.caption,
  } : null, [project.cover, project.image, project.format, project.scale, project.rotation, project.offsetX, project.offsetY, project.caption]);

  useEffect(() => {
    if (!composition || !previewCanvas.current) return;
    let active = true;
    setRendering(true);
    const scratch = document.createElement('canvas');
    renderStudioComposition(scratch, composition, 540).then(() => {
      if (!active || !previewCanvas.current) return;
      const canvas = previewCanvas.current;
      canvas.width = scratch.width; canvas.height = scratch.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Anteprima non disponibile in questo browser.');
      context.drawImage(scratch, 0, 0);
    }).catch((cause) => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setRendering(false); });
    return () => { active = false; };
  }, [composition, step, historyOpen]);

  function consumeJob(job: StudioJob, projectId: string) {
    if (projectRef.current.id !== projectId) return;
    setPhase(job.status); setError(job.error?.message || null);
    if (job.status === 'completed' && job.image) {
      setProject((previous) => previous.id === projectId ? { ...previous, image: job.image, jobId: job.id, updatedAt: new Date().toISOString() } : previous);
      setStep(2); setNotice('Immagine pronta. La copertina proviene dalla tua foto.');
    } else {
      setProject((previous) => previous.id === projectId && previous.jobId !== job.id ? { ...previous, jobId: job.id, updatedAt: new Date().toISOString() } : previous);
      if (job.status === 'cancelled') setNotice('Generazione interrotta. Foto e atmosfera sono conservate.');
    }
  }

  useEffect(() => {
    if (!project.requestId || project.image || submitting || submittingId === project.id) return;
    const projectId = project.id;
    const jobId = project.jobId || project.requestId;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    setPhase('recovering');
    const poll = async () => {
      try {
        const job = await getStudioJob(jobId, controller.signal);
        if (!active) return;
        failures = 0; consumeJob(job, projectId);
        if (job.status === 'running') timer = setTimeout(() => { void poll(); }, 2500);
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        if (isAccessError(cause)) { accessCallback.current(); setPhase('failed'); setError('Inserisci il codice di accesso per recuperare la generazione.'); return; }
        failures += 1;
        const status = typeof cause === 'object' && cause !== null && 'status' in cause ? cause.status : 0;
        if (failures < 3 && status !== 404 && status !== 410) { timer = setTimeout(() => { void poll(); }, 2500 * failures); return; }
        setPhase('failed'); setError(errorText(cause, 'Non è possibile recuperare il risultato. Puoi verificarne di nuovo lo stato.'));
      }
    };
    void poll();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [project.id, project.requestId, project.jobId, project.image, submitting, submittingId, pollNonce, accessProvided]);

  function resetProject() {
    if (busy) return;
    invalidateWork(); setProject(makeProject()); setStep(0); setPhase('idle'); setHistoryOpen(false); setSaveState('idle');
  }

  async function receiveFile(file: File) {
    if (generating) return;
    invalidateWork();
    const sequence = ++photoSequence.current;
    setPreparing(true);
    try {
      const photo = await prepareStudioPhoto(file);
      if (sequence !== photoSequence.current) return;
      setProject((previous) => ({ ...(previous.image || previous.requestId ? makeProject(previous.book) : previous), photo, corners: copyCorners(), cover: null, updatedAt: new Date().toISOString() }));
      setStep(0); setPhase('idle');
    } catch (cause) { if (sequence === photoSequence.current) setError(errorText(cause)); }
    finally { if (sequence === photoSequence.current) setPreparing(false); }
  }

  function fileChange(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (file) void receiveFile(file); event.target.value = ''; }

  async function rotate() {
    if (!project.photo || busy) return;
    const sequence = ++photoSequence.current;
    setPreparing(true); setError(null);
    try { const photo = await rotateStudioPhoto(project.photo); if (sequence === photoSequence.current) update({ photo, corners: copyCorners(), cover: null }); }
    catch (cause) { if (sequence === photoSequence.current) setError(errorText(cause)); }
    finally { if (sequence === photoSequence.current) setPreparing(false); }
  }

  function moveCorner(index: number, point: StudioPoint) {
    if (busy) return;
    update({ corners: projectRef.current.corners.map((existing, i) => i === index ? { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) } : existing) as StudioQuad, cover: null });
  }

  function dragPoint(event: PointerEvent<HTMLButtonElement>, index: number) {
    if (dragCorner.current !== index || !cropSurface.current) return;
    const rect = cropSurface.current.getBoundingClientRect();
    moveCorner(index, { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
  }

  function nudgeCorner(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? .02 : .005;
    const point = project.corners[index];
    moveCorner(index, { x: point.x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0), y: point.y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0) });
  }

  async function confirmCrop() {
    if (!project.photo || busy) return;
    const projectId = project.id;
    const controller = new AbortController(); workController.current = controller;
    setCropping(true); setError(null);
    try { const cover = await cropStudioCover(project.photo, project.corners, controller.signal); if (!controller.signal.aborted && projectRef.current.id === projectId) update({ cover }); }
    catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { if (!controller.signal.aborted) setCropping(false); }
  }

  function editBook(patch: Partial<StudioBook>, identity = false) {
    update({ book: { ...project.book, source: null, sourceUrl: null, ...(identity ? { isbn13: null, publisher: null, language: null } : {}), ...patch }, brief: null });
  }

  async function recognize() {
    if (!project.cover || busy) return;
    if (accessBlocked) { onRequestAccess(); return; }
    const projectId = project.id;
    const controller = new AbortController(); workController.current = controller;
    setRecognizing(true); setRecognized([]); setError(null); setRecognitionMessage('Lettura della copertina…');
    const results: BookRecord[] = [];
    try {
      const image = await studioPhotoToPreparedImage(project.cover);
      await scanImage(image, 'table', (event) => {
        if (controller.signal.aborted || projectRef.current.id !== projectId) return;
        if (event.type === 'stage') setRecognitionMessage(event.message);
        if (event.type === 'book') { results.push(event.book); setRecognized([...results]); }
      }, controller.signal);
      if (controller.signal.aborted || projectRef.current.id !== projectId) return;
      if (results.length === 1) { update({ book: toStudioBook(results[0]), brief: null }); setNotice('Dati proposti dalla foto. Controlla titolo e autore prima di continuare.'); }
      else if (!results.length) setError('Non abbiamo trovato un titolo leggibile. Puoi inserirlo a mano o cercarlo nel catalogo.');
    } catch (cause) { if (!controller.signal.aborted) { if (isAccessError(cause)) onAccessRequired(); setError(errorText(cause)); } }
    finally { if (!controller.signal.aborted) setRecognizing(false); }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (accessBlocked) { onRequestAccess(); return; }
    if (searchQuery.trim().length < 2) return;
    workController.current?.abort();
    const controller = new AbortController(); workController.current = controller;
    setSearching(true); setSearched(false); setError(null);
    try { const results = await searchCatalog(searchQuery.trim(), controller.signal); if (!controller.signal.aborted) { setSearchResults(results); setSearched(true); } }
    catch (cause) { if (!controller.signal.aborted) { if (isAccessError(cause)) onAccessRequired(); setError(errorText(cause)); } }
    finally { if (!controller.signal.aborted) setSearching(false); }
  }

  async function buildBrief(input = project) {
    if (accessBlocked) { onRequestAccess(); return; }
    const controller = new AbortController(); workController.current?.abort(); workController.current = controller;
    const projectId = input.id;
    setBriefLoading(true); setError(null);
    try {
      const brief = await createStudioBrief({ book: studioBookSchema.parse(input.book), style: input.style, readerNote: input.readerNote.trim(), mood: input.mood.trim() }, controller.signal);
      if (!controller.signal.aborted && projectRef.current.id === projectId) update({ brief });
    } catch (cause) { if (!controller.signal.aborted) { if (isAccessError(cause)) onAccessRequired(); setError(errorText(cause)); } }
    finally { if (!controller.signal.aborted) setBriefLoading(false); }
  }

  function continueToBrief() {
    setError(null); setNotice(null);
    if (!project.cover) { setError('Conferma il ritaglio della copertina prima di continuare.'); return; }
    if (!project.book.title.trim()) { setError('Inserisci il titolo del libro o leggilo dalla copertina.'); return; }
    if (project.book.isbn13 && !isValidIsbn(project.book.isbn13)) { setError('L’ISBN inserito non è valido. Correggilo oppure lascia il campo vuoto.'); return; }
    const parsed = studioBookSchema.safeParse({ ...project.book, title: project.book.title.trim(), isbn13: toIsbn13(project.book.isbn13) });
    if (!parsed.success) { setError('Controlla i dati: titolo, fino a 12 autori ed eventuale ISBN.'); return; }
    const next = JSON.stringify(parsed.data) === JSON.stringify(project.book) ? project : update({ book: parsed.data });
    setStep(1);
    if (!next.brief) void buildBrief(next);
  }

  function editBrief(patch: Partial<StudioBrief>) { if (project.brief) update({ brief: { ...project.brief, ...patch } }); }

  async function generate(variant?: 'lighter' | 'fewer' | 'another') {
    if (!project.cover || !project.brief || generationLock.current || generating) return;
    if (accessBlocked) { onRequestAccess(); return; }
    if (!generationAvailable) { setError('La generazione delle immagini non è ancora configurata. Foto e atmosfera restano disponibili.'); return; }
    let brief: StudioBrief = { ...project.brief, book: { ...project.book }, style: project.style };
    if (variant === 'lighter') brief = { ...brief, mood: `${brief.mood.slice(0, 100)}. Luce più chiara, naturale e diffusa.` };
    if (variant === 'fewer') brief = { ...brief, elements: brief.elements.slice(0, 1), summary: `${brief.summary.slice(0, 760)} Composizione essenziale, molto spazio libero e al massimo un oggetto di contesto.` };
    const parsed = studioBriefSchema.safeParse(brief);
    if (!parsed.success) { setError('Completa l’atmosfera: servono una descrizione e un tono. Ogni elemento deve avere un nome.'); return; }
    generationLock.current = true;
    const requestId = crypto.randomUUID();
    const next: StudioProject = {
      ...project, ...(project.image || project.requestId ? { id: crypto.randomUUID(), createdAt: new Date().toISOString() } : {}),
      brief: parsed.data, image: null, requestId, jobId: null, updatedAt: new Date().toISOString(),
    };
    projectRef.current = next;
    setSubmittingId(next.id); setSubmitting(true); setPhase('submitting'); setError(null); setNotice(null); setStep(2); setProject(next);
    let persisted = false;
    try {
      // A durable request identity must exist before the image-generation POST.
      await saveStudioProject(next);
      persisted = true;
      const job = await startStudioGeneration(requestId, parsed.data);
      consumeJob(job, next.id);
    } catch (cause) {
      if (isAccessError(cause)) onAccessRequired();
      if (projectRef.current.id === next.id) {
        if (!persisted) { const draft = { ...next, requestId: null, jobId: null }; projectRef.current = draft; setProject(draft); setStep(1); }
        setPhase('failed'); setError(errorText(cause));
      }
    } finally { generationLock.current = false; setSubmitting(false); setSubmittingId(null); }
  }

  async function cancelGeneration() {
    const id = project.jobId || project.requestId;
    if (!id || submitting || cancelling) return;
    setCancelling(true); setError(null);
    try { consumeJob(await cancelStudioJob(id), project.id); }
    catch (cause) { if (isAccessError(cause)) onAccessRequired(); setError(errorText(cause)); }
    finally { setCancelling(false); }
  }

  async function download() {
    if (!composition || exporting || rendering) return;
    setExporting(true); setError(null);
    try {
      const blob = await exportStudioImage(composition);
      const name = project.book.title.normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'libro';
      downloadStudioImage(blob, `Jemiq-${name}-${project.format}.jpg`);
      setNotice('Immagine scaricata in JPEG.');
    } catch (cause) { setError(errorText(cause)); }
    finally { setExporting(false); }
  }

  function openProject(item: StudioProject) {
    if (submitting) return;
    invalidateWork(); setProject(item); setStep(item.image || item.requestId ? 2 : item.brief ? 1 : 0); setPhase(item.image ? 'completed' : 'idle'); setHistoryOpen(false);
  }

  async function removeProject(item: StudioProject) {
    if (item.id === project.id && generating) return;
    deleted.current.add(item.id);
    try { await deleteStudioProject(item.id); setProjects((items) => items.filter((existing) => existing.id !== item.id)); if (item.id === project.id) resetProject(); }
    catch (cause) { deleted.current.delete(item.id); setHistoryError(errorText(cause)); }
  }

  const cornerPoints = project.corners.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ');
  const briefBasis = project.brief?.basis === 'catalog' ? 'Dalla scheda bibliografica' : project.brief?.basis === 'reader' ? 'Dalle tue indicazioni' : 'Proposta basata sullo stile';

  return (
    <section className="studio-workspace" aria-label="Jemiq Studio">
      <header className="page-heading studio-heading"><div><div className="eyebrow"><span/>STUDIO</div><h1>Un’immagine per raccontare un libro.</h1><p>Fotografa la copertina. Scegli l’atmosfera. Crea l’immagine.</p></div><div className="studio-heading-actions"><button className="button secondary" onClick={() => setHistoryOpen(!historyOpen)}><History size={20}/>{historyOpen ? 'Torna al progetto' : 'Le tue immagini'}{projects.length > 0 && <span className="studio-count">{projects.length}</span>}</button>{projectHasContent && <button className="button text-button" onClick={resetProject} disabled={busy}><Plus size={20}/>Nuova</button>}</div></header>

      {(saveError || historyError) && <div className="inline-alert warning studio-alert" role="alert"><AlertCircle size={20}/><span>{saveError || historyError}</span></div>}
      {error && <div ref={errorNotice} className="inline-alert error studio-alert" role="alert"><AlertCircle size={20}/><span>{error}</span><button className="icon-button" onClick={() => setError(null)} aria-label="Chiudi errore"><X size={20}/></button></div>}
      {notice && <div className="studio-notice" role="status"><CheckCircle2 size={20}/><span>{notice}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label="Chiudi avviso"><X size={20}/></button></div>}

      {historyOpen ? <section className="studio-history" aria-labelledby="studio-history-title"><div className="studio-section-heading"><h2 id="studio-history-title">Le tue immagini</h2><span>Salvate in questo browser</span></div>{!historyLoaded ? <p className="studio-loading" role="status"><LoaderCircle className="spin" size={24}/>Caricamento dei progetti…</p> : !projects.length ? <div className="studio-history-empty"><ImagePlus size={36}/><h3>Nessun progetto salvato</h3><p>Inizia da una foto. Il progetto viene salvato mentre lavori.</p><button className="button primary" onClick={() => setHistoryOpen(false)}>Crea la prima immagine<ArrowRight size={20}/></button></div> : <div className="studio-history-grid">{projects.map((item) => <article className="studio-history-card" key={item.id}><button className="studio-history-open" onClick={() => openProject(item)} disabled={submitting}><div className="studio-history-thumbnail">{item.image ? <img src={`data:${item.image.mimeType};base64,${item.image.data}`} alt="Ambientazione generata" loading="lazy"/> : <span className="studio-history-neutral"/>}{item.cover ? <img className="studio-history-cover" src={item.cover.dataUrl} alt="" loading="lazy"/> : <BookOpen size={32}/>}<span className="studio-project-state">{item.image ? 'Immagine pronta' : item.requestId ? 'Generazione avviata' : 'Bozza'}</span></div><div className="studio-history-title"><h3>{item.book.title || 'Nuovo progetto'}</h3><p>{STUDIO_STYLES[item.style].label} · {item.format === 'post' ? 'Post 4:5' : 'Storia 9:16'}</p></div></button><footer><span>{readableDate(item.updatedAt)}</span><button className="icon-button" onClick={() => { void removeProject(item); }} disabled={item.id === project.id && generating} aria-label={`Elimina progetto ${item.book.title || 'senza titolo'}`}><Trash2 size={20}/></button></footer></article>)}</div>}<p className="studio-local-note"><ShieldCheck size={20}/>Le immagini sono conservate in questo browser. Scarica una copia prima di cancellarne i dati.</p></section> : <>
        <nav className="studio-steps" aria-label="Passaggi dello Studio">{['Copertina', 'Atmosfera', 'Immagine'].map((label, index) => <button className={step === index ? 'is-current' : step > index ? 'is-done' : ''} key={label} disabled={busy || (index === 1 && !project.cover) || (index === 2 && !project.image && !project.requestId)} onClick={() => { if (index === 1 && !project.brief) continueToBrief(); else setStep(index as 0 | 1 | 2); }} aria-current={step === index ? 'step' : undefined}><span>{step > index ? <Check size={16}/> : `0${index + 1}`}</span>{label}</button>)}{projectHasContent && <span className={`studio-save-state ${saveState === 'error' ? 'is-error' : ''}`}>{saveState === 'saving' ? <LoaderCircle size={16} className="spin"/> : saveState === 'error' ? <AlertCircle size={16}/> : <Check size={16}/>} {saveState === 'saved' ? 'Salvato' : saveState === 'saving' ? 'Salvataggio…' : saveState === 'error' ? 'Non salvato' : 'Bozza'}</span>}</nav>

        {accessBlocked && <div className="studio-access-note"><LockKeyhole size={20}/><p>Per riconoscere il libro e generare un’immagine serve il codice di accesso.</p><button className="button secondary" onClick={onRequestAccess}>Inserisci codice</button></div>}

        {step === 0 && <div className="studio-input-grid">
          <section className="studio-panel studio-photo-panel" aria-labelledby="studio-photo-title"><header className="studio-panel-header"><div><span className="studio-small-step">01</span><h2 id="studio-photo-title">La tua copertina</h2></div><span>Un libro per immagine</span></header>
            {!project.photo ? <div className="studio-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (event.dataTransfer.files.length !== 1) setError('Carica una sola foto del libro.'); else void receiveFile(event.dataTransfer.files[0]); }}><span className="studio-upload-icon">{preparing ? <LoaderCircle size={36} className="spin"/> : <Camera size={36} strokeWidth={1.5}/>}</span><h3>{preparing ? 'Preparazione della foto…' : 'Inquadra tutta la copertina'}</h3><p>Fotografa il libro dall’alto, con luce uniforme. Il titolo deve essere leggibile.</p><div className="studio-upload-actions"><button className="button primary camera-button" onClick={() => cameraInput.current?.click()} disabled={preparing}><Camera size={20}/>Scatta una foto</button><button className="button secondary" onClick={() => photoInput.current?.click()} disabled={preparing}><Upload size={20}/>Carica foto</button></div><small>JPG, PNG o WebP. Una foto alla volta.</small></div> : <>
              <div className="studio-crop-tools"><p id="studio-crop-help">Porta i quattro angoli sui bordi della copertina.</p><button className="icon-button" onClick={() => { void rotate(); }} disabled={busy} aria-label="Ruota la foto di 90 gradi"><RotateCw size={20}/></button><button className="icon-button" onClick={() => photoInput.current?.click()} disabled={busy} aria-label="Scegli un'altra foto"><ImagePlus size={20}/></button></div>
              <div className="studio-crop-stage"><div ref={cropSurface} className="studio-crop-surface" style={{ aspectRatio: `${project.photo.width} / ${project.photo.height}`, maxWidth: `${460 * project.photo.width / project.photo.height}px` }}><img src={project.photo.dataUrl} alt="Foto da ritagliare: sposta gli angoli sui bordi della copertina" draggable={false}/><svg className="studio-crop-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><path d={`M0,0H1000V1000H0Z M${project.corners.map((point) => `${point.x * 1000},${point.y * 1000}`).join('L')}Z`} fillRule="evenodd" fill="#172A3180"/><polygon points={cornerPoints} fill="transparent" stroke="var(--jemiq-coral)" strokeWidth="3" vectorEffect="non-scaling-stroke"/></svg>{project.corners.map((point, index) => <button key={index} className="studio-crop-handle" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} disabled={busy} aria-label={`Angolo ${CORNER_NAMES[index]}, usa le frecce per spostarlo`} aria-describedby="studio-crop-help" onPointerDown={(event) => { setCropEditing(true); dragCorner.current = index; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => dragPoint(event, index)} onPointerUp={(event) => { setCropEditing(false); dragCorner.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { setCropEditing(false); dragCorner.current = null; }} onKeyDown={(event) => nudgeCorner(event, index)}><span>{index + 1}</span></button>)}{(preparing || cropping) && <div className="studio-photo-loading"><LoaderCircle size={30} className="spin"/><span>{cropping ? 'Preparazione del ritaglio…' : 'Preparazione della foto…'}</span></div>}</div></div>
              <div className="studio-crop-bottom"><p><Crop size={20}/>{project.cover ? 'Ritaglio confermato' : 'Il ritaglio deve contenere solo la copertina.'}</p><button className={`button ${project.cover ? 'secondary' : 'primary'}`} onClick={() => { void confirmCrop(); }} disabled={busy}>{cropping ? <LoaderCircle size={20} className="spin"/> : project.cover ? <Check size={20}/> : <Crop size={20}/>}Conferma ritaglio</button></div><span className="studio-keyboard-hint">Da tastiera: seleziona un angolo e usa le frecce. Maiusc + freccia per spostamenti più ampi.</span>
            </>}
            <div className="studio-preserve-note"><ShieldCheck size={20}/><p><strong>La copertina resta la tua.</strong> Il ritaglio originale viene mantenuto nell’immagine finale.</p></div>
          </section>

          <section className="studio-panel studio-book-panel" aria-labelledby="studio-book-title"><header className="studio-panel-header"><div><BookOpen size={20}/><h2 id="studio-book-title">Il libro</h2></div></header><div className="studio-panel-body">
            <p className="studio-book-intro">Controlla titolo e autore. Servono a cercare un contesto coerente con il libro.</p>
            {project.cover && <div className="studio-recognition"><img src={project.cover.dataUrl} alt="Ritaglio originale della copertina"/><div><strong>Leggi dalla copertina</strong><button className="button secondary" onClick={() => { void recognize(); }} disabled={busy || !health?.recognitionReady}>{recognizing ? <LoaderCircle size={20} className="spin"/> : <ScanLine size={20}/>}Leggi titolo e autore</button></div></div>}
            {recognizing && <p className="studio-loading" role="status">{recognitionMessage}</p>}
            {recognized.length > 1 && <div className="studio-recognized-list"><p>Scegli il libro che vuoi usare:</p>{recognized.map((book) => <button key={book.id} className="studio-found-book" disabled={busy} onClick={() => { update({ book: toStudioBook(book), brief: null }); setRecognized([]); }}><BookOpen size={20}/><span><strong>{book.title || 'Titolo da completare'}</strong><small>{book.authors.join(', ')}</small></span><ArrowRight size={20}/></button>)}</div>}
            <label className="field-label">Titolo<input value={project.book.title} maxLength={400} onChange={(event) => editBook({ title: event.target.value }, true)} placeholder="Titolo del libro" disabled={busy}/></label>
            <label className="field-label">Autore<input value={authorsDraft} maxLength={1200} onChange={(event) => { setAuthorsDraft(event.target.value); editBook({ authors: parseAuthors(event.target.value) }, true); }} placeholder="Nome e cognome" disabled={busy}/><small>Separa più autori con un punto e virgola.</small></label>
            <details className="studio-book-extra"><summary>ISBN e fonte<ChevronDown size={20}/></summary><label className="field-label">ISBN <span className="studio-optional">facoltativo</span><input value={project.book.isbn13 || ''} maxLength={20} onChange={(event) => editBook({ isbn13: event.target.value || null }, true)} placeholder="ISBN-10 o ISBN-13" disabled={busy}/></label>{project.book.publisher && <p>Editore: {project.book.publisher}</p>}{safeUrl(project.book.sourceUrl) && <a href={safeUrl(project.book.sourceUrl)} target="_blank" rel="noreferrer noopener">{project.book.source}<ArrowUpRight size={16}/></a>}</details>
            <details className="studio-catalog-search"><summary><Search size={20}/>Cerca nel catalogo<ChevronDown size={20}/></summary><form onSubmit={search}><label className="sr-only" htmlFor="studio-book-search">Titolo, autore o ISBN</label><input id="studio-book-search" value={searchQuery} maxLength={240} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Titolo, autore o ISBN" disabled={busy}/><button className="button secondary" type="submit" disabled={searching || busy || searchQuery.trim().length < 2}>{searching ? <LoaderCircle size={20} className="spin"/> : <Search size={20}/>}Cerca</button></form>{searched && !searchResults.length && <p>Nessun risultato. Prova il titolo completo o inserisci i dati a mano.</p>}<div className="studio-search-results">{searchResults.slice(0, 6).map((candidate) => <button className="studio-found-book" key={candidate.id} disabled={busy} onClick={() => { update({ book: toStudioBook(candidate), brief: null }); setSearchResults([]); setSearched(false); setNotice('Dati del libro selezionati. Controllali prima di continuare.'); }}><BookOpen size={20}/><span><strong>{candidate.title}</strong><small>{candidate.authors.join(', ')}</small><small>{[candidate.publisher, candidate.publishedDate, candidate.isbn13].filter(Boolean).join(' · ')}</small></span><Check size={20}/></button>)}</div></details>
            <button className="button primary studio-continue" onClick={continueToBrief} disabled={busy || !project.cover || !project.book.title.trim()}>Conferma libro e continua<ArrowRight size={20}/></button>
            <p className="studio-footnote">Puoi inserire i dati a mano anche quando il riconoscimento non è disponibile.</p>
          </div></section>
        </div>}

        {step === 1 && <div className="studio-brief-grid">
          <section className="studio-panel" aria-labelledby="studio-atmosphere-title"><header className="studio-panel-header"><div><span className="studio-small-step">02</span><h2 id="studio-atmosphere-title">Scegli l’atmosfera</h2></div></header><div className="studio-panel-body">
            <div className="studio-book-summary">{project.cover && <img src={project.cover.dataUrl} alt="Copertina originale"/>}<div><strong>{project.book.title}</strong><span>{project.book.authors.join(', ')}</span><button onClick={() => { setStep(0); setError(null); }} disabled={busy}>Cambia libro<ArrowLeft size={14}/></button></div></div>
            <span className="studio-field-heading">Stile</span><div className="studio-style-options" role="group" aria-label="Stile dell’immagine">{(Object.keys(STUDIO_STYLES) as StudioStyle[]).map((style) => <button className={project.style === style ? 'selected' : ''} aria-pressed={project.style === style} key={style} onClick={() => update({ style, brief: null })} disabled={busy}><StyleIcon style={style}/><strong>{STUDIO_STYLES[style].label}</strong><span>{STUDIO_STYLES[style].description}</span>{project.style === style && <Check className="studio-style-check" size={16}/>}</button>)}</div>
            <label className="field-label">Tono desiderato <span className="studio-optional">facoltativo</span><input value={project.mood} maxLength={120} onChange={(event) => update({ mood: event.target.value, brief: null })} placeholder="Es. intimo, misterioso, luminoso" disabled={busy}/></label>
            <label className="field-label">Elementi che vuoi raccontare <span className="studio-optional">facoltativo</span><textarea value={project.readerNote} maxLength={1200} rows={4} onChange={(event) => update({ readerNote: event.target.value, brief: null })} placeholder="Un luogo, un oggetto o una sensazione della tua lettura…" disabled={busy}/><small>La proposta evita i colpi di scena. Scrivi tu gli eventuali dettagli narrativi che vuoi includere.</small></label>
            <button className="button secondary studio-brief-button" onClick={() => { void buildBrief(); }} disabled={busy}>{briefLoading ? <LoaderCircle size={20} className="spin"/> : <RefreshCw size={20}/>} {project.brief ? 'Ricalcola proposta' : 'Prepara atmosfera'}</button>
          </div></section>

          <section className="studio-panel studio-brief-review" aria-labelledby="studio-brief-title"><header className="studio-panel-header"><div><Layers size={20}/><h2 id="studio-brief-title">Il contesto dell’immagine</h2></div></header><div className="studio-panel-body">
            {briefLoading ? <div className="studio-brief-empty" role="status"><LoaderCircle size={32} className="spin"/><h3>Preparazione del contesto…</h3><p>Cerchiamo le informazioni disponibili sul libro.</p></div> : !project.brief ? <div className="studio-brief-empty"><Layers size={36} strokeWidth={1.5}/><h3>Controlla il contesto prima di creare</h3><p>Prepara una proposta a partire dal libro, dallo stile e dalle tue indicazioni. Potrai modificarla.</p></div> : <>
              <div className={`studio-basis basis-${project.brief.basis}`}><ShieldCheck size={18}/><span>{briefBasis}</span></div>
              <label className="field-label">Descrizione dell’atmosfera<textarea value={project.brief.summary} maxLength={900} rows={5} onChange={(event) => editBrief({ summary: event.target.value, basis: 'reader' })} disabled={busy}/></label>
              <label className="field-label">Luce e tono<input value={project.brief.mood} maxLength={160} onChange={(event) => editBrief({ mood: event.target.value, basis: 'reader' })} disabled={busy}/></label>
              <div className="studio-elements-heading"><span className="studio-field-heading">Elementi di contesto</span><small>Fino a 3</small></div><div className="studio-elements">{project.brief.elements.map((element, index) => <div key={element.id}><label className="sr-only" htmlFor={`studio-element-${element.id}`}>Elemento {index + 1}</label><input id={`studio-element-${element.id}`} value={element.label} maxLength={140} onChange={(event) => editBrief({ elements: project.brief!.elements.map((item, i) => i === index ? { ...item, label: event.target.value, basis: 'reader' } : item) })} disabled={busy}/><button className="icon-button" aria-label={`Rimuovi ${element.label || 'elemento'}`} onClick={() => editBrief({ elements: project.brief!.elements.filter((_, i) => i !== index) })} disabled={busy}><X size={20}/></button></div>)}</div>{project.brief.elements.length < 3 && <button className="button text-button studio-add-element" onClick={() => editBrief({ elements: [...project.brief!.elements, { id: crypto.randomUUID(), label: 'Nuovo elemento', basis: 'reader' }] })} disabled={busy}><Plus size={18}/>Aggiungi elemento</button>}
              <div className="studio-palette-row"><span className="studio-field-heading">Palette</span><div className="studio-palette">{project.brief.palette.map((color, index) => <label key={index} title={`Colore ${index + 1}: ${color}`}><span className="sr-only">Colore {index + 1}</span><input type="color" value={color} onChange={(event) => editBrief({ palette: project.brief!.palette.map((item, i) => i === index ? event.target.value : item) })} disabled={busy}/></label>)}</div></div>
              {project.brief.sources.length > 0 && <div className="studio-brief-sources"><span>Fonti del contesto</span>{project.brief.sources.filter((source) => safeUrl(source.url)).map((source, index) => <a href={source.url} key={index} target="_blank" rel="noreferrer noopener">{source.provider}<ArrowUpRight size={16}/></a>)}</div>}
              {project.brief.warnings.length > 0 && <div className="studio-brief-warnings">{project.brief.warnings.map((warning, index) => <p key={index}><AlertCircle size={16}/><span>{warning}</span></p>)}</div>}
              <button className="button primary studio-generate" onClick={() => { void generate(); }} disabled={busy || !generationAvailable || !project.brief.summary.trim() || !project.brief.mood.trim() || project.brief.elements.some((element) => !element.label.trim())}><ImagePlus size={20}/>Crea immagine<ArrowRight size={20}/></button>
            </>}
            {!generationAvailable && <div className="studio-service-note"><AlertCircle size={20}/><p>La generazione delle immagini non è ancora configurata. Puoi preparare la foto e l’atmosfera.</p></div>}
          </div></section>
        </div>}

        {step === 2 && <div className="studio-result-grid">
          <section className="studio-panel studio-preview-panel" aria-labelledby="studio-preview-title"><header className="studio-panel-header"><div><span className="studio-small-step">03</span><h2 id="studio-preview-title">{project.image ? 'La tua immagine' : 'Preparazione dell’immagine'}</h2></div>{project.image && <span className="studio-ready-label"><CheckCircle2 size={18}/>Pronta</span>}</header>
            <div className={`studio-preview-stage ${project.format === 'story' ? 'is-story' : ''}`}>
              {composition ? <div className="studio-canvas-wrap" style={{ aspectRatio: project.format === 'post' ? '4 / 5' : '9 / 16' }}><canvas ref={previewCanvas} aria-label={`Immagine di ${project.book.title}, con la copertina originale e un’ambientazione generata`}/>{rendering && <div className="studio-canvas-loading" role="status"><LoaderCircle className="spin" size={28}/><span>Preparazione anteprima…</span></div>}</div> : <div className="studio-pending-preview"><div className="studio-cover-placeholder">{project.cover && <img src={project.cover.dataUrl} alt="La copertina originale, in attesa dell’ambientazione"/>}</div><span className="studio-preview-caption">Copertina originale · ambientazione da generare</span></div>}
            </div>
            <div className="studio-preview-footer"><ShieldCheck size={20}/><span>Copertina fotografata. Ambientazione generata.</span>{project.image && <strong>{project.format === 'post' ? '1080 × 1350 px' : '1080 × 1920 px'}</strong>}</div>
          </section>

          <aside className="studio-result-controls">
            <section className="studio-panel"><div className="studio-panel-body"><div className="studio-result-title"><h2>{project.book.title}</h2><p>{project.book.authors.join(', ')}</p><span><StyleIcon style={project.style}/>{STUDIO_STYLES[project.style].label}</span></div>
              {generating ? <div className="studio-job-state" role="status"><LoaderCircle size={26} className="spin"/><h3>{submitting ? 'Avvio della generazione…' : phase === 'recovering' ? 'Verifica della generazione…' : 'Creazione dell’ambientazione…'}</h3><p>Il risultato comparirà qui appena disponibile. La copertina viene applicata alla fine.</p>{!submitting && <button className="button secondary" onClick={() => { void cancelGeneration(); }} disabled={cancelling}>{cancelling ? <LoaderCircle size={20} className="spin"/> : <Square size={18}/>}Interrompi</button>}</div> : !project.image ? <div className="studio-job-state"><AlertCircle size={26}/><h3>{phase === 'cancelled' ? 'Generazione interrotta' : 'Risultato non disponibile'}</h3><p>Foto e atmosfera sono conservate. Verifica lo stato prima di avviare un’altra generazione.</p><button className="button secondary" onClick={() => { setError(null); setPollNonce((value) => value + 1); }} disabled={!project.requestId}><RefreshCw size={20}/>Verifica stato</button><button className="button text-button" onClick={() => { setError(null); setStep(1); }}>Torna all’atmosfera<ArrowLeft size={18}/></button></div> : <>
                <fieldset className="studio-format-options"><legend>Formato</legend><div role="group" aria-label="Formato immagine"><button className={project.format === 'post' ? 'selected' : ''} aria-pressed={project.format === 'post'} onClick={() => update({ format: 'post' })}><span className="studio-format-icon format-post"/><span><strong>Post</strong><small>4:5</small></span>{project.format === 'post' && <Check size={18}/>}</button><button className={project.format === 'story' ? 'selected' : ''} aria-pressed={project.format === 'story'} onClick={() => update({ format: 'story' })}><span className="studio-format-icon format-story"/><span><strong>Storia</strong><small>9:16</small></span>{project.format === 'story' && <Check size={18}/>}</button></div></fieldset><p className="studio-footnote">Il cambio formato ricompone l’immagine già creata.</p>
                <details className="studio-composition-controls"><summary><Maximize2 size={20}/>Regola la composizione<ChevronDown size={20}/></summary><label>Dimensione del libro <span>{Math.round(project.scale * 100)}%</span><input type="range" min="0.7" max="1.25" step="0.01" value={project.scale} onChange={(event) => update({ scale: Number(event.target.value) })}/></label><label>Inclinazione <span>{project.rotation}°</span><input type="range" min="-15" max="15" step="1" value={project.rotation} onChange={(event) => update({ rotation: Number(event.target.value) })}/></label><button className="button text-button" onClick={() => update({ scale: 1, rotation: INITIAL_ROTATION, offsetX: 0, offsetY: 0 })}>Ripristina composizione</button></details>
                <button className="button primary studio-download" onClick={() => { void download(); }} disabled={exporting || rendering}>{exporting ? <LoaderCircle className="spin" size={20}/> : <Download size={20}/>}Scarica immagine</button><p className="studio-footnote">JPEG ad alta risoluzione, pronto per il tuo post.</p>
              </>}
            </div></section>
            {project.image && <section className="studio-panel studio-variants"><div className="studio-panel-body"><h3>Una nuova ambientazione</h3><p>Queste azioni generano una nuova immagine. Il risultato attuale resta nella cronologia.</p><div><button className="button secondary" onClick={() => { void generate('lighter'); }} disabled={busy}><Sun size={20}/>Più luce</button><button className="button secondary" onClick={() => { void generate('fewer'); }} disabled={busy}><Minus size={20}/>Meno oggetti</button><button className="button secondary" onClick={() => { void generate('another'); }} disabled={busy}><RefreshCw size={20}/>Altra ambientazione</button></div><button className="button text-button" onClick={() => { setStep(1); setNotice(null); }} disabled={busy}>Modifica atmosfera<ArrowLeft size={18}/></button></div></section>}
          </aside>
        </div>}
        <div className="studio-bottom-note"><ShieldCheck size={20}/><p>Il ritaglio e la composizione avvengono nel browser. Per riconoscere il libro inviamo la copertina; per generare l’ambientazione inviamo il contesto testuale.</p></div>
      </>}
      <input className="sr-only" type="file" accept="image/*" capture="environment" ref={cameraInput} onChange={fileChange} aria-label="Scatta una foto della copertina" tabIndex={-1}/>
      <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" ref={photoInput} onChange={fileChange} aria-label="Carica una foto della copertina" tabIndex={-1}/>
    </section>
  );
}
