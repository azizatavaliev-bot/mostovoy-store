import "./styles.css";
import "./page-loader";
import {
  fmt,
  loadCatalog,
  mountCartDrawer,
  mountHeaderControls,
  mountWhatsappFloat,
  onCurrencyChange,
  openWhatsApp,
  toast,
} from "./catalog";
import { enhanceSelects } from "./render";

const model = document.getElementById("tradePageModel") as HTMLSelectElement;
const condition = document.getElementById("tradePageState") as HTMLSelectElement;
const result = document.getElementById("tradePageResult") as HTMLElement;
const estimate = document.getElementById("tradePageEstimate") as HTMLButtonElement;
const send = document.getElementById("tradePageSend") as HTMLButtonElement;
const burger = document.getElementById("burger") as HTMLButtonElement;
const nav = document.getElementById("nav") as HTMLElement;
let hasEstimate = false;

function selectedText(select: HTMLSelectElement): string {
  return select.options[select.selectedIndex]?.text || "";
}

function estimateValue(): number {
  return Math.round(Number(model.value) * Number(condition.value));
}

function renderEstimate(animate = false): void {
  const value = estimateValue();
  result.textContent = fmt(value, "USD");
  result.parentElement?.classList.toggle("is-ready", value > 0);
  if (animate) {
    result.parentElement?.classList.remove("trade-result-pop");
    requestAnimationFrame(() => result.parentElement?.classList.add("trade-result-pop"));
  }
}

function calculate(): void {
  if (!Number(model.value)) {
    toast("Сначала выберите модель устройства");
    model.focus();
    return;
  }
  hasEstimate = true;
  renderEstimate(true);
  estimate.classList.add("is-done");
  estimate.querySelector("span")!.textContent = "Оценка готова";
  send.hidden = false;
}

estimate.addEventListener("click", calculate);
[model, condition].forEach((select) => {
  select.addEventListener("change", () => {
    if (hasEstimate) calculate();
  });
});

send.addEventListener("click", () => {
  if (!hasEstimate || !estimateValue()) return calculate();
  openWhatsApp([
    "Здравствуйте! Хочу подтвердить предварительную оценку Trade-in:",
    `Устройство: ${selectedText(model)}`,
    `Состояние: ${selectedText(condition)}`,
    `Предварительная оценка: ${fmt(estimateValue(), "USD")}`,
    "",
    "Когда можно принести устройство на диагностику?",
  ].join("\n"));
});

burger?.addEventListener("click", () => {
  burger.classList.toggle("active");
  nav.classList.toggle("open");
});

document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", () => {
    burger?.classList.remove("active");
    nav?.classList.remove("open");
  });
});

window.addEventListener("scroll", () => {
  document.querySelector(".header")?.classList.toggle("scrolled", window.scrollY > 12);
}, { passive: true });

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("in");
    revealObserver.unobserve(entry.target);
  });
}, { threshold: 0.12 });

document.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));

(async function init(): Promise<void> {
  await loadCatalog();
  mountHeaderControls();
  mountCartDrawer();
  mountWhatsappFloat();
  enhanceSelects();
  renderEstimate();
  onCurrencyChange(() => renderEstimate());
})();
