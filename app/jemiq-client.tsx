'use client';
import { Component, useEffect, useState, type ComponentType, type PropsWithChildren } from 'react';

class ErrorBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <main className="boot-screen"><h1>Riapri il tuo catalogo.</h1><p>La pagina ha incontrato un problema. I cataloghi già salvati restano disponibili.</p><button className="button primary" onClick={() => window.location.reload()}>Ricarica Jemiq</button></main> : this.props.children;
  }
}

/** Defer the local database and camera UI until a browser is available. */
export default function JemiqClient() {
  const [App, setApp] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    void import('../src/App').then(module => { if (mounted) setApp(() => module.default); }).catch(() => { if (mounted) setFailed(true); });
    return () => { mounted = false; };
  }, []);
  if (failed) return <main className="boot-screen"><h1>Connessione interrotta</h1><p>Riprova a caricare Jemiq.</p><button className="button primary" onClick={() => window.location.reload()}>Ricarica</button></main>;
  return <ErrorBoundary>{App ? <App /> : <main className="boot-screen" role="status"><img src="/favicon.svg" width="64" height="64" alt=""/><h1>jemiq</h1><p>Preparo il tuo spazio per i libri…</p></main>}</ErrorBoundary>;
}
