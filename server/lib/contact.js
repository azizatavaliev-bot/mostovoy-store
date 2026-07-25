// Сообщение и ссылка для кнопки «Связаться» (Telegram).
//
// Важно про Telegram: deep-link на чат пользователя (t.me/<username>) НЕ поддерживает
// предзаполнение текста — параметр ?text= работает только в t.me/share/url, а тот
// заставляет выбирать получателя. Поэтому ссылка ведёт прямо в чат магазина,
// а готовый текст отдаётся отдельным полем: витрина кладёт его в буфер обмена.
const { normalizeText } = require("./normalize");

const GENERIC_MESSAGE = "Здравствуйте! Хочу проконсультироваться по выбору техники.";

// Не дублируем в сообщении то, что уже есть в названии («Kindle Paperwhite 16 GB»).
function alreadyInName(name, value) {
  if (!value) return true;
  return normalizeText(name).includes(normalizeText(value));
}

function buildContactMessage(product, selected = {}) {
  if (!product || !product.official_name) return GENERIC_MESSAGE;

  const name = product.official_name;
  const storage = selected.storage ?? product.storage;
  const color = selected.color ?? product.color;
  const variant = selected.variant ?? product.variant;

  const parts = [name];
  if (storage && !alreadyInName(name, storage)) parts.push(`память ${storage}`);
  if (color && !alreadyInName(name, color)) parts.push(`цвет ${color}`);
  if (variant && !alreadyInName(name, variant)) parts.push(`вариант ${variant}`);

  let subject = parts.join(", ");

  const price = selected.price ?? product.price;
  const currency = selected.currency ?? product.currency;
  if (price != null && currency) {
    const amount = Number(price);
    const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
    subject += `${parts.length > 1 ? "," : ""} за ${shown} ${currency}`;
  }

  return `Здравствуйте! Меня интересует ${subject}. Подскажите, товар сейчас в наличии?`;
}

function buildContactLink(username, product, selected = {}) {
  const user = String(username || "").replace(/^@/, "");
  const text = buildContactMessage(product, selected);
  return {
    url: `https://t.me/${encodeURIComponent(user)}`,
    // Готовая share-ссылка на случай, если клиент её поддерживает.
    shareUrl: `https://t.me/share/url?url=${encodeURIComponent("")}&text=${encodeURIComponent(text)}`,
    text,
  };
}

// WhatsApp, в отличие от Telegram, умеет предзаполнять текст через ?text=,
// поэтому заказ уходит одной ссылкой, без копирования в буфер обмена.
function buildWhatsappLink(phone, product, selected = {}) {
  const digits = String(phone || "").replace(/\D/g, "");
  const text = buildContactMessage(product, selected);
  return {
    url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`,
    phone: digits,
    text,
  };
}

module.exports = { buildContactMessage, buildContactLink, buildWhatsappLink, GENERIC_MESSAGE };
