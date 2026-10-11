import { createHash } from 'node:crypto';
import { getChatGPTUser } from '../../chatgpt-auth';
import { getCloudApp } from '../../../server/cloud-runtime';

async function handle(request: Request) {
  try {
    const user = await getChatGPTUser();
    // The Sites ingress verifies these identity headers; browser-selected IDs are never trusted.
    const ownerId = user ? `user-${createHash('sha256').update(user.userId).digest('hex')}` : undefined;
    return await getCloudApp()(request, { ownerId, clientId: request.headers.get('cf-connecting-ip') ?? 'unknown' });
  } catch {
    return Response.json({ code: 'SERVICE_UNAVAILABLE', error: 'Jemiq è momentaneamente non disponibile. Riprova tra poco; i cataloghi locali sono conservati.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
