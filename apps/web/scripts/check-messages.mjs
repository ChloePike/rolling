#!/usr/bin/env node
/**
 * Message catalog check (D-023). For every `messages/<locale>/` folder against `messages/en/`:
 * - errors (exit 1): ICU syntax errors in any locale (en included); a key defined twice in one
 *   file (JSON.parse would keep the last silently); a feature file or key that
 *   English does not have ("extra"); a placeholder, plural/select argument or tag English does not
 *   use; an argument used with another type (plural where English has select);
 * - warnings: keys English has and the locale lacks or leaves empty ("missing": they show in
 *   English, so other agents' new en keys never break a build); English arguments the
 *   translation drops; a stale email catalog (packages/core/src/email/catalog.gen.ts).
 *
 *   node apps/web/scripts/check-messages.mjs [--quiet]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

const here = dirname(fileURLToPath(import.meta.url));
export const MESSAGES_DIR = join(here, '../../../messages');

/** Arguments (name → kind) and tags a message uses. */
export function shape(message) {
  const args = new Map();
  const tags = new Set();
  const kind = (t) =>
    t === TYPE.plural ? 'plural' : t === TYPE.select ? 'select' : t === TYPE.number ? 'number' : t === TYPE.date ? 'date' : t === TYPE.time ? 'time' : 'argument';
  const walk = (els) => {
    for (const el of els) {
      if (el.type === TYPE.literal || el.type === TYPE.pound) continue;
      if (el.type === TYPE.tag) {
        tags.add(el.value);
        walk(el.children);
        continue;
      }
      if ('value' in el && typeof el.value === 'string') {
        const k = kind(el.type);
        // A plain {x} next to {x, number} is fine; keep the most specific kind.
        if (!args.has(el.value) || args.get(el.value) === 'argument') args.set(el.value, k);
      }
      if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) walk(o.value);
    }
  };
  walk(parse(message));
  return { args, tags };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Keys that appear more than once in a top-level JSON object. `JSON.parse` keeps the last one
 * silently, so this scans the raw text (strings and escapes aware, keys at depth 1 only).
 */
export function duplicateKeys(text) {
  const seen = new Set();
  const dups = new Set();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === '"') {
      let j = i + 1;
      let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          raw += text[j] + (text[j + 1] ?? '');
          j += 2;
        } else raw += text[j++];
      }
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (depth === 1 && text[k] === ':') {
        let key;
        try {
          key = JSON.parse(`"${raw}"`);
        } catch {
          key = raw;
        }
        if (seen.has(key)) dups.add(key);
        seen.add(key);
      }
      i = j;
    }
  }
  return [...dups];
}

function readChecked(path, where, errors) {
  const text = readFileSync(path, 'utf8');
  for (const key of duplicateKeys(text)) errors.push(`${where}: duplicate key ${key} (JSON keeps only the last)`);
  return JSON.parse(text);
}

function features(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

/** Runs the check; returns `{ errors, warnings, report }` (report: per locale counts and missing keys). */
export function checkMessages(messagesDir = MESSAGES_DIR) {
  const errors = [];
  const warnings = [];
  const report = {};
  const enDir = join(messagesDir, 'en');
  const en = {};
  const enShapes = {};
  for (const file of features(enDir)) {
    let data;
    try {
      data = readChecked(join(enDir, file), `en/${file}`, errors);
    } catch (e) {
      errors.push(`en/${file}: invalid JSON (${e.message})`);
      continue;
    }
    en[file] = data;
    for (const [key, value] of Object.entries(data)) {
      try {
        enShapes[key] = shape(value);
      } catch (e) {
        errors.push(`en/${file}: ${key}: ICU syntax error (${e.message})`);
      }
    }
  }
  const locales = readdirSync(messagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'en')
    .map((d) => d.name)
    .sort();
  for (const locale of locales) {
    const dir = join(messagesDir, locale);
    const r = (report[locale] = { translated: 0, missing: [], extra: [] });
    const files = features(dir);
    for (const file of files) {
      const where = `${locale}/${file}`;
      if (!en[file]) {
        errors.push(`${where}: no en/${file}`);
        continue;
      }
      let data;
      try {
        data = readChecked(join(dir, file), where, errors);
      } catch (e) {
        errors.push(`${where}: invalid JSON (${e.message})`);
        continue;
      }
      for (const [key, value] of Object.entries(data)) {
        if (!(key in en[file])) {
          r.extra.push(key);
          errors.push(`${where}: extra key ${key}`);
          continue;
        }
        if (typeof value !== 'string') {
          errors.push(`${where}: ${key}: not a string`);
          continue;
        }
        if (value === '') continue;
        let s;
        try {
          s = shape(value);
        } catch (e) {
          errors.push(`${where}: ${key}: ICU syntax error (${e.message})`);
          continue;
        }
        r.translated++;
        const base = enShapes[key];
        if (!base) continue;
        for (const [arg, kind] of s.args) {
          const want = base.args.get(arg);
          if (!want) errors.push(`${where}: ${key}: unknown argument {${arg}}`);
          else if (kind !== want && kind !== 'argument' && want !== 'argument') errors.push(`${where}: ${key}: {${arg}} is ${kind}, en has ${want}`);
        }
        for (const tag of s.tags) if (!base.tags.has(tag)) errors.push(`${where}: ${key}: unknown tag <${tag}>`);
        for (const arg of base.args.keys()) if (!s.args.has(arg)) warnings.push(`${where}: ${key}: drops {${arg}}`);
        for (const tag of base.tags) if (!s.tags.has(tag)) warnings.push(`${where}: ${key}: drops <${tag}>`);
      }
    }
    for (const [file, data] of Object.entries(en)) {
      const own = files.includes(file) && existsSync(join(dir, file)) ? safeRead(join(dir, file)) : {};
      for (const key of Object.keys(data)) if (typeof own[key] !== 'string' || own[key] === '') r.missing.push(key);
    }
    if (r.missing.length) warnings.push(`${locale}: ${r.missing.length} missing key(s), shown in English`);
  }
  return { errors, warnings, report, locales };
}

function safeRead(path) {
  try {
    return readJson(path);
  } catch {
    return {};
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const quiet = process.argv.includes('--quiet');
  const { errors, warnings, report, locales } = checkMessages();
  for (const locale of locales) {
    const r = report[locale];
    console.log(`messages/${locale}: ${r.translated} translated, ${r.missing.length} missing, ${r.extra.length} extra`);
    if (!quiet) for (const key of r.missing) console.log(`  missing ${key}`);
  }
  // The Worker inlines the email strings; a stale copy means untranslated emails, not a broken build.
  const gen = join(here, '../../../packages/core/scripts/gen-email-catalog.mjs');
  if (existsSync(gen)) {
    const { buildCatalogSource } = await import(gen);
    const out = join(here, '../../../packages/core/src/email/catalog.gen.ts');
    if (!existsSync(out) || readFileSync(out, 'utf8') !== buildCatalogSource()) warnings.push('packages/core/src/email/catalog.gen.ts is stale: run node packages/core/scripts/gen-email-catalog.mjs');
  }
  for (const w of warnings.filter((w) => !quiet || !/missing key|drops/.test(w))) console.warn(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  if (errors.length) {
    console.error(`check-messages: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`check-messages: ok (${locales.length} locale(s), ${warnings.length} warning(s))`);
}
