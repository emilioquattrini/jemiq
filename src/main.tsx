import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? (
      <main style={{ maxWidth: 540, margin: '12vh auto', padding: 28, fontFamily: 'system-ui' }}>
        <h1>Riapri il tuo catalogo.</h1>
        <p>La pagina ha incontrato un problema. Le sessioni già salvate restano su questo dispositivo.</p>
        <button onClick={() => window.location.reload()}>Ricarica Jemiq</button>
      </main>
    ) : this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>,
);
