import assert from "node:assert/strict";
import test from "node:test";
import { scheduleApplicants } from "../scripts/lib/scheduler.mjs";

const config = {
  targetGroupSize: 5,
  maxAutoGroupSize: 6,
  smallGroupThreshold: 3,
};

const slots = [
  { slot_id: "morning", date: "2026-09-27", start: "10:00", end: "10:30", period: "morning", display_order: 1 },
  { slot_id: "early", date: "2026-09-27", start: "14:00", end: "14:30", period: "afternoon", display_order: 2 },
  { slot_id: "next", date: "2026-09-27", start: "14:40", end: "15:10", period: "afternoon", display_order: 3 },
  { slot_id: "later", date: "2026-09-28", start: "19:00", end: "19:30", period: "evening", display_order: 4 },
];

function applicants(count, available = ["early", "next", "later", "morning"]) {
  return Array.from({ length: count }, (_, index) => ({
    student_id: String(32000000 + index),
    name: `学生${index + 1}`,
    available_slots: [...available],
    assigned_slot: "",
    seat_no: "",
    status: "unassigned",
  }));
}

function groupSizes(result) {
  const counts = new Map();
  for (const applicant of result.applicants) {
    if (!applicant.assigned_slot) continue;
    counts.set(applicant.assigned_slot, (counts.get(applicant.assigned_slot) ?? 0) + 1);
  }
  return [...counts.values()].sort((left, right) => left - right);
}

test("eleven applicants are grouped as five and six", () => {
  const result = scheduleApplicants(applicants(11), slots, config);
  assert.deepEqual(groupSizes(result), [5, 6]);
  assert.equal(result.summary.smallGroups.length, 0);
  assert.equal(result.summary.sixPersonGroups.length, 1);
});

test("twelve applicants use two six-person groups instead of a two-person remainder", () => {
  const result = scheduleApplicants(applicants(12), slots, config);
  assert.deepEqual(groupSizes(result), [6, 6]);
  assert.equal(result.summary.smallGroups.length, 0);
});

test("seven applicants are rebalanced without a one-person group", () => {
  const result = scheduleApplicants(applicants(7), slots, config);
  assert.deepEqual(groupSizes(result), [3, 4]);
  assert.equal(result.summary.smallGroups.length, 0);
});

test("non-morning slot is preferred when group quality is equal", () => {
  const result = scheduleApplicants(applicants(5, ["morning", "early"]), slots, config);
  assert.deepEqual(new Set(result.applicants.map((item) => item.assigned_slot)), new Set(["early"]));
});

test("avoiding morning outranks using an earlier date", () => {
  const result = scheduleApplicants(applicants(5, ["morning", "later"]), slots, config);
  assert.deepEqual(new Set(result.applicants.map((item) => item.assigned_slot)), new Set(["later"]));
});

test("a complete group outranks opening a smaller non-morning group", () => {
  const input = applicants(5, ["morning"]);
  for (let index = 0; index < 3; index += 1) input[index].available_slots.push("later");
  const result = scheduleApplicants(input, slots, config);
  assert.deepEqual(new Set(result.applicants.map((item) => item.assigned_slot)), new Set(["morning"]));
});

test("earlier date is preferred among non-morning slots", () => {
  const result = scheduleApplicants(applicants(5, ["early", "later"]), slots, config);
  assert.deepEqual(new Set(result.applicants.map((item) => item.assigned_slot)), new Set(["early"]));
});

test("valid existing assignment and seat are retained", () => {
  const input = applicants(1, ["early", "later"]);
  input[0].assigned_slot = "later";
  input[0].seat_no = "3";
  input[0].status = "scheduled";
  input[0]._wasExisting = true;
  const result = scheduleApplicants(input, slots, config);
  assert.equal(result.applicants[0].assigned_slot, "later");
  assert.equal(result.applicants[0].seat_no, "3");
});

test("a constrained applicant anchors a group before flexible applicants open another slot", () => {
  const input = applicants(5, ["early", "next"]);
  input.push({
    student_id: "32999999",
    name: "受限学生",
    available_slots: ["next"],
    assigned_slot: "",
    seat_no: "",
    status: "unassigned",
  });
  const result = scheduleApplicants(input, slots, config);
  assert.deepEqual(new Set(result.applicants.map((item) => item.assigned_slot)), new Set(["next"]));
  assert.deepEqual(groupSizes(result), [6]);
  assert.equal(result.summary.smallGroups.length, 0);
});

test("two-slot applicants are handled before applicants with three alternatives", () => {
  const input = applicants(5, ["early", "next", "later"]);
  input.push({
    student_id: "32999998",
    name: "较受限学生",
    available_slots: ["next", "later"],
    assigned_slot: "",
    seat_no: "",
    status: "unassigned",
  });
  const result = scheduleApplicants(input, slots, config);
  assert.deepEqual(groupSizes(result), [6]);
  assert.equal(result.summary.smallGroups.length, 0);
});
