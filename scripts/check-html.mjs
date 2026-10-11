// Offline sanity check for index.html: tag balance, duplicate ids, label/for pairs,
// banned words for this page (prices, insurance claims), and no retired phone numbers.
// Run: node scripts/check-html.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
const problems = [];

// Strip comments, scripts and styles before looking at tags and words.
const stripped = html
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "path", "circle", "rect"]);
const stack = [];
const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/g;
let match;
let line = 1;
let lastIndex = 0;
while ((match = tagRe.exec(stripped))) {
  line += (stripped.slice(lastIndex, match.index).match(/\n/g) || []).length;
  lastIndex = match.index;
  const [raw, nameRaw] = match;
  const name = nameRaw.toLowerCase();
  if (raw.startsWith("</")) {
    const open = stack.pop();
    if (open !== name) problems.push(`line ${line}: closing </${name}> but open tag is <${open ?? "none"}>`);
  } else if (!VOID.has(name) && !raw.endsWith("/>")) {
    stack.push(name);
  }
}
if (stack.length) problems.push(`unclosed tags at end: ${stack.join(", ")}`);

const ids = [...stripped.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set();
for (const id of ids) {
  if (seen.has(id)) problems.push(`duplicate id "${id}"`);
  seen.add(id);
}
for (const [, target] of stripped.matchAll(/\sfor="([^"]+)"/g)) {
  if (!seen.has(target)) problems.push(`label for="${target}" has no matching id`);
}
for (const [, target] of stripped.matchAll(/href="#([^"]+)"/g)) {
  if (!seen.has(target)) problems.push(`anchor #${target} has no matching id`);
}

const text = stripped.replace(/<[^>]+>/g, " ");
const banned = [
  [/\$\s?\d/, "a dollar amount"],
  [/\b(insured|licensed|bonded|certified|COI)\b/i, "an insurance / license claim"],
  [/\bcrew of \d|\b\d+-(man|person) crew\b/i, "a crew size"],
];
for (const [re, label] of banned) {
  if (label && re.test(text)) problems.push(`page text contains ${label}: ${text.match(re)[0]}`);
}
const allowedPhones = new Set(["(610) 628-2524", "484-291-7444"]);
for (const [phone] of text.matchAll(/\(?\d{3}\)?[\s-]\d{3}-\d{4}/g)) {
  if (!allowedPhones.has(phone)) problems.push(`unexpected phone number in page text: ${phone}`);
}
for (const [, tel] of stripped.matchAll(/tel:(\+?[\d-]+)/g)) {
  if (!["+16106282524", "+14842917444"].includes(tel)) problems.push(`unexpected tel: link ${tel}`);
}
if (/sms:/i.test(stripped)) problems.push("sms: link present (call-only CTAs)");
if (!/<meta name="robots" content="noindex/.test(html)) problems.push("noindex meta missing (demo must stay unindexed)");

const figures = [...stripped.matchAll(/<figure[^>]*>/g)];
for (const [fig] of figures) {
  if (!/data-replace="Fairprice-supplied photo"/.test(fig)) problems.push(`figure without data-replace: ${fig}`);
}
for (const [img, src] of stripped.matchAll(/<img[^>]*src="([^"]+)"[^>]*>/g)) {
  if (!src.startsWith("https://fairpricemovers.com/wp-content/uploads/")) problems.push(`image not from the research pack: ${src}`);
  if (/san-jose|Niceville|pexels|iStock|istockphoto|call-center|unsplash|fp-movers-logo/i.test(src)) problems.push(`image the pack says to skip: ${src}`);
  if (!/\balt="/.test(img)) problems.push(`image without alt: ${src}`);
}

if (problems.length) {
  console.error(`check-html: ${problems.length} problem(s)`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`check-html: ok (${figures.length} photo placeholders, ${ids.length} ids, ${text.length} chars of text)`);
