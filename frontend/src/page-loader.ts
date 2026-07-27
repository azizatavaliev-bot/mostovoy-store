const startedAt = performance.now();
const loader = document.createElement("div");
loader.className = "page-loader";
loader.setAttribute("aria-label", "Загрузка");
loader.innerHTML = `
  <span class="page-loader__mark" aria-hidden="true"></span>
  <span class="page-loader__name">МОСТОВОЙ</span>`;
document.body.prepend(loader);
document.body.classList.add("page-loading");

function finish(): void {
  const wait = Math.max(0, 520 - (performance.now() - startedAt));
  window.setTimeout(() => {
    loader.classList.add("page-loader--done");
    document.body.classList.remove("page-loading");
    window.setTimeout(() => loader.remove(), 420);
  }, wait);
}

if (document.readyState === "complete") finish();
else window.addEventListener("load", finish, { once: true });
