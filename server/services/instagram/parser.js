// Распознавание ссылок на Instagram Story/Highlight в свободном тексте
// клиента. Ничего не знает про HikerAPI, ИИ или каталог — только URL.
//
// Обычные ссылки на посты/рилсы/профиль (instagram.com/p/..., /reel/...,
// instagram.com/<username>) намеренно НЕ распознаются: /stories/ в пути —
// обязательное условие, иначе постим наугад.
const STORY_RE = /^https?:\/\/(?:www\.)?instagram\.com\/stories\/([a-zA-Z0-9._]+)\/(\d+)\/?(?:[/?#].*)?$/i;
const HIGHLIGHT_RE = /^https?:\/\/(?:www\.)?instagram\.com\/stories\/highlights\/(\d+)\/?(?:[/?#].*)?$/i;

// Достаточно широкий паттерн для поиска кандидатов внутри произвольного
// текста сообщения ("гляньте вот https://www.instagram.com/stories/... что
// это?") — сами кандидаты потом проверяются точными регексами выше.
const CANDIDATE_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/stories\/[^\s<>"')]+/gi;

/**
 * Разбирает ОДИН url. Возвращает null, если это не Story и не Highlight
 * известного формата (в том числе обычная ссылка Instagram).
 */
function parseInstagramStoryUrl(url) {
  const value = String(url || "").trim();
  if (!value) return null;

  const highlightMatch = value.match(HIGHLIGHT_RE);
  if (highlightMatch) {
    const highlightId = highlightMatch[1];
    return {
      type: "highlight",
      highlightId,
      username: null,
      storyId: null,
      normalizedUrl: `https://www.instagram.com/stories/highlights/${highlightId}/`,
      cacheKey: `instagram_highlight:${highlightId}`,
    };
  }

  const storyMatch = value.match(STORY_RE);
  if (storyMatch) {
    const [, username, storyId] = storyMatch;
    return {
      type: "story",
      username,
      storyId,
      highlightId: null,
      normalizedUrl: `https://www.instagram.com/stories/${username}/${storyId}/`,
      cacheKey: `instagram_story:${storyId}`,
    };
  }

  return null;
}

/**
 * Ищет все ссылки на Story/Highlight в произвольном тексте сообщения.
 * Дедуплицирует по cacheKey — один и тот же Story дважды в одном сообщении
 * не даёт двух проходов дальше по пайплайну.
 */
function findInstagramStoryUrls(text) {
  const value = String(text || "");
  const candidates = value.match(CANDIDATE_URL_RE) || [];
  const seen = new Set();
  const results = [];
  for (const candidate of candidates) {
    // Хвостовые знаки препинания из текста сообщения ("... вот ссылка.") не
    // должны попасть в URL.
    const cleaned = candidate.replace(/[.,;!?)\]]+$/, "");
    const parsed = parseInstagramStoryUrl(cleaned);
    if (!parsed || seen.has(parsed.cacheKey)) continue;
    seen.add(parsed.cacheKey);
    results.push(parsed);
  }
  return results;
}

module.exports = { parseInstagramStoryUrl, findInstagramStoryUrls };
