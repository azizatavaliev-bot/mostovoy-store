const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMapping, applyMapping, restoreMapping } = require("../server/services/privacy");

test("buildMapping распознаёт телефон и назначает плейсхолдер", () => {
  const mapping = buildMapping(["Мой номер 0700922622, жду звонка"]);
  assert.equal(mapping.get("0700922622"), "{{PHONE_1}}");
  assert.equal(mapping.size, 1);
});

test("buildMapping распознаёт международный формат телефона", () => {
  const mapping = buildMapping(["+996 700 92 26 22 — звоните"]);
  assert.equal([...mapping.values()][0], "{{PHONE_1}}");
});

test("buildMapping распознаёт адрес и имя", () => {
  const mapping = buildMapping(["меня зовут Халикхан, живу на ул. Токтогула 5"]);
  assert.equal(mapping.get("Халикхан"), "{{NAME_1}}");
  const addressEntry = [...mapping.entries()].find(([key]) => key.includes("Токтогула"));
  assert.ok(addressEntry, "адрес должен быть найден");
  assert.equal(addressEntry[1], "{{ADDRESS_1}}");
});

test("buildMapping переиспользует плейсхолдер для повторного значения", () => {
  const mapping = buildMapping(["Номер 0700922622", "Ещё раз: 0700922622"]);
  assert.equal(mapping.get("0700922622"), "{{PHONE_1}}");
  assert.equal(mapping.size, 1);
});

test("applyMapping/restoreMapping — обратимая подстановка", () => {
  const text = "Позвоните мне на 0700922622, пожалуйста";
  const mapping = buildMapping([text]);
  const redacted = applyMapping(text, mapping);
  assert.ok(!redacted.includes("0700922622"));
  assert.ok(redacted.includes("{{PHONE_1}}"));
  assert.equal(restoreMapping(redacted, mapping), text);
});

test("текст без PII не меняется", () => {
  const text = "Здравствуйте, сколько стоит iPhone 17?";
  const mapping = buildMapping([text]);
  assert.equal(mapping.size, 0);
  assert.equal(applyMapping(text, mapping), text);
});

test("«ул» внутри обычного слова не принимается за адрес", () => {
  // Найдено на проде: «напишите калькулятор на питон» — «ул» это просто
  // соседние буквы в середине слова «калЬКУЛятор», не начало «улица».
  // Раньше ADDRESS_RE матчил без границы слова и вырезал «улятор на питон»
  // как будто это адрес доставки.
  const text = "напишите калькулятор на питон";
  const mapping = buildMapping([text]);
  assert.equal(mapping.size, 0, "в этом тексте вообще нет адреса");
  assert.equal(applyMapping(text, mapping), text);
});
