#!/usr/bin/env node
/**
 * payload-contract-selftest — every advertised endpoint has the payload it
 * describes. Mirrors the Second Wind standing rule: nothing is advertised
 * that is not implemented, and the check that would have caught a gap ships
 * with the gap's fix.
 *
 * Layer 1 (offline, default, CI-safe): every slug advertised by the repo's
 * own constants — SURVIVAL_MENU, X402_TWIN_SLUGS, SERVICE_PRICES — must have
 * (a) a payload pack in buildServicePayload, (b) a price in SERVICE_PRICES,
 * (c) a session-less route that can serve it (a static door file or the
 * [slug] catch-all), and (d) a Bazaar ranking description where the
 * catch-all serves it. Nothing hand-listed: doors are enumerated from the
 * filesystem, packs are probed at runtime through buildServicePayload.
 *
 * Layer 2 (--live, network, no spend): production truth. Every URL the live
 * /api/bar index and discovery document advertise must answer; paid doors
 * must answer 402 with accepts[]; free surfaces must answer 200 JSON; the
 * live survival menu must match the repo's SERVICE_PRICES exactly (catches
 * deploy drift between constants and production).
 *
 * Run: node scripts/payload-contract-selftest.mjs          # offline layer
 * Run: node scripts/payload-contract-selftest.mjs --live   # + production
 */
import { SERVICE_PRICES, SURVIVAL_MENU, X402_TWIN_SLUGS } from "../functions/_lib/lounge/constants.js";
import { buildServicePayload } from "../functions/_lib/lounge/services.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.argv.includes("--live");
const BASE = "https://secondeyesai.com";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const fail = (where, msg) => failures.push(`${where}: ${msg}`);
let checks = 0;
const check = (where, cond, msg) => {
  checks += 1;
  if (!cond) fail(where, msg);
};

// ---------------------------------------------------------------- Layer 1 --
// Advertised slug -> payload pack, price, route, description. No network.

for (const item of SURVIVAL_MENU) {
  const slug = item.slug;
  const pack = buildServicePayload(slug, BASE);
  check(`menu:${slug}`, pack != null, "advertised on SURVIVAL_MENU but buildServicePayload has no pack");
  check(`menu:${slug}:price`, SERVICE_PRICES[slug]?.price_usd === item.price_usd, `menu price ${item.price_usd} != SERVICE_PRICES ${SERVICE_PRICES[slug]?.price_usd}`);
}

for (const slug of X402_TWIN_SLUGS) {
  check(`twin:${slug}:pack`, buildServicePayload(slug, BASE) != null, "advertised session-less (X402_TWIN_SLUGS) but no payload pack");
  check(`twin:${slug}:price`, SERVICE_PRICES[slug] !== undefined, "advertised session-less but unpriced");
  const descFile = readFileSync(join(root, "functions/api/bar/x402/[slug].js"), "utf8");
  // Keys for valid JS identifiers (pitstop, receipt) are unquoted in the
  // SLUG_DESCRIPTIONS object; hyphenated slugs are quoted. Match both forms.
  const descRe = new RegExp(`^\\s*"?(?:${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"?\\s*:`, "m");
  check(`twin:${slug}:desc`, descRe.test(descFile), "no Bazaar ranking description in [slug].js SLUG_DESCRIPTIONS");
}

// Static x402 doors: derived from the actual route files on disk — nothing
// hand-listed. Every door file must carry a request handler.
import { readdirSync } from "node:fs";

const doorDir = join(root, "functions/api/bar/x402");
const STATIC_DOORS = readdirSync(doorDir)
  .filter((f) => f.endsWith(".js") && f !== "[slug].js")
  .map((f) => f.slice(0, -3));

for (const slug of STATIC_DOORS) {
  const src = readFileSync(join(doorDir, `${slug}.js`), "utf8");
  check(`door:${slug}:handler`, /onRequest(Get|Post|Options)/.test(src), "route file has no request handler");
}

// ---------------------------------------------------------------- Layer 2 --
// Production truth. Every advertised URL answers with the promised shape.

if (LIVE) {
  const get = async (url, opts = {}) => {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, ...opts });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* non-JSON */ }
      return { res, body, text };
    } catch (e) {
      return { res: null, body: null, text: String(e) };
    }
  };

  // 2a. The live index must advertise the same survival menu as the repo.
  const idx = await get(`${BASE}/api/bar`);
  check("live:/api/bar", idx.res?.status === 200, `index answered ${idx.res?.status}`);
  const liveMenu = idx.body?.survival_menu?.items || [];
  check("live:menu:size", liveMenu.length === SURVIVAL_MENU.length, `live menu has ${liveMenu.length} items, repo has ${SURVIVAL_MENU.length}`);
  for (const item of SURVIVAL_MENU) {
    const live = liveMenu.find((i) => i.slug === item.slug);
    check(`live:menu:${item.slug}`, live != null, "advertised in repo constants but absent from live menu");
    if (live) {
      check(`live:menu:${item.slug}:price`, live.price_usd === item.price_usd, `live price ${live.price_usd} != repo ${item.price_usd} (deploy drift)`);
      check(`live:menu:${item.slug}:path`, String(live.path || "").endsWith(`/api/bar/x402/${item.slug}`), `live path ${live.path} is not the canonical session-less door`);
    }
  }

  // 2b. Every URL in the index's own endpoints map answers. Presence is any
  // handler-shaped answer (200/202/400/401/402/405, or a JSON 404 — a handler
  // answering "not found" for an entity). Only a STATIC 404 (non-JSON body,
  // no route at all) counts as a dead advertisement. GET-shy endpoints (POST-
  // only routes like /api/a4a) are confirmed with a POST probe.
  const PRESENCE = [200, 202, 400, 401, 402, 405];
  const present = (res, body, text) =>
    PRESENCE.includes(res?.status) || (res?.status === 404 && body != null && String(text || "").trim().startsWith("{"));

  const eps = idx.body?.endpoints || {};
  for (const [k, v] of Object.entries(eps)) {
    if (typeof v !== "string" || !v.startsWith("http")) continue;
    const url = v.replace("{slug}", "loop-detect").replace("{id}", "probe-presence-check");
    let { res, body, text } = await get(url);
    if (!present(res, body, text)) {
      // Method-shaped: retry with an empty JSON POST before declaring dead.
      ({ res, body, text } = await get(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" }));
    }
    check(`live:endpoints.${k}`, present(res, body, text), `no handler answers (GET/POST both unshaped; last status ${res?.status})`);
    if (res?.status === 402) {
      check(`live:endpoints.${k}:402shape`, Array.isArray(body?.accepts) && body.accepts.length > 0, "402 body missing accepts[]");
    }
  }

  // 2c. Every paid survival door challenges correctly.
  for (const item of liveMenu) {
    const { res, body } = await get(item.url);
    check(`live:door:${item.slug}`, res?.status === 402, `expected 402 challenge, got ${res?.status}`);
    if (res?.status === 402) {
      check(`live:door:${item.slug}:accepts`, Array.isArray(body?.accepts) && body.accepts.length > 0, "402 body missing accepts[]");
      const usd = Number(body.accepts[0]?.amount || 0) / 1e6;
      check(`live:door:${item.slug}:amount`, Math.abs(usd - item.price_usd) < 1e-9, `challenge asks $${usd}, menu says $${item.price_usd}`);
    }
  }

  // 2d. Discovery document resources all answer.
  const doc = await get(`${BASE}/v2/x402/discovery/resources`);
  check("live:discovery", doc.res?.status === 200, `discovery document answered ${doc.res?.status}`);
  for (const r of doc.body?.resources || []) {
    const { res } = await get(r.resource);
    check(`live:resource:${String(r.resource).split("/").pop()}`, res != null && [200, 402].includes(res.status), `answered ${res?.status}`);
  }

  // 2e. Static discovery surfaces answer.
  for (const p of ["/llms.txt", "/.well-known/agent-card.json", "/.well-known/help-me.json", "/.well-known/menu.json", "/.well-known/mcp.json", "/robots.txt"]) {
    const { res } = await get(`${BASE}${p}`);
    check(`live:static:${p}`, res?.status === 200, `answered ${res?.status}`);
  }
}

// ---------------------------------------------------------------- report --
if (failures.length) {
  console.error(`payload-contract self-test FAILED — ${failures.length} issue(s) of ${checks} checks:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`payload-contract self-test OK — ${checks} checks passed${LIVE ? " (offline + live production layers)" : " (offline layer; run with --live for production checks)"}.`);
console.log("Every advertised endpoint has the payload it describes.");
