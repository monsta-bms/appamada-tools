import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadCommentDates() {
  const context = vm.createContext({
    Utilities: { formatDate: () => "2026/08/18" },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    AppamadaAdminLogic: { failureState: () => "エラー" },
  });
  for (const file of ["Config.gs", "CommentDateNormalization.gs"]) {
    const source = await readFile(new URL(`../apps-script/admin/${file}`, import.meta.url), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return context;
}

test("all valid dot and slash dates outside URLs become YYYY/MM/DD", async () => {
  const context = await loadCommentDates();
  assert.equal(
    context.normalizeAdminCommentDates_("2025.2.23 / mid 2026/6/14 / 2026/06/30 end"),
    "2025/02/23 / mid 2026/06/14 / 2026/06/30 end",
  );
  assert.equal(
    context.normalizeAdminCommentDates_("URL https://example.com/2026/6/14?q=2025.2.23 2024.1.2"),
    "URL https://example.com/2026/6/14?q=2025.2.23 2024/01/02",
  );
});

test("invalid dates and digit-embedded candidates are preserved", async () => {
  const context = await loadCommentDates();
  assert.equal(
    context.normalizeAdminCommentDates_("2026/2/30 2025.13.1 x2025.2.3y 12025.2.23"),
    "2026/2/30 2025.13.1 x2025/02/03y 12025.2.23",
  );
});

test("Sheets Date values use Asia/Tokyo YYYY/MM/DD", async () => {
  const context = await loadCommentDates();
  assert.equal(context.normalizeAdminCommentDates_(new Date("2026-08-17T15:00:00Z")), "2026/08/18");
  assert.equal(
    context.normalizeAdminCommentDates_("Sun Aug 23 2026 00:00:00 GMT+0900 (日本標準時)"),
    "2026/08/23",
  );
});

test("migration plan reports exact changed, Date, and formula rows", async () => {
  const context = await loadCommentDates();
  const plan = context.buildAdminCommentDateNormalizationPlan_(
    [["2025.2.23"], ["2026/06/30 ok"], [new Date("2026-08-17T15:00:00Z")], ["0"]],
    [[""], [""], [""], ["=1"]],
    2,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(plan.normalized)), [
    ["2025/02/23"], ["2026/06/30 ok"], ["2026/08/18"], ["0"],
  ]);
  assert.deepEqual(Array.from(plan.changedRows), [2, 4]);
  assert.deepEqual(Array.from(plan.dateValueRows), [4]);
  assert.deepEqual(Array.from(plan.formulaRows), [5]);
  assert.equal(plan.nonEmptyRowCount, 4);
});
