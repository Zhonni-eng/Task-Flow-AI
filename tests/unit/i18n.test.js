import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANGUAGE, LANGUAGES, translations } from '../../src/i18n/translations.js';

const PLURAL_KEYS = new Set(['one', 'few', 'many', 'other']);
const isPlural = (value) => value && typeof value === 'object' && Object.keys(value).every((key) => PLURAL_KEYS.has(key));

function flatten(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object' && !isPlural(value) ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  );
}

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const ru = Object.fromEntries(flatten(translations.ru));
const en = Object.fromEntries(flatten(translations.en));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(jsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

describe('translation dictionaries', () => {
  it('defines Russian as the default and both languages', () => {
    expect(DEFAULT_LANGUAGE).toBe('ru');
    expect(LANGUAGES.map((lang) => lang.code)).toEqual(['ru', 'en']);
  });

  it('have exactly the same keys in Russian and English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it('have no empty strings', () => {
    for (const [key, value] of [...Object.entries(ru), ...Object.entries(en)]) {
      const texts = isPlural(value) ? Object.values(value) : [value];
      for (const text of texts) expect(typeof text === 'string' && text.trim().length > 0, key).toBe(true);
    }
  });

  it('use the same placeholders in both languages', () => {
    for (const key of Object.keys(ru)) {
      const forms = (value) => (isPlural(value) ? Object.values(value) : [value]).map(placeholders);
      const ruSets = new Set(forms(ru[key]).map(String));
      const enSets = new Set(forms(en[key]).map(String));
      expect([...enSets], key).toEqual([...ruSets]);
    }
  });

  it('provide the plural forms each language needs', () => {
    for (const [key, value] of Object.entries(ru)) {
      if (!isPlural(value)) continue;
      expect(Object.keys(value), key).toEqual(expect.arrayContaining(['one', 'few', 'many', 'other']));
      expect(Object.keys(en[key]), key).toEqual(expect.arrayContaining(['one', 'other']));
    }
  });

  it('contain every literal key used in the source code', () => {
    const srcDir = path.resolve(import.meta.dirname, '../../src');
    const used = new Set();
    for (const file of sourceFiles(srcDir)) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)) used.add(match[1]);
    }
    const known = new Set(Object.keys(ru));
    const missing = [...used].filter((key) => !known.has(key));
    expect(used.size).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});
