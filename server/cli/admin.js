// Работа с админкой из терминала — тот же API, что у admin.html и curl'а.
// Сервер (npm start) должен быть запущен.
//
//   npm run admin -- list
//   npm run admin -- show <slug>
//   npm run admin -- add --name "Xiaomi Redmi Note 14" --brand Xiaomi --category "Смартфоны" \
//       --price 220 --currency USD --color Чёрный --storage "128GB,256GB,512GB" \
//       --description "..." --image "https://.../photo.jpg"
//   npm run admin -- update <slug> --price 199 --available false
//   npm run admin -- hide <slug>
//   npm run admin -- restore <slug>
//
// URL сервера — из PUBLIC_URL в .env, либо --url, либо http://localhost:<PORT>.
// Токен — из ADMIN_TOKEN в .env, либо --token.
const config = require("../config");

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
    else positional.push(a);
  }
  return { command: positional[0], arg: positional[1], flags };
}

function baseUrl(flags) {
  return (flags.url || config.publicUrl || `http://localhost:${config.port}`).replace(/\/+$/, "");
}

function token(flags) {
  return flags.token || config.admin.token;
}

async function call(flags, method, path, body) {
  const res = await fetch(`${baseUrl(flags)}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-admin-token": token(flags) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function printProduct(p) {
  console.log(`${p.slug}  [${p.status}]`);
  console.log(`  ${p.name}${p.brand ? " — " + p.brand : ""}`);
  console.log(`  ${p.price} ${p.currency}${p.available ? "" : " · нет в наличии"}`);
  if (p.storageOptions?.length) console.log(`  память: ${p.storageOptions.join(", ")}`);
  if (p.color) console.log(`  цвет: ${p.color}`);
  if (p.image) console.log(`  фото: ${p.image}`);
}

async function main() {
  const { command, arg, flags } = parseArgs(process.argv.slice(2));

  if (!token(flags)) {
    throw new Error("Не задан токен. Укажите ADMIN_TOKEN в .env или передайте --token.");
  }

  if (command === "list") {
    const { products } = await call(flags, "GET", "/api/admin/products");
    if (!products.length) return console.log("Товаров пока нет.");
    products.forEach((p) => {
      console.log(`${p.slug}  [${p.status}]  ${p.name}  ${p.price} ${p.currency}`);
    });
    console.log(`\nВсего: ${products.length}`);
    return;
  }

  if (command === "show") {
    if (!arg) throw new Error("Укажите slug: npm run admin -- show <slug>");
    const { product } = await call(flags, "GET", `/api/admin/products/${encodeURIComponent(arg)}`);
    printProduct(product);
    return;
  }

  if (command === "add") {
    const body = {
      name: flags.name,
      brand: flags.brand,
      category: flags.category,
      price: flags.price,
      currency: flags.currency || "USD",
      color: flags.color,
      variant: flags.variant,
      description: flags.description,
      image: flags.image,
      images: flags.images ? flags.images.split(",").map((s) => s.trim()) : undefined,
      storageOptions: flags.storage,
      available: flags.available !== "false",
    };
    if (!body.name) throw new Error("Укажите --name");
    if (!body.price) throw new Error("Укажите --price");
    const { product, warnings } = await call(flags, "POST", "/api/admin/products", body);
    console.log("Создано:");
    printProduct(product);
    warnings?.forEach((w) => console.log(`⚠ ${w}`));
    return;
  }

  if (command === "update") {
    if (!arg) throw new Error("Укажите slug: npm run admin -- update <slug> --price 199");
    const body = {};
    for (const key of ["name", "brand", "category", "price", "currency", "color", "variant", "description", "image"]) {
      if (flags[key] !== undefined) body[key] = flags[key];
    }
    if (flags.images !== undefined) body.images = flags.images.split(",").map((s) => s.trim());
    if (flags.storage !== undefined) body.storageOptions = flags.storage;
    if (flags.available !== undefined) body.available = flags.available !== "false";
    if (!Object.keys(body).length) throw new Error("Нечего обновлять — передайте хотя бы один флаг");

    const { product, warnings } = await call(flags, "PUT", `/api/admin/products/${encodeURIComponent(arg)}`, body);
    console.log("Обновлено:");
    printProduct(product);
    warnings?.forEach((w) => console.log(`⚠ ${w}`));
    return;
  }

  if (command === "hide") {
    if (!arg) throw new Error("Укажите slug: npm run admin -- hide <slug>");
    const { product } = await call(flags, "DELETE", `/api/admin/products/${encodeURIComponent(arg)}`);
    console.log(`Скрыт: ${product.slug} [${product.status}]`);
    return;
  }

  if (command === "restore") {
    if (!arg) throw new Error("Укажите slug: npm run admin -- restore <slug>");
    const { product } = await call(flags, "POST", `/api/admin/products/${encodeURIComponent(arg)}/restore`);
    console.log(`Восстановлен: ${product.slug} [${product.status}]`);
    return;
  }

  console.log(`Команды: list, show <slug>, add --name ... --price ..., update <slug> --поле значение, hide <slug>, restore <slug>`);
}

main().catch((e) => {
  console.error(e.data ? `${e.message}: ${JSON.stringify(e.data)}` : e.message);
  process.exit(1);
});
