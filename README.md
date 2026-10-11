# FairPrice Movers Reading demo page (TitanForce pilot)

A one-page inquiry site for FairPrice Movers' Reading, PA branch, built by TitanForce
Movers as a demo for a partnership pitch. It is **not live**: the Vercel project
`fairprice-titanforce-lead-page` is paused, the page is `noindex`, and nothing goes
public until FairPrice gives written approval of the copy, photos and routing.

What is in the repo:

| File | What it does |
|---|---|
| `index.html` | The page. Light, FairPrice-style (Roboto / Nunito, FairPrice red). Hero with click-to-call **(610) 628-2524** and a quote form, services, FairPrice's three-step process in their wording, real reviews (only sourced quotes, each with reviewer, platform and link), the Reading branch block (306 S 10th St, since 2011), FAQ, footer with fairpricemovers.com and one subtle line: "Labor crews on busy days by TitanForce Movers, Blandon PA · 484-291-7444". |
| `api/lead.js` | Vercel Node function (ESM, no dependencies). Validates the form, drops bots (honeypot), limits one request per IP per minute, then forwards a compact fact sheet to TitanForce's capture door `POST https://titanforcemovers.com/api/hooks/capture` with `Authorization: Bearer $TITANFORCE_CAPTURE_TOKEN`. Optional email copy through Resend. Never logs form contents. |
| `vercel.json` | Function timeout and security headers (`nosniff`, referrer policy, no framing). |
| `scripts/check-html.mjs` | Offline check: tag balance, ids, banned words (prices, insurance claims), only the two allowed phone numbers, every photo is a labelled placeholder. Run `npm run check`. |

Rules the page follows (owner rules, CLAUDE.md in titanforce-movers):

- No prices or dollar signs anywhere. FairPrice's own published hourly range is deliberately left out.
- No "insured", "licensed", "bonded", "certified" or "COI" written by us. FairPrice's own tagline is not repeated either.
- The only rating line is one that names its source and the number we checked: "4.8 on Google ... as relayed by moveBuddha (checked Oct 11, 2026)". The owner-stated "4.9 / 146 reviews" is in an HTML comment only, marked "verify on GBP before sending".
- Every review is a real quote from the research pack with reviewer, platform and link. No star counts are shown per review because the sources did not show them.
- Photos are hotlinked placeholders from fairpricemovers.com inside `<figure data-replace="Fairprice-supplied photo">`. They are FairPrice's photos; none is copied into this repo; all must be replaced with photos FairPrice supplies before launch. The FairPrice logo is not used (text wordmark instead).
- TitanForce appears only in the footer line. Labor only; TitanForce never provides, drives or arranges transport.
- Call-only CTAs. No `sms:` links.

## How a submission flows

1. Visitor fills the form. The browser posts JSON to `/api/lead` (same origin only).
2. `api/lead.js` checks `TITANFORCE_CAPTURE_TOKEN` is set (else **503 `not configured`**), validates fields, drops honeypot hits, rate-limits, then POSTs to the capture door:
   `{ channel: "marketplace", provider: "fairprice-page", externalId: <uuid>, from: <phone>, text: "Fairprice demo page inquiry\n...", receivedAt, sourceUrl }`.
3. Only when the door answers `received: true` does the page say "Received". Anything else shows **"Not sent. Call (610) 628-2524."**
4. On the TitanForce side the capture lands in Desk / Pipeline as a Marketplace request from provider `fairprice-page`. Yoga calls back and coordinates the job with FairPrice.
5. If `RESEND_API_KEY`, `FAIRPRICE_ALERT_TO` and `FAIRPRICE_ALERT_FROM` are all set, a copy of the fact sheet is emailed too (best effort, after the capture succeeded).

## Environment variables Yoga must set (both Vercel projects)

The same secret must exist in two places with two names:

| Vercel project | Variable | Value |
|---|---|---|
| `titanforce-movers-os` (titanforcemovers.com) | `CAPTURE_INGEST_TOKEN` | the shared token |
| `fairprice-titanforce-lead-page` (this repo) | `TITANFORCE_CAPTURE_TOKEN` | the **same** token |

Optional, on this project only:

| Variable | Purpose |
|---|---|
| `FAIRPRICE_ALERT_TO` | Email address(es) that get a copy of each inquiry (comma-separated). |
| `FAIRPRICE_ALERT_FROM` | Verified Resend sender, e.g. `FairPrice inquiries <inquiries@titanforcemovers.com>`. |
| `RESEND_API_KEY` | Resend API key. All three must be set or no email is sent. |
| `TITANFORCE_CAPTURE_URL` | Only for testing against a preview deployment of titanforce-movers. Leave unset in production. |

Steps, in order (only Yoga does these):

1. Make the token on your Mac, in Terminal: `openssl rand -hex 32` (64 characters; the door requires at least 32). Copy it. Do not paste it into chat, email or a text.
2. Vercel → project **titanforce-movers-os** → Settings → Environment Variables → add `CAPTURE_INGEST_TOKEN` = the token, Production environment. Save.
3. Vercel → titanforce-movers-os → Deployments → the current Production deployment → "..." → **Redeploy** (env vars apply only to new deployments). Wait for Ready. Check `https://titanforcemovers.com/api/health` still says ok.
4. Vercel → project **fairprice-titanforce-lead-page** → Settings → Environment Variables → add `TITANFORCE_CAPTURE_TOKEN` = the same token, Production. Add the three Resend variables if you want the email copy.
5. Vercel → fairprice-titanforce-lead-page → Settings → General → **Unpause** (or "Resume") the project, then Deployments → Redeploy the latest deployment so it picks up the variables.
6. Run the one test submission below. Pause the project again if anything is off.

## Testing with one TEST submission

1. Open `https://fairprice-titanforce-lead-page.vercel.app/` on your phone and on a laptop. Check: page is light, phone buttons dial (610) 628-2524, no horizontal scrolling at phone width, photos load (they are hotlinked from fairpricemovers.com and may change or disappear; that is expected for placeholders).
2. Fill the form with **your own** details and the name `TEST Yoga` so it is obvious: phone 484-291-7444, from `Blandon 19510`, to `Reading 19602`, home size "A few items only", notes `TEST submission from README, ignore`. Submit.
3. Expected on the page: the green "Received" message. If you see "Not sent. Call (610) 628-2524." the token is missing or does not match. Check both variables and that both projects were redeployed after setting them.
4. Expected on titanforcemovers.com: sign in, open Desk or Pipeline. A new capture "Marketplace request" from provider `fairprice-page` with the fact sheet text starting "Fairprice demo page inquiry". Dismiss it as a test afterwards.
5. If the Resend variables are set, the alert address gets an email with subject "Fairprice demo page inquiry: TEST Yoga (Blandon 19510 to Reading 19602)".
6. Submit again within a minute: expect "Not sent" (rate limit, 429). Wait a minute and it works again.

Rate limits upstream: the capture door allows 60 requests per 15 minutes per provider and 200 per 15 minutes overall. A real flood would be refused there too.

## Undo

- Pause the project: Vercel → fairprice-titanforce-lead-page → Settings → General → Pause. The URL returns a 503 and no form can submit. This is the one-click off switch.
- Rotate the token if it ever leaks: make a new one, set it in both projects, redeploy both.
- Remove the capture door entirely: delete `CAPTURE_INGEST_TOKEN` from titanforce-movers-os and redeploy; the door then answers 503 for everyone.

## Before any public launch (FairPrice's yes required)

- Written approval from FairPrice of the copy, the review selection and the routing (who gets the inquiries: their dispatcher, TitanForce, or both).
- FairPrice-supplied photos in every `<figure data-replace="Fairprice-supplied photo">` slot, hosted by them or in this repo with their permission; remove the "Placeholder" captions.
- FairPrice's logo file and permission to use it, if they want it in the header.
- Remove `<meta name="robots" content="noindex, nofollow">`.
- Confirm the 4.8 Google rating on their Google Business Profile the day it goes live (the page says "as relayed by moveBuddha").

## Local check

```
node --check api/lead.js
node scripts/check-html.mjs
```

No build step. No dependencies. Vercel serves `index.html` as the static root and `api/lead.js` as a Node function (`"type": "module"` in package.json makes it ESM).
