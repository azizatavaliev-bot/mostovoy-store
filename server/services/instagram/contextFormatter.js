// Превращает результат StoryResolver.resolve() в текстовый блок, который
// подмешивается в сообщение клиента для основного AI-менеджера. Никакого
// отдельного чат-бота — просто preprocessing-контекст перед обычной
// генерацией (см. crm.js _augmentWithInstagramStory).
function formatStoryContext(result) {
  if (!result) return null;

  if (!result.ok) {
    return [
      "[Instagram Story]",
      "Клиент прислал ссылку на Instagram Story/Highlight, но получить и проанализировать её не удалось.",
      "Не придумывай, что там было. Вежливо уточни у клиента, о каком товаре речь — например «Могу уточнить, насчёт какого товара вы пишете?» (сформулируй в своём обычном стиле).",
    ].join("\n");
  }

  const { analysis, catalogMatches } = result;
  const lines = ["[Instagram Story]", "Клиент только что отправил Instagram Story.", "", "Анализ Story:", analysis.summary || "(модель не дала краткого описания)"];

  if (analysis.products_visible.length) {
    lines.push("", "Распознанные детали:");
    for (const product of analysis.products_visible) {
      const attrs = [
        product.category && `категория: ${product.category}`,
        product.brand && `бренд: ${product.brand}`,
        product.model && `модель: ${product.model}`,
      ].filter(Boolean);
      lines.push(`- ${product.name_guess}${attrs.length ? ` (${attrs.join(", ")})` : ""}`);
    }
  }
  if (analysis.important_details.length) {
    for (const detail of analysis.important_details) lines.push(`- ${detail}`);
  }
  if (analysis.visible_text.length) {
    lines.push("", `Текст на Story: «${analysis.visible_text.join("», «")}»`);
  }
  if (!analysis.contains_product) {
    lines.push("", "На Story не видно конкретного товара.");
  }

  if (catalogMatches?.length) {
    lines.push("", "Возможные товары из каталога:");
    catalogMatches.forEach((match, index) => {
      lines.push(`${index + 1}. Product ID ${match.id} — ${match.name}`);
    });
  } else if (analysis.contains_product) {
    lines.push("", "Совпадений в каталоге не найдено — не утверждай, что этот товар есть в наличии.");
  }

  lines.push(
    "",
    "Используй эту информацию как контекст текущего сообщения клиента. Не утверждай, что конкретный товар найден и есть в наличии, если совпадение неуверенное — сначала уточни у клиента."
  );
  return lines.join("\n");
}

module.exports = { formatStoryContext };
