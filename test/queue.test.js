const test = require("node:test");
const assert = require("node:assert/strict");
const { SyncQueue, withLock } = require("../server/queue");
const { DeepSeekError } = require("../server/services/deepseek");
const { makeDb } = require("./helpers");

function makeQueue(syncImpl) {
  const db = makeDb();
  const calls = [];
  const syncService = {
    async syncMessage(payload) {
      calls.push(payload);
      return syncImpl(payload, calls.length);
    },
  };
  return { db, calls, queue: new SyncQueue({ db, syncService }) };
}

const job = (over = {}) => ({
  chatId: "-1001",
  messageId: 1,
  eventType: "channel_post",
  payload: { chatId: "-1001", messageId: 1, text: "Sony 5 slim 650$" },
  ...over,
});

test("успешная задача помечается done", async () => {
  const { db, queue } = makeQueue(async () => ({ status: "ok" }));
  queue.enqueue(job());
  await queue.drain();
  assert.equal(db.prepare("SELECT status FROM sync_jobs").get().status, "done");
});

test("временная ошибка DeepSeek повторяется, потом задача проходит", async () => {
  let attempt = 0;
  const { db, queue, calls } = makeQueue(async () => {
    attempt++;
    if (attempt === 1) throw new DeepSeekError("DeepSeek ответил 503", { code: "http_503", retriable: true });
    return { status: "ok" };
  });
  queue.enqueue(job());

  await queue.drain();
  let row = db.prepare("SELECT * FROM sync_jobs").get();
  assert.equal(row.status, "pending", "после сбоя задача возвращается в очередь");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /503/);

  // Backoff отодвигает запуск — в тесте сдвигаем время вручную.
  db.prepare("UPDATE sync_jobs SET run_after = datetime('now', '-1 second')").run();
  await queue.drain();

  row = db.prepare("SELECT * FROM sync_jobs").get();
  assert.equal(row.status, "done");
  assert.equal(calls.length, 2);
});

test("после трёх неудач задача помечается failed и не крутится вечно", async () => {
  const { db, queue, calls } = makeQueue(async () => {
    throw new Error("постоянная ошибка");
  });
  queue.enqueue(job());

  for (let i = 0; i < 5; i++) {
    db.prepare("UPDATE sync_jobs SET run_after = datetime('now', '-1 second')").run();
    await queue.drain();
  }

  const row = db.prepare("SELECT * FROM sync_jobs").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 3);
  assert.equal(calls.length, 3, "не больше MAX_ATTEMPTS попыток");
});

test("два одновременных обновления одного сообщения не выполняются параллельно", async () => {
  let active = 0;
  let maxActive = 0;
  const { queue, calls } = makeQueue(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    return { status: "ok" };
  });

  queue.enqueue(job({ payload: { chatId: "-1001", messageId: 1, text: "первый" } }));
  queue.enqueue(job({ payload: { chatId: "-1001", messageId: 1, text: "второй" } }));

  // Обе задачи стартуют одновременно — блокировка должна их выстроить в очередь.
  await Promise.all([queue.processNext(), queue.processNext()]);

  assert.equal(calls.length, 2);
  assert.equal(maxActive, 1, "одно сообщение обрабатывается строго по одному");
  assert.deepEqual(calls.map((c) => c.text), ["первый", "второй"], "порядок сохранён");
});

test("разные сообщения обрабатываются параллельно", async () => {
  let active = 0;
  let maxActive = 0;
  const { queue } = makeQueue(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    return { status: "ok" };
  });

  queue.enqueue(job({ messageId: 1, payload: { chatId: "-1001", messageId: 1, text: "a" } }));
  queue.enqueue(job({ messageId: 2, payload: { chatId: "-1001", messageId: 2, text: "b" } }));
  await Promise.all([queue.processNext(), queue.processNext()]);

  assert.equal(maxActive, 2);
});

test("withLock сериализует вызовы по ключу даже после исключения", async () => {
  const order = [];
  const failing = withLock("k", async () => {
    order.push("start-1");
    throw new Error("упало");
  }).catch(() => order.push("caught-1"));
  const following = withLock("k", async () => {
    order.push("start-2");
  });

  await Promise.all([failing, following]);
  assert.deepEqual(order, ["start-1", "caught-1", "start-2"]);
});
