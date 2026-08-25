import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadRecentTableGenerator() {
  const context = vm.createContext({
    ADMIN_CONFIG: { timezone: "Asia/Tokyo" },
    AppamadaAdminLogic: {
      PUBLISH_LEVEL_ORDER: [
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
        "10-", "10", "10+", "11-", "11", "11+", "12-", "12", "12+",
        "13-", "13", "13+", "14", "15", "16", "★★4?", "★★5?", "★★6?", "★★7?", "隔離", "?",
      ],
    },
    Utilities: { formatDate: () => "2026/08/25" },
    Object,
  });
  const source = await readFile(
    new URL("../apps-script/admin/RecentTableGenerator.gs", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, context, { filename: "RecentTableGenerator.gs" });
  return context;
}

test("leading difficulty-change histories are excluded from recent tables", async () => {
  const context = await loadRecentTableGenerator();
  const today = context.parseRecentTableDateOrdinal_("2026/08/25");
  const rows = [
    ["6", "new today", "", "1", "2026/08/25 new"],
    ["6", "change today", "", "2", "2026/08/25 4→6"],
    ["7", "change on cutoff", "", "3", "2026/08/23 10-→7"],
    ["7", "new on cutoff", "", "4", "2026/08/23 imported"],
    ["7", "too old", "", "5", "2026/08/22 imported"],
    ["6", "new then changed", "", "6", "2026/08/24 imported / 2026/08/25 4→6"],
    ["6", "arrow in ordinary comment", "", "7", "2026/08/25 note 4→6"],
  ];

  const selected = context.filterRecentTableRows_(rows, 3, today);
  assert.deepEqual(
    selected.map((row) => row[1]),
    ["new today", "new on cutoff", "new then changed", "arrow in ordinary comment"],
  );
});

test("difficulty-change detection accepts current level symbols only at the start", async () => {
  const context = await loadRecentTableGenerator();
  assert.equal(context.isRecentTableDifficultyChangeComment_("2026/08/25 4→6"), true);
  assert.equal(context.isRecentTableDifficultyChangeComment_("2026/08/23 10-→7 / memo"), true);
  assert.equal(context.isRecentTableDifficultyChangeComment_("2026/08/25 隔離→?"), true);
  assert.equal(context.isRecentTableDifficultyChangeComment_("2026/08/25 new / 4→6"), false);
  assert.equal(context.isRecentTableDifficultyChangeComment_("note 2026/08/25 4→6"), false);
  assert.equal(context.isRecentTableDifficultyChangeComment_("2026/08/25 before→after"), false);
});

test("three-day generation overwrites the 3日前 sheet with a three-day window", async () => {
  const context = await loadRecentTableGenerator();
  let called;
  context.generateRecentTable_ = (sheetName, windowDays) => {
    called = { sheetName, windowDays };
    return called;
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.generateRecentThreeDayTable())),
    { sheetName: "3日前", windowDays: 3 },
  );
  assert.deepEqual(called, { sheetName: "3日前", windowDays: 3 });
});
