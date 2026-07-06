/**
 * Netlify Function: create-checkout-session
 *
 * Creates a Stripe Checkout Session from the cart line items sent by the
 * merch page.  Returns the session URL (and ID) so the client can redirect.
 *
 * Required environment variables:
 *   STRIPE_SECRET_KEY  — your Stripe secret key (sk_live_... or sk_test_...)
 *
 * Optional:
 *   STRIPE_CURRENCY    — defaults to "usd"
 */

import Stripe from 'stripe';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[create-checkout-session] STRIPE_SECRET_KEY is not set');
    return new Response(JSON.stringify({ error: 'Payment service not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { lineItems, successUrl, cancelUrl } = body;

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return new Response(JSON.stringify({ error: 'lineItems is required and must be a non-empty array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!successUrl || !cancelUrl) {
    return new Response(JSON.stringify({ error: 'successUrl and cancelUrl are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    const currency = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();

    // Build Stripe line_items array.
    // If a product has a stripePriceId, use it directly (preferred — uses your
    // Stripe-configured price).  Otherwise, build a price_data object on the
    // fly from the cart item's name and price (cents).
    const stripeLineItems = lineItems.map(item => {
      if (item.stripePriceId) {
        return {
          price:    item.stripePriceId,
          quantity: item.quantity || 1,
        };
      }

      // Dynamic price — no pre-configured Stripe price
      const productName = item.size
        ? `${item.name} (${item.size})`
        : item.name;

      return {
        price_data: {
          currency,
          unit_amount: item.price,
          product_data: {
            name: productName,
          },
        },
        quantity: item.quantity || 1,
      };
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: stripeLineItems,
      mode: 'payment',
      success_url: successUrl,
      cancel_url:  cancelUrl,
      // Collect shipping address — remove if you ship digitally or handle
      // fulfillment elsewhere.
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU'],
      },
    });

    return new Response(JSON.stringify({ sessionId: session.id, url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[create-checkout-session] Stripe error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/create-checkout-session' };
