const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { matchesCurrentOrNext, matchesHmacCurrentOrNext, timingSafeEqualStr } = require("../server/lib/token-rotation");

test("matchesCurrentOrNext: принимает и текущее, и следующее значение — так ротация проходит без даунтайма", () => {
  assert.equal(matchesCurrentOrNext("old-secret", "old-secret", "new-secret"), true);
  assert.equal(matchesCurrentOrNext("new-secret", "old-secret", "new-secret"), true);
  assert.equal(matchesCurrentOrNext("wrong", "old-secret", "new-secret"), false);
});

test("matchesCurrentOrNext: пустой supplied или отсутствующий next — не ломается", () => {
  assert.equal(matchesCurrentOrNext("", "old-secret", "new-secret"), false);
  assert.equal(matchesCurrentOrNext(undefined, "old-secret", "new-secret"), false);
  assert.equal(matchesCurrentOrNext("old-secret", "old-secret", ""), true);
  assert.equal(matchesCurrentOrNext("old-secret", "old-secret", undefined), true);
});

test("matchesHmacCurrentOrNext: принимает подпись, посчитанную по любому из двух секретов", () => {
  const body = Buffer.from("raw webhook body");
  const sigOld = crypto.createHmac("sha256", "old-secret").update(body).digest("hex");
  const sigNew = crypto.createHmac("sha256", "new-secret").update(body).digest("hex");
  const sigWrong = crypto.createHmac("sha256", "wrong-secret").update(body).digest("hex");

  assert.equal(matchesHmacCurrentOrNext(body, sigOld, "old-secret", "new-secret"), true);
  assert.equal(matchesHmacCurrentOrNext(body, sigNew, "old-secret", "new-secret"), true);
  assert.equal(matchesHmacCurrentOrNext(body, sigWrong, "old-secret", "new-secret"), false);
});

test("matchesHmacCurrentOrNext: невалидный hex не бросает исключение, просто false", () => {
  assert.equal(matchesHmacCurrentOrNext(Buffer.from("x"), "not-hex-zz", "secret", null), false);
  assert.equal(matchesHmacCurrentOrNext(Buffer.from("x"), "", "secret", null), false);
});

test("timingSafeEqualStr: базовое сравнение строк одинаковой/разной длины", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false);
  assert.equal(timingSafeEqualStr("abc", "xyz"), false);
});
