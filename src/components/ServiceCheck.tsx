import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { checkVisionConnection } from '../lib/api';
import type { HealthStatus } from '../../shared/types';

export type ServiceCheckStatus = 'ready' | 'loading' | 'connection' | 'configuration' | 'access';
export const PLATFORM_ACCESS_MESSAGE = 'La sessione è scaduta. Ricarica Jemiq per accedere di nuovo.';

export function getServiceCheckStatus({ health, checkingHealth, healthError, accessProvided, platformAccessExpired = false }: {
  health: HealthStatus | null;
  checkingHealth: boolean;
  healthError: string | null;
  accessProvided: boolean;
  platformAccessExpired?: boolean;
}): ServiceCheckStatus {
  if (checkingHealth) return 'loading';
  if (healthError || !health) return 'connection';
  if (!health.recognitionReady) return 'configuration';
  if (platformAccessExpired || (health.authMode !== 'platform' && health.accessRequired && !accessProvided)) return 'access';
  return 'ready';
}

interface ServiceCheckProps {
  status: ServiceCheckStatus;
  authMode?: 'platform' | 'token';
  onAccessRequired: () => void;
  onRequestAccess: () => void;
  onRetryAvailability: () => void;
}

export default function ServiceCheck({ status, authMode = 'token', onAccessRequired, onRequestAccess, onRetryAvailability }: ServiceCheckProps) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  useEffect(() => {
    setMessage(null); setFailed(false);
    if (status !== 'ready') { controller.current?.abort(); controller.current = null; setChecking(false); }
  }, [status]);

  async function check() {
    if (controller.current || status !== 'ready') return;
    const active = new AbortController();
    controller.current = active; setChecking(true); setMessage(null); setFailed(false);
    try {
      await checkVisionConnection(active.signal);
      if (!active.signal.aborted) setMessage('Il servizio AI ha accettato la richiesta di testo. Per verificare la lettura delle foto, esegui una scansione.');
    } catch (error) {
      if (!active.signal.aborted) {
        setFailed(true);
        if (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) {
          setMessage(authMode === 'platform' ? PLATFORM_ACCESS_MESSAGE : 'Il codice di accesso non è valido. Inseriscilo di nuovo.');
          onAccessRequired();
        } else setMessage(error instanceof Error ? error.message : 'La verifica non è riuscita.');
      }
    } finally {
      if (controller.current === active) { controller.current = null; setChecking(false); }
    }
  }

  return <div className="help-item service-check"><RefreshCw size={21}/><div>
    <h3>Verifica il servizio di lettura</h3>
    <p>Il controllo invia una breve richiesta di testo al servizio AI. La lettura di una foto richiede una scansione.</p>
    <button className="button secondary" disabled={status !== 'ready' || checking} onClick={() => { void check(); }}>
      {checking ? <LoaderCircle size={16} className="spin"/> : <RefreshCw size={16}/>}
      {checking ? 'Verifica in corso…' : 'Verifica connessione AI'}
    </button>
    {status === 'loading' && <p role="status">Controllo della disponibilità del servizio…</p>}
    {status === 'configuration' && <p>Il riconoscimento non è ancora configurato. Puoi usare la demo o inserire i libri a mano.</p>}
    {status === 'connection' && <p>Il servizio non è raggiungibile. Controlla la connessione e riprova.</p>}
    {(status === 'configuration' || status === 'connection') && <button className="button text-button" onClick={onRetryAvailability}><RefreshCw size={16}/>Ricontrolla disponibilità</button>}
    {status === 'access' && <><p>{authMode === 'platform' ? PLATFORM_ACCESS_MESSAGE : 'Inserisci il codice di accesso per eseguire la verifica.'}</p><button className="button secondary" onClick={onRequestAccess}>{authMode === 'platform' ? 'Ricarica Jemiq' : 'Inserisci codice'}</button></>}
    {message && <p className={failed ? 'service-check-error' : 'service-check-success'} role={failed ? 'alert' : 'status'}>{message}</p>}
  </div></div>;
}
