import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { checkVisionConnection } from '../lib/api';

export default function ServiceCheck({ available }: { available: boolean }) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function check() {
    if (controller.current || !available) return;
    const active = new AbortController();
    controller.current = active; setChecking(true); setMessage(null);
    try {
      await checkVisionConnection(active.signal);
      setMessage('Gemini risponde alle richieste di testo. Per verificare la lettura delle foto, esegui una scansione.');
    } catch (error) {
      if (!active.signal.aborted) setMessage(error instanceof Error ? error.message : 'La verifica non è riuscita.');
    } finally {
      if (!active.signal.aborted) { setChecking(false); controller.current = null; }
    }
  }

  return <div className="help-item"><RefreshCw size={21}/><div>
    <h3>Verifica il servizio di lettura</h3>
    <p>Controlla il collegamento a Gemini con una breve richiesta di testo.</p>
    <button className="button secondary" disabled={!available || checking} onClick={() => { void check(); }}>
      {checking ? <LoaderCircle size={16} className="spin"/> : <RefreshCw size={16}/>}
      {checking ? 'Verifica in corso…' : 'Verifica connessione AI'}
    </button>
    {!available && <p>Inserisci il codice di accesso per eseguire la verifica.</p>}
    {message && <p role="status">{message}</p>}
  </div></div>;
}
