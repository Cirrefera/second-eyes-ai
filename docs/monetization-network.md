# Cloudflare Monetization Network — enrollment on record

Verified 2026-11-20 against the Cloudflare API (account + zone eligibility,
payment rules):

- Account monetization eligibility: **approved**
- Zone (`secondeyesai.com`) eligibility: **approved**
- Active payment rule `e89420bd256a4b559f6db8aa6bda9d68` ("Rule 1", enabled):
  - Expression: GET on all paths, limited to AI-crawler user agents —
    GPTBot, ClaudeBot, PerplexityBot, CCBot, meta-externalagent
  - Scheme: `exact`, price `1000` atomic units = $0.001 USDC
    (the facilitator's minimum for a 6-decimal token)
  - Pay-to: `0xFb8915074cC941f5Ab95E6001c45287b8EeC4427` — the same
    address as `X402_PAYTO_PUBLIC` in `wrangler.toml`

## Edge challenge — how it fires, and proof it fires (2026-11-20)

The rule only matches **BotBase-verified bot traffic** (`cf.client.bot`) with one
of the five crawler UAs on GET. It cannot be fired by hand from a normal
network: a spoofed `User-Agent: GPTBot` probe passes straight to origin
(verified live). Monetization Gateway has no simulate/test mode, and mutating
the production rule to fake a test was ruled out by the owner (not compliant).

It does not need a manual fire — **production data shows it already fires**.
Zone analytics (`events.httpRequests`), Nov 1–20, edge 402s where the request
never reached origin:

- GPTBot (OpenAI, verified): 25 challenges
- ClaudeBot (Anthropic, verified): 5 challenges
- meta-externalagent (Meta, verified): 1 challenge

A spoofed bare-`GPTBot` UA in the same window shows origin=402 pass-throughs
(the app-layer doors answering, no toll) — the verified-bot gate works in both
directions.

To watch it ongoing:

```
cf sql query "SELECT userAgent AS ua, originResponseStatus AS origin, count() AS n
  FROM events.httpRequests WHERE edgeResponseStatus = 402 AND (userAgent LIKE '%GPTBot%'
  OR userAgent LIKE '%ClaudeBot%' OR userAgent LIKE '%PerplexityBot%' OR userAgent LIKE '%CCBot%'
  OR userAgent LIKE '%meta-externalagent%') GROUP BY ua, origin ORDER BY n DESC"
  --scope-zone <zone_id> --time-since <RFC3339>
```

Settlements are USDC-on-Base transfers to the payTo address above.

## PAYMENT-CONTEXT origin validation (docs requirement — intentionally not implemented)

Cloudflare's docs say the origin "must validate" the `PAYMENT-CONTEXT` JWT
(Ed25519, pinned JWKS, `jose`) on gateway-forwarded paid requests. This repo
does **not** validate it, and that is currently not load-bearing: no origin
resource is contingent on the edge toll (free surfaces are public; paid doors
gate themselves with their own app-layer 402s), and the gateway settles the
toll before ever forwarding. If origin content is ever gated on the edge toll,
add `jose`-based PAYMENT-CONTEXT validation first (reject when absent).

## Notes for future agents (do not re-chase)

1. **Enrollment is a zone-level Cloudflare setting**, managed through the
   Monetization API / dashboard — not through this repo. To re-check:
   `GET /zones/{zone_id}/monetization` (eligibility) and
   `GET /zones/{zone_id}/monetization/rules` (rules). The Cloudflare
   monetization payment rail and the app-level x402 402-challenge doors in
   `functions/` are two separate layers; both are live and intended.
2. **Root `package.json` intentionally omits `@x402/*`** (owner ruling
   2026-11-20: the x402 situation is fine; do not re-import the old
   dependency diff from the retired checkouts). The x402 client imports in
   `scripts/` resolve from the local `node_modules` install, and the
   server-side 402 challenge is implemented by hand in
   `functions/_lib/x402.js` — the deployed Functions have no external
   x402 dependency. Deployed-drift and payment behavior are already guarded
   by `scripts/payload-contract-selftest.mjs --live` (207 checks).
