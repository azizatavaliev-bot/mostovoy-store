// Нормализация: ключи товаров, цены, валюты, наличие, похожесть строк.
// Всё детерминированно и без сети — это проверяемая часть, ИИ здесь не участвует.

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

function translit(str) {
  return String(str)
    .toLowerCase()
    .split("")
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join("");
}

// URL-совместимый идентификатор товара (используется как product.html?id=<slug>).
// «+» значим для названий (Galaxy S24+ ≠ Galaxy S24), поэтому не выкидываем его,
// а разворачиваем в «plus» — иначе два разных товара дают один ключ.
function slugify(str) {
  return translit(str)
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

// Приведение произвольного названия к сравнимому виду: без пунктуации и регистра.
function normalizeText(str) {
  return translit(str)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// «512g», «512 gb», «16GB», «1 ТБ» → «512 GB» / «1 TB». null, если не память.
function normalizeStorage(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).toLowerCase().replace(/\s+/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(tb|тб|gb|гб|g|г|mb|мб)?$/);
  if (!m) return String(raw).trim() || null;
  const num = m[1];
  const unit = m[2] || "gb";
  if (/^(tb|тб)$/.test(unit)) return `${num} TB`;
  if (/^(mb|мб)$/.test(unit)) return `${num} MB`;
  return `${num} GB`;
}

// Ключ сопоставления: brand|model|storage|color|variant
// Пример: sony|playstation-5-slim|||standard
function normalizedKey({ brand, model, storage, color, variant } = {}) {
  const part = (v) => (v == null || v === "" ? "" : slugify(String(v)));
  return [
    part(brand),
    part(model),
    part(normalizeStorage(storage) || ""),
    part(color),
    part(variant) || "standard",
  ].join("|");
}

// Второй ключ сопоставления — устойчивый к тому, в какое поле модель положила
// признак. Практика показала, что между прогонами один и тот же токен кочует:
// «Starfish» то в color, то в variant; «Body+Face» то в model, то в variant.
// Позиционный normalized_key из-за этого плодит дубликаты, а здесь мы берём
// бренд + отсортированный набор всех значимых токенов, поэтому порядок и
// расположение по полям роли не играют.
function matchKey({ brand, model, official_name, storage, color, variant } = {}) {
  const tokens = new Set();
  const add = (v) => {
    if (v == null || v === "") return;
    for (const t of normalizeText(String(v)).split(" ")) if (t) tokens.add(t);
  };
  add(model || official_name);
  add(normalizeStorage(storage));
  add(color);
  add(variant);
  return `${slugify(brand || "")}|${[...tokens].sort().join("-")}`;
}

// --- Валюты ---------------------------------------------------------------

// Внимание: \b и \w в JS работают только по латинице, поэтому для кириллицы
// используются явные диапазоны и lookaround, иначе «сом» и «продано» не находятся.
const CURRENCIES = {
  USD: [/\$/, /(?<![a-z])usd(?![a-z])/i, /(?<![а-яё])дол+ар[а-яё]*/i, /(?<![а-яё])бакс[а-яё]*/i],
  KGS: [/(?<![a-z])kgs(?![a-z])/i, /(?<![а-яё])сом[а-яё]*/i],
};

function detectCurrency(text) {
  if (!text) return null;
  for (const [code, patterns] of Object.entries(CURRENCIES)) {
    if (patterns.some((re) => re.test(text))) return code;
  }
  return null;
}

// «11 000», «1,299.00», «1299» → число. null, если разобрать нельзя.
function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\s| /g, "");
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Достаёт первую пару «сумма + валюта» из строки.
// Понимает «650$», «$135», «2500 сом», «195 USD», «Dji mic 3 - 290$».
// Число: «650», «2500», «11 000», «1,299», «650.50».
//
// Пробел как разделитель тысяч допускается ТОЛЬКО если первая группа из 2–3 цифр.
// Иначе «Nintendo 2 470$» читалось бы как 2470, а не как «Nintendo 2» за 470:
// в названиях товаров номер модели — одна цифра, а цены магазин пишет
// либо слитно («11000»), либо с группой из двух+ цифр («11 000»).
// Запятая однозначна, поэтому для неё ограничения нет.
const NUM = [
  "\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?", // 1,299.00
  "\\d{2,3}(?:[\\s\\u00a0]\\d{3})+(?:[.,]\\d{1,2})?", // 11 000
  "\\d+(?:[.,]\\d{1,2})?", // 650, 2500, 650.50
].join("|");
const NUM_G = `(?:${NUM})(?!\\d)`;
const CUR_AFTER = "\\$|usd|kgs|сом[а-яё]*|дол+ар[а-яё]*|бакс[а-яё]*";

const PRICE_RE = new RegExp(
  [
    // валюта перед суммой: $135, USD 135
    `(?:(\\$|usd|kgs)\\s*(${NUM_G}))`,
    // сумма перед валютой: 650$, 2500 сом, 195 USD
    `|(?:(${NUM_G})\\s*(${CUR_AFTER}))`,
  ].join(""),
  "i"
);

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).match(PRICE_RE);
  if (!m) return null;
  const [, curBefore, amtAfter, amtBefore, curAfter] = m;
  const amount = parseAmount(amtAfter ?? amtBefore);
  if (amount == null) return null;
  const currency = detectCurrency(curBefore || curAfter || "");
  return currency ? { price: amount, currency } : null;
}

// --- Наличие --------------------------------------------------------------

const UNAVAILABLE_MARKERS = [
  /нет в наличии/i,
  /не в наличии/i,
  /(?<![а-яё])закончил[а-яё]*/i,
  /(?<![а-яё])продан[а-яё]*/i,
  /(?<![a-z])sold\s*out(?![a-z])/i,
  /(?<![a-z])out of stock(?![a-z])/i,
  /(?<![а-яё])отсутству[а-яё]*/i,
  /под заказ/i,
  /(^|[\s(«"])нет([\s)»".!,]|$)/i,
];

function looksUnavailable(text) {
  if (!text) return false;
  return UNAVAILABLE_MARKERS.some((re) => re.test(String(text)));
}

// --- Похожесть строк ------------------------------------------------------

// Коэффициент Дайса по биграммам: 0..1. Без зависимостей, устойчив к опечаткам.
function similarity(a, b) {
  const x = normalizeText(a).replace(/\s/g, "");
  const y = normalizeText(b).replace(/\s/g, "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bigrams = (s) => {
    const map = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
  };
  const ma = bigrams(x);
  const mb = bigrams(y);
  let hits = 0;
  for (const [g, n] of ma) hits += Math.min(n, mb.get(g) || 0);
  return (2 * hits) / (x.length - 1 + y.length - 1);
}

module.exports = {
  translit,
  slugify,
  normalizeText,
  normalizeStorage,
  normalizedKey,
  matchKey,
  detectCurrency,
  parseAmount,
  parsePrice,
  looksUnavailable,
  similarity,
  SUPPORTED_CURRENCIES: ["USD", "KGS"],
};
