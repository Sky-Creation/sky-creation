# Contact form

Purpose: how the `skycreation.dev` contact form sends mail, and the rule that
stops it ever claiming a send it did not make.

Read this when: you are changing `functions/contact.mjs`, `site/contact.html`
or the Brevo wiring.

## Shape

| | |
| --- | --- |
| Route | `POST /api/contact` → `/.netlify/functions/contact` |
| File | `functions/contact.mjs` (200 lines) |
| Provider | Brevo transactional email, `POST https://api.brevo.com/v3/smtp/email` |
| Client | `site/contact.html` + `site/assets/main.js` |

Other methods return `405`. The function is same-origin; there is no CORS
header because none is needed.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `BREVO_API_KEY` | yes | Brevo v3 key. Missing → `500 Server is not configured`. |
| `CONTACT_TO` | yes | recipient for submissions |
| `CONTACT_FROM` | no | verified Brevo sender; defaults to `CONTACT_TO` |

Both addresses are validated with the same email regex; if either is missing or
invalid the function returns `500` rather than attempting a send that will fail.
The visible address in `site/contact.html` and `CONTACT_TO`/`CONTACT_FROM` must
stay consistent, or mail is sent somewhere nobody reads.

`CONTACT_FROM` must be a sender verified in Brevo, or delivery fails. The
verified senders are `contact@`, `founder@` and `accountant@`
(`@skycreation.dev`).

## Request and limits

```json
{ "name": "...", "email": "...", "subject": "...", "message": "...", "company": "" }
```

| Field | Cap | Rule |
| --- | --- | --- |
| `name` | 120 | required |
| `email` | 200 | required, must match `EMAIL_RE` |
| `subject` | 150 | optional |
| `message` | 4000 | required |
| `company` | 200 | **honeypot** — must be empty |

`company` is a hidden field. Any non-empty value means a bot: the function logs
`contact: honeypot triggered, message discarded` and returns `{ "ok": true }`
**without sending**. That discard is logged on purpose — a message dropped
deliberately should be visible even though the bot is told it succeeded.

The whole body is capped at `MAX_BODY_BYTES = 16 * 1024` before any parsing, and
an oversized body returns `413` before anything is read. The field caps sum to
well under this, so a real message is never rejected.

Free text is passed through `clean()`: CRLF and control characters are stripped
(header-injection and markup bait), then the value is trimmed and truncated.

## Rate limit

Five submissions per IP per ten minutes via the shared
`exchange-lib/rate-limit.mjs` helper (Upstash sliding window in production;
in-memory under `SKY_EXCHANGE_TEST=1`). IPs are HMAC-hashed with
`RATE_LIMIT_HMAC_KEY`. Over the limit returns
`429 { error: "Too many requests. Try again later." }` with `Retry-After`.
Missing Upstash or HMAC configuration fails closed (`503`).

## Response codes

| Code | When |
| --- | --- |
| `200 {ok:true}` | sent, **or** honeypot discard |
| `400` | invalid JSON, or missing name / email / message |
| `405` | not a POST |
| `413` | body over 16 KB |
| `429` | rate limited |
| `500` | `BREVO_API_KEY` or the address config is missing/invalid |
| `502` | provider unreachable, or provider returned non-2xx |

On a provider failure the function logs the provider's body (truncated to 500
chars) — never the API key — and tells the user to email directly.

## The rule: never show "sent" without a send

The form once had a "minimum fill time" gate on both client and server. It
showed "Message sent" without calling the API when the page was under ~1.2 s
old, silently losing real enquiries from autofill and password managers, and it
never stopped bots because it trusted a caller-supplied timestamp (commit
`9f45f61`).

**Do not re-add any timing gate.** The defences that actually work are the
honeypot and the per-IP rate limit. `test/contact.test.mjs` and
`test/main.test.mjs` assert the invariants:

- a fast submission **must** send;
- the honeypot is the **only** success-without-sending path.

See [`decisions.md`](decisions.md) and `AGENTS.md` §4.

## Changing it

- Edit the field caps, honeypot name or copy in `functions/contact.mjs`.
- If you rename the honeypot field, update the hidden input in
  `site/contact.html` **and** the tests. Honeypot detection only works while the
  field name is not public — which is one reason the function is not published
  under `site/`.
- Add or adjust the assertions in `test/contact.test.mjs`; CI runs them on every
  push.
