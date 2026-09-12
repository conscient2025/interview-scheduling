import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAvailability } from "../scripts/lib/availability.mjs";
import { parseCsv } from "../scripts/lib/csv.mjs";
import { normalizeSlotRow } from "../scripts/lib/scheduler.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await fs.readFile(path.join(projectRoot, "config", "schedule.json"), "utf8"));
const slotCsv = parseCsv(await fs.readFile(path.join(projectRoot, "data", "slots.csv"), "utf8"));
const slots = slotCsv.rows
  .map(normalizeSlotRow)
  .sort((left, right) => left.display_order - right.display_order);

const windowCases = [
  ["9月27 上午（10:00—11:50之间）", "2026-09-27", "morning"],
  ["9月27 下午（14:00—17:10之间）", "2026-09-27", "afternoon"],
  ["9月27 晚上（19:00—22:10之间）", "2026-09-27", "evening"],
  ["10月7 上午（10:00—11:50之间）", "2026-10-07", "morning"],
  ["10月7 下午（14:00—17:10之间）", "2026-10-07", "afternoon"],
  ["10月7  晚上（19:00—22:10之间）", "2026-10-07", "evening"],
];

for (const [option, date, period] of windowCases) {
  test(`${option} expands to every configured concrete slot`, () => {
    const result = parseAvailability(option, slots, config);
    const expected = slots
      .filter((slot) => slot.date === date && slot.period === period)
      .map((slot) => slot.slot_id);
    assert.deepEqual(result.availableSlots, expected);
    assert.deepEqual(result.unknownOptions, []);
  });
}

test("full-width punctuation and wave dashes are normalized", () => {
  const result = parseAvailability("９月２７日 上午（１０：００～１１：５０之间）", slots, config);
  assert.deepEqual(result.availableSlots, [
    "2026-09-27-1000",
    "2026-09-27-1040",
    "2026-09-27-1120",
  ]);
});

test("future period wording can be added through configuration", () => {
  const result = parseAvailability("10月7 晚间（19:00—22:10之间）", slots, {
    ...config,
    availabilityPeriodLabels: {
      ...config.availabilityPeriodLabels,
      晚间: "evening",
    },
  });
  assert.equal(result.availableSlots.length, 5);
  assert.deepEqual(result.unknownOptions, []);
});

test("legacy exact options accept common dash variants and deduplicate", () => {
  const result = parseAvailability(
    "9月27日 10:00-10:30┋9月27 10:40–11:10┋9月27 10:00—10:30┋10月7 21:40—22:10",
    slots,
    config,
  );
  assert.deepEqual(result.availableSlots, [
    "2026-09-27-1000",
    "2026-09-27-1040",
    "2026-10-07-2140",
  ]);
  assert.deepEqual(result.unknownOptions, []);
});

test("exact options on dates without windows continue to work", () => {
  const result = parseAvailability("9月28 19:00—19:30", slots, config);
  assert.deepEqual(result.availableSlots, ["2026-09-28-1900"]);
  assert.deepEqual(result.unknownOptions, []);
});

test("mixed exact and window answers normalize to one deduplicated slot set", () => {
  const result = parseAvailability(
    "9月27 11:20—11:50┋9月27 上午（10:00—11:50之间）┋9月27 10:00—10:30",
    slots,
    config,
  );
  assert.deepEqual(result.availableSlots, [
    "2026-09-27-1000",
    "2026-09-27-1040",
    "2026-09-27-1120",
  ]);
});

test("online-only selection remains separate from October 7 offline availability", () => {
  const result = parseAvailability("国庆假期线上面试┋10月7 晚上（19:00—22:10之间）", slots, config);
  assert.equal(result.onlineOnlySelected, true);
  assert.equal(result.availableSlots.length, 5);
});

test("a window that does not align with configured slot boundaries is rejected", () => {
  const option = "9月27 上午（10:00—11:40之间）";
  const result = parseAvailability(option, slots, config);
  assert.deepEqual(result.availableSlots, []);
  assert.deepEqual(result.unknownOptions, [option]);
});
