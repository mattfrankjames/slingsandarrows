import { getStore } from '@netlify/blobs';

export const config = { path: '/api/request-invite' };

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { email } = await req.json();

    // Validate email
    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Invalid email' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const store = getStore('invite-requests');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    await store.setJSON(id, {
      id,
      email: email.toLowerCase().trim(),
      requestedAt: new Date().toISOString(),
      status: 'pending', // pending | invited | rejected
    });

    return new Response(JSON.stringify({
      success: true,
      message: "Invite request received! We'll review it shortly.",
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('request-invite error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
