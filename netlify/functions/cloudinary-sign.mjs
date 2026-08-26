import { createHash } from 'node:crypto';
import { getUser } from '../lib/auth.mjs';

/**
 * Issue a short-lived Cloudinary upload signature to a signed-in user.
 *
 * Replaces the unsigned upload preset the client used to carry. Because Parcel
 * inlines `process.env` values at build time, that preset and the cloud name
 * were compiled into the public JS bundles — which is everything needed to
 * upload to this Cloudinary account from anywhere, with no sign-in and no limit
 * beyond the account's own. The secret now stays server-side and the browser
 * gets a signature that is only good for one upload.
 *
 * Authorization note: this requires a *signed-in* user, not an author. That
 * matches the least restrictive consumer — board replies let any signed-in user
 * attach media — while create-post and gallery-add still enforce the author
 * allowlist on the content itself. Uploading media and publishing it are
 * separate gates on purpose.
 */
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    console.error('[cloudinary-sign] Missing CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET');
    return new Response(JSON.stringify({ error: 'Upload is not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cloudinary's scheme: take every parameter that will be sent with the upload
  // except file, cloud_name, resource_type and api_key, sort by key, join as
  // k=v&k=v, append the API secret, and SHA-1 the result. We sign only a
  // timestamp, so the client cannot smuggle extra signed parameters past us.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash('sha1')
    .update(`timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  return new Response(JSON.stringify({ cloudName, apiKey, timestamp, signature }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};

export const config = { path: '/api/cloudinary-sign' };
