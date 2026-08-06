"use strict";

// Обезличивание персональных данных перед отправкой в ИИ (OpenAI/DeepSeek/
// Gemini/Anthropic). Телефон/адрес/имя клиента заменяются на плейсхолдеры
// вида {{PHONE_1}} перед вызовом модели; реальные значения подставляются
// обратно в готовый текст уже в коде, после ответа модели.

// Кыргызстанские номера: +996XXXXXXXXX или 0XXXXXXXXX (мобильный/городской).
const PHONE_RE = /(?<!\d)(\+996[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}|0\d{2,3}[\s-]?\d{2,3}[\s-]?\d{2}[\s-]?\d{2})(?!\d)/g;
// Улица/дом/микрорайон — конкретный адрес доставки, не название города.
const ADDRESS_RE = /(?:ул\.?|улица|мкр\.?|микрорайон|пер\.?|переулок|проспект|просп\.?)\s*[^\n,;.!?]{2,60}/gi;
// Клиент сам представляется — берём имя только после явного вводного слова.
const NAME_RE = /(?:меня\s+зовут|зовут\s+меня|зовут)\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){0,2})/gi;

const KINDS = [
  ["PHONE", PHONE_RE],
  ["ADDRESS", ADDRESS_RE],
  ["NAME", NAME_RE],
];

/**
 * Сканирует переданные тексты и назначает каждому уникальному найденному
 * значению плейсхолдер {{KIND_N}}. Порядок важен: телефон/адрес — точные
 * паттерны, имя проверяется последним на уже "вычищенном" остатке текста.
 */
function buildMapping(texts) {
  const mapping = new Map();
  const counters = { PHONE: 0, ADDRESS: 0, NAME: 0 };
  let working = (texts || []).filter(Boolean).join("\n");
  for (const [kind, pattern] of KINDS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(working)) !== null) {
      const value = (match[1] || match[0]).trim();
      if (!value || mapping.has(value)) continue;
      counters[kind] += 1;
      mapping.set(value, `{{${kind}_${counters[kind]}}}`);
    }
    working = working.replace(pattern, " ");
  }
  return mapping;
}

function applyMapping(text, mapping) {
  if (!text || !mapping || mapping.size === 0) return text;
  let redacted = text;
  const entries = [...mapping.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [value, placeholder] of entries) {
    redacted = redacted.split(value).join(placeholder);
  }
  return redacted;
}

function restoreMapping(text, mapping) {
  if (!text || !mapping || mapping.size === 0) return text;
  let restored = text;
  for (const [value, placeholder] of mapping.entries()) {
    restored = restored.split(placeholder).join(value);
  }
  return restored;
}

module.exports = { buildMapping, applyMapping, restoreMapping };
