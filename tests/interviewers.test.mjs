import assert from "node:assert/strict";
import test from "node:test";
import {
  compareInterviewerSnapshots,
  extractInterviewersFromValues,
  validateInterviewers,
} from "../scripts/lib/interviewers.mjs";

const config = { year: 2026, departments: ["社长层", "教育部"] };
const slots = [
  { slot_id: "s1", date: "2026-09-27", start: "10:00", end: "10:30", display_order: 1 },
  { slot_id: "s2", date: "2026-09-27", start: "10:40", end: "11:10", display_order: 2 },
  { slot_id: "s3", date: "2026-09-28", start: "19:00", end: "19:30", display_order: 3 },
];

function workbookValues() {
  return [
    ["全天", "", "面试官安排"],
    ["日期", "时间", "社长层", "教育部"],
    ["9月27日", "10:00-10:30", "甲", ""],
    ["", "10:40-11:10", "", "乙"],
    [],
    ["晚间", "", "面试官安排"],
    ["日期", "时间", "社长层", "教育部"],
    ["9月28日", "19:00-19:30", "丙、丁", ""],
  ];
}

test("manual interviewer cells are extracted by slot and department", () => {
  const result = extractInterviewersFromValues(workbookValues(), slots, config);
  assert.deepEqual(result, [
    { slot_id: "s1", department: "社长层", interviewers: "甲" },
    { slot_id: "s2", department: "教育部", interviewers: "乙" },
    { slot_id: "s3", department: "社长层", interviewers: "丙、丁" },
  ]);
});

test("blank workbook cells remove previously stored interviewer values", () => {
  const existing = [
    { slot_id: "s1", department: "社长层", interviewers: "旧甲" },
    { slot_id: "s2", department: "教育部", interviewers: "旧乙" },
  ];
  const latest = [{ slot_id: "s1", department: "社长层", interviewers: "新甲" }];
  assert.deepEqual(compareInterviewerSnapshots(existing, latest), {
    added: 0,
    updated: 1,
    removed: 1,
  });
});

test("changed department headers block interviewer import", () => {
  const values = workbookValues();
  values[1][2] = "未知部门";
  assert.throws(
    () => extractInterviewersFromValues(values, slots, config),
    /面试官部门栏与配置不一致/,
  );
});

test("missing schedule rows block interviewer import", () => {
  const values = workbookValues().slice(0, -3);
  assert.throws(
    () => extractInterviewersFromValues(values, slots, config),
    /排班表缺少已配置场次：s3/,
  );
});

test("duplicate slot and department rows fail validation", () => {
  const rows = [
    { slot_id: "s1", department: "社长层", interviewers: "甲" },
    { slot_id: "s1", department: "社长层", interviewers: "乙" },
  ];
  assert.match(validateInterviewers(rows, slots, config).errors.join("\n"), /Duplicate interviewer assignment/);
});
