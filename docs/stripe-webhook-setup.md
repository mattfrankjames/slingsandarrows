# Stripe Webhook Setup

## One-time setup: create the webhook endpoint in Stripe

1. Go to the [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **"Add endpoint"**
3. Fill in:
   - **Endpoint URL:** `https://slingsandarrows.band/api/webhook`
   - **Events to listen to:** select `checkout.session.completed`
4. Click **"Add endpoint"** to save
5. On the endpoint detail page, click **"Reveal"** under **Signing secret**
6. Copy the value (starts with `whsec_...`)

## Add the secret to Netlify

1. Go to **Netlify → Site configuration → Environment variables**
2. Add a new variable:
   - **Key:** `STRIPE_WEBHOOK_SECRET`
   - **Value:** the `whsec_...` value you copied above
3. **Redeploy** the site so the new env var is picked up
   (Netlify → Deploys → Trigger deploy → Deploy site)

## How it works

When a customer completes checkout, Stripe sends a `POST` to
`https://slingsandarrows.band/api/webhook`. The Netlify function at
`netlify/functions/webhook.mjs`:

1. Reads the raw request body (required for signature verification)
2. Verifies the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`
3. Handles the `checkout.session.completed` event — currently logs the order;
   add email/fulfillment logic in the `TODO` block inside the switch statement

## Testing locally

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then:

```bash
stripe listen --forward-to http://localhost:8888/api/webhook
```

This gives you a temporary `whsec_...` secret to use for local testing.
Trigger a test event with:

```bash
stripe trigger checkout.session.completed
```

## Environment variables summary

| Variable                | Where to get it                        | Required |
|-------------------------|----------------------------------------|----------|
| `STRIPE_PUBLIC_KEY`     | Stripe Dashboard → API keys            | ✅        |
| `STRIPE_SECRET_KEY`     | Stripe Dashboard → API keys            | ✅        |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks → endpoint | ✅        |
| `STRIPE_CURRENCY`       | Set to `usd` (default)                 | optional |
