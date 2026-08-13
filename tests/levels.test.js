import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_LEVELS,
  PUBLISH_LEVEL_ORDER,
  SPECIAL_LEVELS,
  STEP_LEVELS,
  getEasierLevel,
  getHarderLevel,
  isAllowedLevel,
  isSpecialLevel,
  isStepLevel,
} from "../src/levels.js";

test("allowed-level membership is exact", () => {
  assert.equal(isAllowedLevel("10+"), true);
  assert.equal(isAllowedLevel("hst1"), false);
  assert.equal(isAllowedLevel("sst1"), false);
  assert.equal(isAllowedLevel("zst1"), false);
  assert.equal(isAllowedLevel("穴1"), false);
});
test("step and special membership is separated", () => {
  assert.equal(isStepLevel("10+"), true);
  assert.equal(isStepLevel("?"), false);
  assert.equal(isSpecialLevel("★★4?"), true);
  assert.equal(isSpecialLevel("隔離"), true);
  assert.equal(isSpecialLevel("16"), false);
});

test("harder-level navigation follows STEP_LEVELS", () => {
  assert.equal(getHarderLevel("10"), "10+");
  assert.equal(getHarderLevel("10+"), "11-");
  assert.equal(getHarderLevel("16"), null);
  assert.equal(getHarderLevel("?"), null);
  assert.equal(getHarderLevel("★★4?"), null);
});

test("easier-level navigation follows STEP_LEVELS", () => {
  assert.equal(getEasierLevel("11-"), "10+");
  assert.equal(getEasierLevel("0"), null);
  assert.equal(getEasierLevel("?"), null);
});

test("all step and special levels are allowed", () => {
  for (const level of [...STEP_LEVELS, ...SPECIAL_LEVELS]) {
    assert.equal(isAllowedLevel(level), true, level);
  }
});

test("level arrays contain no duplicates", () => {
  for (const levels of [ALLOWED_LEVELS, STEP_LEVELS, SPECIAL_LEVELS, PUBLISH_LEVEL_ORDER]) {
    assert.equal(new Set(levels).size, levels.length);
  }
});

test("publish order records the current public JSON order", () => {
  assert.deepEqual(PUBLISH_LEVEL_ORDER.slice(-6), ["★★4?", "★★5?", "★★6?", "★★7?", "?", "隔離"]);
  assert.equal(PUBLISH_LEVEL_ORDER.length, ALLOWED_LEVELS.length);
});
