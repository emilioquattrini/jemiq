import type { Metadata } from 'next';
import '../src/styles.css';

export const metadata: Metadata = {
  title: 'Jemiq · Dai libri al tuo catalogo',
  description: 'Fotografa un tavolo o uno scaffale, riconosci i libri e crea un catalogo da verificare ed esportare.',
  icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Jemiq', statusBarStyle: 'default' },
};
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#172A31' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="it"><body>{children}</body></html>;
}
