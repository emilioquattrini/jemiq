import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, LoaderCircle, RefreshCw, Settings2, ShieldCheck, X } from 'lucide-react';
import { z } from 'zod';
import { apiHeaders, ApiError, rejectApiResponse } from '../lib/api';

const settingsSchema = z.object({
  configured: z.boolean(),
  model: z.string(),
  source: z.enum(['environment', 'saved', 'none']),
  googleBooksConfigured: z.boolean(),
  editable: z.boolean(),
});
type SettingsData = z.infer<typeof settingsSchema>;

interface SettingsProps {
  onClose: () => void;
  onSaved: () => void;
  onAccessRequired: () => void;
}

export default function Settings({ onClose, onSaved, onAccessRequired }: SettingsProps) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [geminiKey, setGeminiKey] = useState('');
  const [booksKey, setBooksKey] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const mounted = useRef(false);
  const callbacks = useRef({ onClose, onSaved, onAccessRequired });
  callbacks.current = { onClose, onSaved, onAccessRequired };

  async function request(method: 'GET' | 'POST', body?: Record<string, string | boolean>): Promise<SettingsData | null> {
    if (activeRequest.current) return null;
    const controller = new AbortController();
    activeRequest.current = controller;
    setError(null); setSaved(false);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(method === 'POST' ? 50_000 : 12_000)]);
    try {
      const response = await fetch('/api/settings', { method, headers: apiHeaders(), cache: 'no-store', signal, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) await rejectApiResponse(response);
      const value = await response.json().catch(() => { throw new Error('Le impostazioni ricevute non sono leggibili. Riprova.'); });
      const result = settingsSchema.safeParse(value);
      if (!result.success) throw new Error('Le impostazioni ricevute non sono leggibili. Riprova.');
      return controller.signal.aborted ? null : result.data;
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current) return null;
      if (cause instanceof ApiError && cause.status === 401) {
        callbacks.current.onAccessRequired();
        callbacks.current.onClose();
      } else {
        const message = signal.aborted ? 'Il servizio ha impiegato troppo tempo. Riprova a verificare le impostazioni.' : cause instanceof TypeError ? 'Non riesco a contattare Jemiq. Controlla la connessione e riprova.' : cause instanceof Error ? cause.message : 'Non è stato possibile aggiornare le impostazioni.';
        setError(message);
      }
      return null;
    } finally { if (activeRequest.current === controller) activeRequest.current = null; }
  }

  async function load() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    const result = await request('GET');
    if (!mounted.current || generation !== loadGeneration.current) return;
    if (result) { setSettings(result); setModel(result.model); }
    setLoading(false);
  }

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void load();
    return () => { mounted.current = false; loadGeneration.current += 1; activeRequest.current?.abort(); activeRequest.current = null; };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (activeRequest.current || saving || !settings?.editable) return;
    if (!settings.configured && !geminiKey.trim()) { setError('Inserisci la chiave Gemini per attivare il riconoscimento.'); return; }
    if (!/^gemini-[a-z0-9][a-z0-9._-]{0,120}$/i.test(model.trim())) { setError('Inserisci un nome di modello Gemini valido.'); return; }
    setSaving(true);
    const result = await request('POST', {
      verify: true,
      ...(geminiKey.trim() ? { geminiApiKey: geminiKey.trim() } : {}),
      ...(booksKey.trim() ? { googleBooksApiKey: booksKey.trim() } : {}),
      ...(model.trim() !== settings.model ? { model: model.trim() } : {}),
    });
    if (!mounted.current) return;
    if (result) {
      setSettings(result); setModel(result.model); setGeminiKey(''); setBooksKey(''); setSaved(true);
      callbacks.current.onSaved();
    }
    setSaving(false);
  }

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={(event) => { if (saving) event.preventDefault(); else onClose(); }}>
    <div className="dialog-shell">
      <header className="dialog-header"><div><span className="eyebrow">IL TUO SPAZIO</span><h2 id="settings-title">Impostazioni</h2></div><button className="icon-button" onClick={onClose} disabled={saving} aria-label="Chiudi impostazioni"><X size={21}/></button></header>
      {loading ? <div className="settings-loading" role="status"><LoaderCircle size={24} className="spin"/><p>Caricamento delle impostazioni…</p></div> : !settings ? <div className="settings-loading"><AlertCircle size={26}/><p role="alert">{error || 'Le impostazioni non sono disponibili.'}</p><button className="button secondary" onClick={() => { void load(); }}><RefreshCw size={17}/>Riprova</button></div> : <form className="settings-form" onSubmit={(event) => { void save(event); }}>
        <div className="dialog-scroll">
          <div className={`settings-readiness ${settings.configured ? 'is-configured' : ''}`}><span>{settings.configured ? <CheckCircle2 size={23}/> : <Settings2 size={23}/>}</span><div><h3>{settings.configured ? 'Riconoscimento configurato' : 'Attiva il riconoscimento'}</h3><p>{settings.configured ? 'Puoi fotografare i libri e creare il tuo catalogo.' : 'Collega Gemini per leggere i libri nelle tue foto.'}</p><span className="settings-model">Modello: {settings.model}</span></div></div>
          {settings.editable ? <>
            <label className="field-label">{settings.configured ? 'Sostituisci la chiave Gemini' : 'Chiave Gemini'}<input type="password" autoComplete="new-password" value={geminiKey} onChange={(event) => { setGeminiKey(event.target.value); setSaved(false); }} placeholder={settings.configured ? 'Lascia vuoto per mantenere la chiave attuale' : 'Inserisci la chiave del servizio'} spellCheck={false} maxLength={512} disabled={saving} required={!settings.configured}/><small>La chiave viene salvata dal server. Non viene mostrata né inclusa nei cataloghi o nei backup.</small></label>
            <details className="settings-advanced"><summary>Opzioni avanzate<ChevronDown size={17}/></summary><div><label className="field-label">Modello di lettura<input value={model} onChange={(event) => { setModel(event.target.value); setSaved(false); }} spellCheck={false} autoCapitalize="none" maxLength={128} disabled={saving}/><small>Il modello attuale è già pronto all’uso. Modificalo solo per usare un altro modello Gemini compatibile con le immagini.</small></label><label className="field-label">Chiave Google Books <span className="field-optional">facoltativa</span><input type="password" autoComplete="new-password" value={booksKey} onChange={(event) => { setBooksKey(event.target.value); setSaved(false); }} placeholder={settings.googleBooksConfigured ? 'Lascia vuoto per mantenere la chiave attuale' : 'Facoltativa per la ricerca nei cataloghi'} spellCheck={false} maxLength={512} disabled={saving}/><small>{settings.googleBooksConfigured ? 'Google Books è già configurato.' : 'La ricerca bibliografica può funzionare anche senza questa chiave.'}</small></label></div></details>
            <p className="settings-verification-note"><ShieldCheck size={17}/><span>“Salva e verifica” invia una breve richiesta di testo al servizio AI. La configurazione cambia solo se il controllo riesce. Per verificare la lettura di una foto, esegui una scansione.</span></p>
          </> : <p className="settings-readonly">Queste impostazioni sono gestite dal proprietario di Jemiq.</p>}
          {error && <div className="inline-alert error" role="alert"><AlertCircle size={18}/><span>{error}</span></div>}
          {saved && <div className="inline-alert success" role="status"><CheckCircle2 size={18}/><span>Impostazioni salvate. Il servizio AI ha risposto al controllo di connessione.</span></div>}
        </div>
        <footer className="dialog-footer"><button className="button secondary" type="button" onClick={onClose} disabled={saving}>Chiudi</button>{settings.editable && <button className="button primary" type="submit" disabled={saving || !model.trim() || (!settings.configured && !geminiKey.trim())}>{saving ? <LoaderCircle size={18} className="spin"/> : <CheckCircle2 size={18}/>} {saving ? 'Verifica in corso…' : 'Salva e verifica'}</button>}</footer>
      </form>}
    </div>
  </dialog>;
}
