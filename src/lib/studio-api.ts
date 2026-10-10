import { studioBriefSchema, studioJobSchema, type StudioBrief, type StudioBriefInput, type StudioJob } from '../../shared/studio';
import { ApiError, apiHeaders, rejectApiResponse } from './api';

async function request(path: string, body: unknown | undefined, signal?: AbortSignal, timeout = 20_000): Promise<unknown> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  try {
    const response = await fetch(`/api/studio${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: apiHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'same-origin', signal: requestSignal, cache: 'no-store',
    });
    if (!response.ok) return await rejectApiResponse(response);
    return await response.json();
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    if (requestSignal.aborted) throw new ApiError('La risposta ha impiegato troppo tempo. Recupera il risultato prima di avviare una nuova generazione.', 504, 'STUDIO_TIMEOUT');
    throw new ApiError('La connessione si è interrotta. Il progetto è conservato; puoi recuperare il risultato senza inviare un’altra generazione.', 0, 'STUDIO_NETWORK_ERROR');
  }
}
export async function createStudioBrief(input: StudioBriefInput, signal?: AbortSignal): Promise<StudioBrief> {
  const result = studioBriefSchema.safeParse(await request('/brief', input, signal, 65_000));
  if (!result.success) throw new ApiError('La proposta ricevuta non è leggibile. Puoi riprovare a preparare l’atmosfera.', 502, 'STUDIO_INVALID_BRIEF');
  return result.data;
}
function parseJob(value: unknown): StudioJob {
  const result = studioJobSchema.safeParse(value);
  if (!result.success) throw new ApiError('Il risultato ricevuto non è leggibile. Recupera il progetto prima di creare una nuova immagine.', 502, 'STUDIO_INVALID_JOB');
  return result.data;
}
export async function startStudioGeneration(requestId: string, brief: StudioBrief, signal?: AbortSignal): Promise<StudioJob> {
  // Establish the browser owner before any paid call, including when the POST acknowledgement is lost.
  await request('/session', {}, signal);
  return parseJob(await request('/jobs', { requestId, brief }, signal));
}
export async function getStudioJob(id: string, signal?: AbortSignal): Promise<StudioJob> {
  return parseJob(await request(`/jobs/${encodeURIComponent(id)}`, undefined, signal));
}
export async function cancelStudioJob(id: string, signal?: AbortSignal): Promise<StudioJob> {
  return parseJob(await request(`/jobs/${encodeURIComponent(id)}/cancel`, {}, signal));
}
