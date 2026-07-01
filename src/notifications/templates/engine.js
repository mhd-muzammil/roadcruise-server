import { Channels } from "../config/events.js";

/**
 * Minimal, dependency-free template engine.
 *
 *   - {{path.to.value}} placeholders resolved from the context object.
 *   - Values are ESCAPED by channel to prevent injection:
 *       email   -> HTML entity escaping (anti-XSS in rendered mail)
 *       sms/wa  -> control-char stripping (anti header/format injection)
 *   - Compiled placeholder lists are cached per template string.
 *
 * A template definition is `{ subject?, html?, text? }` OR a function
 * `(ctx) => ({ subject?, html?, text? })` for conditional content. This is the
 * stable contract the template libraries (email/sms/whatsapp) build against.
 */
const cache = new Map();

const htmlEscape = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Strip ASCII control chars (U+0000–U+001F, U+007F) to block header/format
// injection in SMS/WhatsApp payloads; collapse runs of whitespace.
const textSanitize = (s) =>
  String(s)
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

// For email SUBJECTS: strip control chars (esp. CR/LF) to block header
// injection, but preserve characters/spacing so subjects render verbatim.
const headerSanitize = (s) => String(s).replace(/[\x00-\x1F\x7F]/g, "");

const getPath = (obj, path) =>
  path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);

function fill(tpl, ctx, escapeFn) {
  if (tpl == null) return tpl;
  if (!cache.has(tpl)) {
    cache.set(tpl, [...tpl.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]));
  }
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = getPath(ctx, path);
    if (v === undefined || v === null) return "";
    return escapeFn ? escapeFn(v) : String(v);
  });
}

/**
 * @returns {{subject?: string, body: string}}
 */
export function render(templateDef, channel, ctx) {
  const def = typeof templateDef === "function" ? templateDef(ctx) : templateDef;
  if (!def) throw new Error("Template definition is empty");

  if (channel === Channels.EMAIL) {
    return {
      subject: fill(def.subject || "", ctx, headerSanitize), // no HTML escape, but strip CR/LF
      body: fill(def.html || def.text || "", ctx, htmlEscape),
    };
  }
  // SMS / WhatsApp -> plain text
  return { body: fill(def.text || def.html || "", ctx, textSanitize) };
}

export const helpers = { htmlEscape, textSanitize };
export default render;
