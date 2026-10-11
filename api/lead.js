/**
 * POST /api/lead — the demo page's quote form posts here.
 *
 * Vercel Node serverless function, ESM, no dependencies. It validates the
 * submission, drops obvious bots, rate-limits one request per IP per minute
 * (best effort, in-memory), and forwards a compact fact sheet to TitanForce's
 * token ingest door (POST https://titanforcemovers.com/api/hooks/capture).
 * When RESEND_API_KEY, FAIRPRICE_ALERT_TO and FAIRPRICE_ALERT_FROM are set it
 * also emails a copy through Resend.
 *
 * Honest states: the browser only shows "received" when the upstream door
 * answered `received: true`. A missing TITANFORCE_CAPTURE_TOKEN is a 503
 * `{ received: false, reason: "not configured" }`. Nothing here logs a body,
 * a header or a secret; logs carry only event names and status codes.
 */

import { randomUUID } from "node:crypto";

const CAPTURE_URL = process.env.TITANFORCE_CAPTURE_URL || "https://titanforcemovers.com/api/hooks/capture";
const SOURCE_URL = "https://fairprice-titanforce-lead-page.vercel.app/";
const PROVIDER = "fairprice-page";
const CHANNEL = "marketplace";
const TEXT_MAX_CHARS = 4000;
const BODY_MAX_BYTES = 32 * 1024;
const RATE_WINDOW_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const HONEYPOT_FIELD = "company_website";

const HOME_SIZES = new Set([
  "studio",
  "1-bedroom",
  "2-bedroom",
  "3-bedroom",
  "4-bedroom-plus",
  "office",
  "storage-unit",
  "few-items",
]);

/** ip → last accepted request time. Per warm instance only; Vercel may run several. */
const lastSeen = new Map();

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : (forwarded || "").split(",")[0];
  const ip = (first || req.socket?.remoteAddress || "").trim();
  return ip || "unknown";
}

/** Browsers send Origin on cross-site POSTs; refuse any that is not this page's host. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  try {
    return new URL(origin).host === String(host).split(",")[0].trim();
  } catch {
    return false;
  }
}

function rateLimited(ip, now) {
  if (lastSeen.size > 1000) {
    for (const [key, at] of lastSeen) if (now - at > RATE_WINDOW_MS) lastSeen.delete(key);
  }
  const at = lastSeen.get(ip);
  if (at !== undefined && now - at < RATE_WINDOW_MS) return true;
  lastSeen.set(ip, now);
  return false;
}

/** Vercel parses JSON and form bodies into req.body; fall back to reading the stream. */
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") {
      if (Buffer.byteLength(JSON.stringify(req.body), "utf8") > BODY_MAX_BYTES) throw new Error("too large");
      return req.body;
    }
    if (typeof req.body === "string") {
      if (Buffer.byteLength(req.body, "utf8") > BODY_MAX_BYTES) throw new Error("too large");
      return parseRaw(req.body, req.headers["content-type"]);
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX_BYTES) throw new Error("too large");
    chunks.push(chunk);
  }
  return parseRaw(Buffer.concat(chunks).toString("utf8"), req.headers["content-type"]);
}

function parseRaw(raw, contentType = "") {
  if (!raw.trim()) return {};
  if (String(contentType).includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
}

function str(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** US numbers only → "+1XXXXXXXXXX"; anything else → null. */
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  if (national[0] === "0" || national[0] === "1") return null;
  return `+1${national}`;
}

function formatPhone(e164) {
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function validEmail(value) {
  const email = str(value, 160).toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) ? email : false;
}

/** YYYY-MM-DD, not more than a year back or two years ahead. Empty is allowed. */
function validMoveDate(value) {
  const text = str(value, 20);
  if (!text) return { ok: true, value: "" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false };
  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return { ok: false };
  const now = Date.now();
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  if (date.getTime() < now - yearMs || date.getTime() > now + 2 * yearMs) return { ok: false };
  return { ok: true, value: text };
}

/** Returns { ok: true, lead } or { ok: false, fields: [...] }. Never echoes values. */
function validate(body) {
  const fields = [];
  const name = str(body.name, 80);
  if (name.length < 2) fields.push("name");

  const phone = normalizePhone(body.phone);
  if (!phone) fields.push("phone");

  const email = validEmail(body.email);
  if (email === false) fields.push("email");

  const moveDate = validMoveDate(body.moveDate ?? body.move_date);
  if (!moveDate.ok) fields.push("moveDate");

  const fromPlace = str(body.fromPlace ?? body.from_place ?? body.from, 80);
  if (fromPlace.length < 2) fields.push("fromPlace");

  const toPlace = str(body.toPlace ?? body.to_place ?? body.to, 80);
  if (toPlace.length < 2) fields.push("toPlace");

  const homeSize = str(body.homeSize ?? body.home_size, 32);
  if (!HOME_SIZES.has(homeSize)) fields.push("homeSize");

  const notes = typeof body.notes === "string" ? body.notes.replace(/\r\n?/g, "\n").trim().slice(0, 1000) : "";

  if (fields.length) return { ok: false, fields };
  return { ok: true, lead: { name, phone, email: email || "", moveDate: moveDate.value, fromPlace, toPlace, homeSize, notes } };
}

const HOME_SIZE_LABEL = {
  "studio": "Studio",
  "1-bedroom": "1 bedroom",
  "2-bedroom": "2 bedrooms",
  "3-bedroom": "3 bedrooms",
  "4-bedroom-plus": "4+ bedrooms",
  "office": "Office / commercial",
  "storage-unit": "Storage unit",
  "few-items": "A few items only",
};

/** The compact fact sheet the Desk reads. Starts with the fixed first line; never over TEXT_MAX_CHARS. */
function factSheet(lead, receivedAt) {
  const lines = [
    "Fairprice demo page inquiry",
    `Name: ${lead.name}`,
    `Phone: ${formatPhone(lead.phone)} (${lead.phone})`,
    `Email: ${lead.email || "not given"}`,
    `Move date: ${lead.moveDate || "not given"}`,
    `From: ${lead.fromPlace}`,
    `To: ${lead.toPlace}`,
    `Home size: ${HOME_SIZE_LABEL[lead.homeSize] || lead.homeSize}`,
    `Submitted: ${receivedAt}`,
    `Page: ${SOURCE_URL}`,
    "Source: FairPrice Movers Reading demo page. The customer asked FairPrice for a quote; call back, then coordinate the job with FairPrice.",
  ];
  const notesHeader = "Notes: ";
  let text = lines.join("\n");
  if (lead.notes) {
    const room = TEXT_MAX_CHARS - text.length - 1 - notesHeader.length;
    if (room > 20) text += `\n${notesHeader}${lead.notes.slice(0, room)}`;
  }
  return text.slice(0, TEXT_MAX_CHARS);
}

async function fetchWithTimeout(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Forward to TitanForce's ingest door. Returns { ok: true, id } or { ok: false, status }. */
async function forwardToTitanForce(token, lead, receivedAt, externalId) {
  const payload = {
    channel: CHANNEL,
    provider: PROVIDER,
    externalId,
    from: lead.phone || lead.email,
    text: factSheet(lead, receivedAt),
    receivedAt,
    sourceUrl: SOURCE_URL,
  };
  let response;
  try {
    response = await fetchWithTimeout(
      CAPTURE_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      },
      UPSTREAM_TIMEOUT_MS,
    );
  } catch (error) {
    console.error(`[lead] upstream unreachable: ${error?.name || "error"}`);
    return { ok: false, status: 0 };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.ok && data && data.received === true) {
    return { ok: true, id: typeof data.id === "string" ? data.id : externalId, status: data.status };
  }
  console.error(`[lead] upstream refused: http ${response.status}`);
  return { ok: false, status: response.status };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Best-effort copy by Resend. Returns "sent" | "failed" | "skipped". Never throws. */
async function emailCopy(lead, receivedAt, externalId) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.FAIRPRICE_ALERT_TO;
  const from = process.env.FAIRPRICE_ALERT_FROM;
  if (!key || !to || !from) return "skipped";
  const text = factSheet(lead, receivedAt);
  const body = {
    from,
    to: to.split(",").map((s) => s.trim()).filter(Boolean),
    subject: `Fairprice demo page inquiry: ${lead.name} (${lead.fromPlace} to ${lead.toPlace})`,
    text,
    html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    headers: { "X-Entity-Ref-ID": externalId },
  };
  try {
    const response = await fetchWithTimeout(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      },
      UPSTREAM_TIMEOUT_MS,
    );
    if (response.ok) return "sent";
    console.error(`[lead] resend refused: http ${response.status}`);
    return "failed";
  } catch (error) {
    console.error(`[lead] resend unreachable: ${error?.name || "error"}`);
    return "failed";
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { received: false, reason: "method not allowed" });
  }

  const token = (process.env.TITANFORCE_CAPTURE_TOKEN || "").trim();
  if (token.length < 32) {
    console.error("[lead] TITANFORCE_CAPTURE_TOKEN missing or shorter than 32 chars");
    return json(res, 503, { received: false, reason: "not configured" });
  }

  if (!sameOrigin(req)) return json(res, 403, { received: false, reason: "forbidden" });

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "too large";
    return json(res, tooLarge ? 413 : 400, { received: false, reason: tooLarge ? "too large" : "invalid body" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, { received: false, reason: "invalid body" });
  }

  // Honeypot: a hidden field real people never see. Bots that fill it get a quiet refusal.
  if (str(body[HONEYPOT_FIELD], 10)) return json(res, 400, { received: false, reason: "rejected" });

  const checked = validate(body);
  if (!checked.ok) return json(res, 400, { received: false, reason: "invalid fields", fields: checked.fields });

  const now = Date.now();
  if (rateLimited(clientIp(req), now)) return json(res, 429, { received: false, reason: "rate limited" });

  const receivedAt = new Date(now).toISOString();
  const externalId = randomUUID();
  const forwarded = await forwardToTitanForce(token, checked.lead, receivedAt, externalId);

  if (!forwarded.ok) {
    if (forwarded.status === 503) return json(res, 503, { received: false, reason: "not configured" });
    if (forwarded.status === 429) return json(res, 429, { received: false, reason: "rate limited" });
    return json(res, 502, { received: false, reason: "upstream" });
  }

  const copy = await emailCopy(checked.lead, receivedAt, externalId);
  console.log(`[lead] received id=${forwarded.id} copy=${copy}`);
  return json(res, 200, { received: true, id: forwarded.id, copy });
}
