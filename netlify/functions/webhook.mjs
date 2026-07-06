/**
 * Netlify Function: webhook (Stripe)
 *
 * Listens for Stripe webhook events.  Currently handles:
 *   - checkout.session.completed  → order confirmation (log / email)
 *
 * Required environment variables:
 *   STRIPE_SECRET_KEY          — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET      — Stripe webhook signing secret (whsec_...)
 *
 * To set up:
 *   1. In the Stripe Dashboard → Developers → Webhooks, add an endpoint:
 *        https://slingsandarrows.band/api/webhook
 *   2. Select the event: checkout.session.completed
 *   3. Copy the signing secret into STRIPE_WEBHOOK_SECRET in Netlify env vars.
 */

import Stripe from 'stripe';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const stripeKey     = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    console.error('[webhook] Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return new Response('Webhook not configured', { status: 503 });
  }

  const stripe    = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
  const signature = req.headers.get('stripe-signature');

  let event;
  try {
    const rawBody = await req.text();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return new Response(`Webhook error: ${err.message}`, { status: 400 });
  }

  // ── Handle events ─────────────────────────────────────────────────────────
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;

      // Retrieve line items for the fulfilled order
      let lineItems;
      try {
        const result = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
        lineItems = result.data;
      } catch (err) {
        console.error('[webhook] Could not retrieve line items:', err.message);
      }

      console.log('[webhook] Order completed:', {
        sessionId:      session.id,
        customerEmail:  session.customer_details?.email,
        amountTotal:    session.amount_total,
        currency:       session.currency,
        lineItems:      lineItems?.map(li => ({ name: li.description, qty: li.quantity })),
        shippingAddress: session.shipping_details?.address,
      });

      // TODO: Send a confirmation email via SendGrid / Postmark / etc.
      // Example with fetch to a transactional email API:
      //
      // await fetch('https://api.sendgrid.com/v3/mail/send', {
      //   method: 'POST',
      //   headers: {
      //     Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      //     'Content-Type': 'application/json',
      //   },
      //   body: JSON.stringify({
      //     personalizations: [{ to: [{ email: session.customer_details.email }] }],
      //     from: { email: 'orders@slingsandarrows.band', name: 'Slings & Arrows' },
      //     subject: 'Your order is confirmed!',
      //     content: [{ type: 'text/plain', value: 'Thanks for your order!' }],
      //   }),
      // });

      break;
    }

    default:
      // Ignore other event types
      console.log(`[webhook] Unhandled event type: ${event.type}`);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/webhook' };
