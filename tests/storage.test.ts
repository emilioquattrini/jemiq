import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadSessions, saveSession, deleteSession } from '../src/lib/storage';
import { createDemoSession } from '../src/lib/demo';

describe('local session persistence', () => {
  it('preserves edits through a reload and serializes rapid updates in order', async () => {
    const session = createDemoSession();
    await saveSession(session);
    const first = saveSession({ ...session, name: 'Modifica 1' });
    const second = saveSession({ ...session, name: 'Modifica 2', books: session.books.map(book => ({ ...book, quantity: 4 })) });
    await Promise.all([first, second]);
    const recovered = (await loadSessions()).find(item => item.id === session.id)!;
    expect(recovered.name).toBe('Modifica 2');
    expect(recovered.books[0].quantity).toBe(4);
    expect(recovered.isDemo).toBe(true);
    await deleteSession(session.id);
    expect((await loadSessions()).find(item => item.id === session.id)).toBeUndefined();
  });

  it('does not mutate a saved snapshot when the calling object is edited later', async () => {
    const session = createDemoSession();
    const saving = saveSession(session);
    session.name = 'Unsaved edit';
    session.books[0].title = 'Unsaved title';
    await saving;
    const loaded = (await loadSessions()).find(item => item.id === session.id)!;
    expect(loaded.name).not.toBe('Unsaved edit');
    expect(loaded.books[0].title).not.toBe('Unsaved title');
    await deleteSession(session.id);
  });
});
