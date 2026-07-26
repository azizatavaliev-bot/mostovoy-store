// Задаёт логин и пароль для входа в /admin.html.
// Пароль нигде не сохраняется в открытом виде — только scrypt-хеш в .env.
//
//   npm run admin:set-password -- --username azis --password "СложныйПароль123"
//
// Если SESSION_SECRET ещё не задан — генерирует и добавляет в .env
// (без него подписывать сессии нечем, вход по паролю не заработает).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { hashPassword } = require("../lib/auth");

const ENV_PATH = path.join(__dirname, "..", "..", ".env");

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

function setEnvVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : text.trimEnd() + `\n${line}\n`;
}

function main() {
  const { username, password } = parseArgs(process.argv.slice(2));
  if (!username || !password) {
    throw new Error('Укажите --username и --password. Пример: npm run admin:set-password -- --username azis --password "СложныйПароль123"');
  }
  if (password.length < 8) {
    throw new Error("Пароль слишком короткий — минимум 8 символов");
  }

  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";

  const hasSecret = /^SESSION_SECRET=.+$/m.test(env);
  if (!hasSecret) {
    env = setEnvVar(env, "SESSION_SECRET", crypto.randomBytes(32).toString("hex"));
    console.log("SESSION_SECRET сгенерирован и добавлен в .env");
  }

  env = setEnvVar(env, "ADMIN_USERNAME", username);
  env = setEnvVar(env, "ADMIN_PASSWORD_HASH", hashPassword(password));
  fs.writeFileSync(ENV_PATH, env);

  console.log(`Готово. Логин "${username}" сохранён в .env (пароль — только в виде хеша).`);
  console.log("Перезапустите сервер, чтобы изменения применились.");
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
