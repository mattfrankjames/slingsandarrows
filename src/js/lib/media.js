/**
 * media.js — uploading to Cloudinary, signed.
 *
 * Previously each page built its own FormData with `upload_preset` read from
 * `process.env.CLOUDINARY_UPLOAD_PRESET`. Parcel inlines those values at build
 * time, so the preset and cloud name were literals in the public bundles —
 * enough for anyone to upload to this Cloudinary account from anywhere, with no
 * sign-in required.
 *
 * Now the browser holds no upload credential at all. It asks the server for a
 * one-shot signature, which requires a valid session, and sends that instead.
 */

import { getToken } from './session.js';

/**
 * Upload a File or Blob to Cloudinary and return the raw Cloudinary response.
 *
 * Uses the `auto` resource type so images, video and audio all work through one
 * path — callers depend on `secure_url` and `resource_type` in the result.
 *
 * @param {File | Blob} file
 * @returns {Promise<{ secure_url: string, resource_type: string, [k: string]: unknown }>}
 */
export async function uploadToCloudinary(file) {
  const token = await getToken();
  if (!token) throw new Error('Sign in to upload media');

  const signRes = await fetch('/api/cloudinary-sign', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!signRes.ok) {
    if (signRes.status === 401) throw new Error('Your session expired — sign in again');
    throw new Error('Could not start the upload. Try again in a moment.');
  }

  const { cloudName, apiKey, timestamp, signature } = await signRes.json();

  const fd = new FormData();
  fd.append('file', file);
  fd.append('api_key', apiKey);
  fd.append('timestamp', timestamp);
  fd.append('signature', signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
    { method: 'POST', body: fd }
  );

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Upload failed (${res.status})`);
  }

  return res.json();
}
