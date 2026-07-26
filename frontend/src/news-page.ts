import "./styles.css";
import { mountWhatsappFloat } from "./catalog";
import "./render";

interface NewsPost {
  slug: string;
  title: string;
  body: string;
  image?: string | null;
  publishedAt?: string | null;
}

const feed = document.getElementById("newsFeed") as HTMLElement;

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function bodyHtml(value: string): string {
  return esc(value)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("");
}

function postHtml(post: NewsPost): string {
  const date = formatDate(post.publishedAt);
  return `<article class="newspost">
    <div class="newspost__date">${date ? `<time datetime="${esc(post.publishedAt)}">${esc(date)}</time>` : "Новость"}</div>
    <div class="newspost__content">
      ${post.image ? `<img class="newspost__image" src="${esc(post.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <h2>${esc(post.title)}</h2>
      <div class="newspost__body">${bodyHtml(post.body)}</div>
    </div>
  </article>`;
}

async function init(): Promise<void> {
  mountWhatsappFloat();

  try {
    const response = await fetch("/api/news", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as { posts?: NewsPost[] };
    const posts = Array.isArray(data.posts) ? data.posts : [];
    feed.innerHTML = posts.length
      ? posts.map(postHtml).join("")
      : `<div class="newsfeed__state">
          <h2>Пока без новостей</h2>
          <p>Новые поступления и акции появятся здесь.</p>
          <a class="btn" href="index.html#catalog">Смотреть каталог</a>
        </div>`;
  } catch {
    feed.innerHTML = `<div class="newsfeed__state">
      <h2>Новости временно недоступны</h2>
      <p>Обновите страницу позже или перейдите в каталог.</p>
      <a class="btn btn--ghost" href="index.html#catalog">В каталог</a>
    </div>`;
  }
}

void init();
