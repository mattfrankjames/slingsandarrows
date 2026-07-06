import { getStore } from '@netlify/blobs';

function getUserFromRequest(req, context) {
  if (context.clientContext?.user) {
    return context.clientContext.user;
  }

  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    return decoded.email ? { email: decoded.email } : null;
  } catch {
    return null;
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    // ── Authentication ────────────────────────────────────────────────────
    const user = getUserFromRequest(req, context);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Authorization ─────────────────────────────────────────────────────
    const allowed = (process.env.ALLOWED_AUTHORS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    if (!allowed.includes((user.email || '').toLowerCase())) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Parse body ────────────────────────────────────────────────────────
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { mediaUrl, caption, mediaType } = body;

    if (!mediaUrl || !mediaUrl.trim()) {
      return new Response(JSON.stringify({ error: 'mediaUrl is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only allow Cloudinary URLs
    const rawUrl = mediaUrl.trim();
    if (!rawUrl.startsWith('https://res.cloudinary.com/')) {
      return new Response(JSON.stringify({ error: 'Only Cloudinary URLs are accepted' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Derive media type from URL if not provided
    const resolvedType = mediaType ||
      (rawUrl.includes('/video/upload/') ? 'video' : 'image');

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const item = {
      id,
      mediaUrl: rawUrl,
      mediaType: resolvedType,
      caption: (caption || '').trim(),
      author: user.email,
      createdAt: new Date().toISOString(),
    };

    const store = getStore('gallery');
    await store.setJSON(id, item);

    return new Response(JSON.stringify(item), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('gallery-add error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/gallery/add' };
