"use strict";

// Обезличивание персональных данных перед отправкой в ИИ (OpenAI/DeepSeek/
// Gemini/Anthropic). Телефон/адрес/имя клиента заменяются на плейсхолдеры
// вида {{PHONE_1}} перед вызовом модели; реальные значения подставляются
// обратно в готовый текст уже в коде, после ответа модели.

// Кыргызстанские номера: +996XXXXXXXXX или 0XXXXXXXXX (мобильный/городской).
// +996 / 996 / 0 и затем девять цифр с любыми пробелами, дефисами и скобками:
// «+996 555 123 456», «0555 123 456», «996555123456», «+996 (555) 12-34-56».
// Старый шаблон понимал только группировку 3-2-2-2, остальные форматы уходили
// в ИИ как есть (ревью 2026-10-15).
const PHONE_RE = /(?<![\d+])(?:\+?996|0)[\s\-()]*\d(?:[\s\-()]*\d){8}(?!\d)/g;
// Улица/дом/микрорайон — конкретный адрес доставки, не название города.
// Без (?<![a-zа-яё0-9]) префикс «ул» совпадал ВНУТРИ слов, например
// «кальКУЛятор» — «ул» там просто случайные соседние буквы, не начало
// слова «улица». Найдено на проде: клиент написал «напишите калькулятор
// на питон», и приватность приняла «улятор на питон» за адрес доставки.
// Кавычки и скобки — граница адреса: супервизор получает переписку как JSON,
// и «мкр Джал 12"}],» уходил в адрес целиком, а потом возвращался клиенту
// в тексте ответа (живой тест 2026-10-15).
// (?![а-яё]) после сокращения: без него «пер» в «первоначальный», «ул» в
// «улучшенный» считались началом адреса, и ИИ получал «Без {{ADDRESS_1}}
// можно?» вместо «Без первоначального взноса можно?» (живой тест 2026-10-15).
const ADDRESS_RE = /(?<![a-zа-яё0-9])(?:ул\.?|улица|мкр\.?|микрорайон|пер\.?|переулок|проспект|просп\.?)(?![а-яё])\s*[^\n,;.!?"'{}\[\]<>\\+]{2,60}?(?=\s*(?:тел(?:ефон)?\.?|т\.|номер|\+?996|0\d{2,3}[\s\-]?\d)|[\n,;.!?"'{}\[\]<>\\]|$)/giu;
// Клиент сам представляется — берём имя только после явного вводного слова.
// Одно слово с заглавной буквы после «меня зовут» / «зовут»: с флагом i
// захватывалось «Азиз хочу айфон» целиком, и ИИ не видел, что клиент хочет
// айфон (ревью 2026-10-15). Кыргызские буквы — тоже.
const NAME_RE = /(?:[Мм]еня\s+зовут|[Зз]овут\s+меня|[Зз]овут)\s+([А-ЯЁӨҮҢ][а-яёөүң]+)/g;

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
    // Телефон вырезаем из рабочего текста только для поиска имени: адрес
    // ищется по исходному тексту, иначе «ул Ленина 5 тел 0555123456» давало
    // значение адреса, которого нет в тексте, и адрес уходил в ИИ (ревью).
    if (kind !== "PHONE") working = working.replace(pattern, " ");
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

function findPhone(text) {
  PHONE_RE.lastIndex = 0;
  const match = PHONE_RE.exec(String(text || ""));
  PHONE_RE.lastIndex = 0;
  return match ? match[0].trim() : null;
}

function restoreMapping(text, mapping) {
  if (!text || !mapping || mapping.size === 0) return text;
  let restored = text;
  for (const [value, placeholder] of mapping.entries()) {
    restored = restored.split(placeholder).join(value);
  }
  return restored;
}

module.exports = { buildMapping, applyMapping, restoreMapping, findPhone };
