import { createHash } from 'node:crypto';
import { requireUser } from '../lib/auth.mjs';
import { route, json, noStore } from '../lib/http.mjs';

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
export default route(async req => {
  await requireUser(req);

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    // Deliberately not an HttpError: this is our misconfiguration, not the
    // caller's mistake, and it should read as a 500 in logs and metrics.
    throw new Error('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY or CLOUDINARY_API_SECRET is not set');
  }

  // Cloudinary's scheme: take every parameter that will be sent with the upload
  // except file, cloud_name, resource_type and api_key, sort by key, join as
  // k=v&k=v, append the API secret, and SHA-1 the result. We sign only a
  // timestamp, so the client cannot smuggle extra signed parameters past us.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash('sha1')
    .update(`timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  return json({ cloudName, apiKey, timestamp, signature }, 200, noStore);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/uploads/signature', '/api/cloudinary-sign'],
};
