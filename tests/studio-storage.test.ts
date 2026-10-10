import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_STUDIO_BOOK, DEFAULT_STUDIO_CORNERS, studioGenerationSchema, type StudioProject } from '../shared/studio';
import { loadStudioProjects, saveStudioProject, deleteStudioProject } from '../src/lib/studio-storage';

const draft = (): StudioProject => ({
  id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  photo: null, corners: structuredClone(DEFAULT_STUDIO_CORNERS), cover: null,
  book: { ...EMPTY_STUDIO_BOOK }, style: 'atmospheric', readerNote: '', mood: '', brief: null,
  image: null, format: 'post', scale: 1, rotation: 0, offsetX: 0, offsetY: 0, caption: '', jobId: null, requestId: null,
});
afterEach(async () => { for (const project of await loadStudioProjects()) await deleteStudioProject(project.id); });

describe('Studio recovery in the browser', () => {
  it('saves incomplete drafts and the request identity before any generation acknowledgement', async () => {
    const project = draft(); project.requestId = crypto.randomUUID();
    await saveStudioProject(project);
    const restored = (await loadStudioProjects())[0];
    expect(restored.book.title).toBe(''); expect(restored.requestId).toBe(project.requestId); expect(restored.jobId).toBeNull();
  });
  it('round-trips temporarily empty editable brief fields while the generation contract still rejects them', async () => {
    const project = draft(); project.requestId = crypto.randomUUID();
    project.brief = {
      book: { ...EMPTY_STUDIO_BOOK, title: 'Un libro' }, style: 'atmospheric',
      summary: '', mood: '', palette: ['#334455', '#DDEEFF'],
      elements: [{ id: 'prop-1', label: '', basis: 'reader' }], sources: [], warnings: [], basis: 'reader',
    };
    await saveStudioProject(project);
    const restored = (await loadStudioProjects())[0];
    expect(restored.brief).toEqual(project.brief);
    const request = studioGenerationSchema.safeParse({ requestId: restored.requestId, brief: restored.brief });
    expect(request.success).toBe(false);
    if (!request.success) expect(request.error.issues.map(issue => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['brief.summary', 'brief.mood', 'brief.elements.0.label']),
    );
    expect(studioGenerationSchema.safeParse({ requestId: restored.requestId, brief: {
      ...restored.brief!, summary: 'Un viaggio raccontato dal lettore.', mood: 'Sereno',
      elements: [{ ...restored.brief!.elements[0], label: 'Una conchiglia' }],
    } }).success).toBe(true);
  });
  it('serializes rapid changes and does not let a late save resurrect a deleted project', async () => {
    const project = draft();
    const first = saveStudioProject({ ...project, mood: 'Quieto' });
    const second = saveStudioProject({ ...project, mood: 'Nostalgico', format: 'story' });
    await Promise.all([first, second]);
    expect((await loadStudioProjects())[0]).toMatchObject({ mood: 'Nostalgico', format: 'story' });
    await Promise.all([saveStudioProject({ ...project, caption: 'Lettura del mese' }), deleteStudioProject(project.id)]);
    expect(await loadStudioProjects()).toHaveLength(0);
  });
  it('snapshots cover pixels and corners independently from subsequent UI mutations', async () => {
    const project = draft();
    project.cover = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==' };
    const saving = saveStudioProject(project);
    project.corners[0].x = .2; project.cover.dataUrl = 'changed';
    await saving;
    expect((await loadStudioProjects())[0].corners[0].x).toBe(0);
    expect((await loadStudioProjects())[0].cover?.dataUrl).toContain('data:image/png;base64,');
  });
  it('rejects a 21st project without deleting existing work, then allows space to be recovered', async () => {
    for (let i = 0; i < 20; i++) await saveStudioProject(draft());
    const extra = draft();
    await expect(saveStudioProject(extra)).rejects.toThrow('20 progetti');
    const existing = await loadStudioProjects(); expect(existing).toHaveLength(20);
    await saveStudioProject({ ...existing[0], mood: 'Aggiornato' });
    await deleteStudioProject(existing[1].id); await saveStudioProject(extra);
    expect(await loadStudioProjects()).toHaveLength(20);
  });
  it('rejects an external cover URL before writing anything to the project store', async () => {
    const project = draft(); project.photo = { dataUrl: 'https://untrusted.example/image.svg', width: 800, height: 1200 };
    expect(() => saveStudioProject(project)).toThrow(); expect(await loadStudioProjects()).toHaveLength(0);
  });
});
