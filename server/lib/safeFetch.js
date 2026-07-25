// HTTP-запросы наружу с защитой от SSRF, зависаний и гигантских ответов.
// Используется для проверки картинок и загрузки страниц-источников.
const dns = require("dns").promises;
const net = require("net");

class FetchGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FetchGuardError";
    this.code = code;
  }
}

function ipToLong(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local + метаданные облаков (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function isPrivateV4(ip) {
  const val = ipToLong(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (val & mask) === (ipToLong(base) & mask);
  });
}

function isPrivateV6(ip) {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "::1" || a === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true; // link-local fe80::/10
  // IPv4-mapped ::ffff:10.0.0.1
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true; // не смогли разобрать — считаем небезопасным
}

// Проверяет протокол, хост и то, что имя не резолвится во внутреннюю сеть.
async function assertPublicUrl(rawUrl, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchGuardError("Некорректный URL", "bad_url");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new FetchGuardError("Разрешён только HTTPS", "not_https");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new FetchGuardError("Внутренний хост запрещён", "private_host");
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new FetchGuardError("Приватный IP запрещён", "private_ip");
    return url;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new FetchGuardError("Хост не резолвится", "dns_failed");
  }
  if (!records.length) throw new FetchGuardError("Хост не резолвится", "dns_failed");
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new FetchGuardError("Хост резолвится во внутреннюю сеть", "private_ip");
    }
  }
  return url;
}

// fetch с таймаутом, лимитом размера и запретом на редирект в приватную сеть.
async function safeFetch(rawUrl, options = {}) {
  const {
    method = "GET",
    headers = {},
    timeoutMs = 10000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 3,
    allowHttp = false,
    fetchImpl = globalThis.fetch,
  } = options;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current, { allowHttp });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, {
        method,
        headers: { "user-agent": "MostovoyCatalogBot/1.0", ...headers },
        redirect: "manual",
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new FetchGuardError("Таймаут запроса", "timeout");
      throw new FetchGuardError(`Сетевая ошибка: ${e.message}`, "network");
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current).href;
      continue;
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new FetchGuardError("Ответ слишком большой", "too_large");
    }
    return { res, url: current };
  }
  throw new FetchGuardError("Слишком много редиректов", "too_many_redirects");
}

// Читает тело с жёстким лимитом — на случай, если Content-Length соврал.
async function readLimited(res, maxBytes) {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new FetchGuardError("Ответ слишком большой", "too_large");
    return buf;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new FetchGuardError("Ответ слишком большой", "too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

module.exports = { safeFetch, assertPublicUrl, readLimited, isPrivateAddress, FetchGuardError };
