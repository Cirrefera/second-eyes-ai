/**
 * Shared micro-utils for the lounge functions: JSON responses, ISO timestamps,
 * and collision-resistant id minting. Extracted from the retired review module
 * when the legacy review/research stack was excised (2026-11-20).
 */

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}
