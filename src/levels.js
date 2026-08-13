export const STEP_LEVELS = Object.freeze([
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10-",
  "10",
  "10+",
  "11-",
  "11",
  "11+",
  "12-",
  "12",
  "12+",
  "13",
  "13+",
  "14",
  "15",
  "16",
]);

export const SPECIAL_LEVELS = Object.freeze(["?", "★★4?", "★★5?", "★★6?", "★★7?", "隔離"]);

export const ALLOWED_LEVELS = Object.freeze([...STEP_LEVELS, ...SPECIAL_LEVELS]);

// 現在の公開JSON順を維持するための暫定順序。
// header.jsonとの不一致は別Issue。
export const PUBLISH_LEVEL_ORDER = Object.freeze([
  ...STEP_LEVELS,
  "★★4?",
  "★★5?",
  "★★6?",
  "★★7?",
  "?",
  "隔離",
]);

const ALLOWED_LEVEL_SET = new Set(ALLOWED_LEVELS);
const STEP_LEVEL_SET = new Set(STEP_LEVELS);
const SPECIAL_LEVEL_SET = new Set(SPECIAL_LEVELS);

export function isAllowedLevel(level) {
  return ALLOWED_LEVEL_SET.has(level);
}
export function isStepLevel(level) {
  return STEP_LEVEL_SET.has(level);
}

export function isSpecialLevel(level) {
  return SPECIAL_LEVEL_SET.has(level);
}

export function getHarderLevel(level) {
  const index = STEP_LEVELS.indexOf(level);
  return index >= 0 && index < STEP_LEVELS.length - 1 ? STEP_LEVELS[index + 1] : null;
}

export function getEasierLevel(level) {
  const index = STEP_LEVELS.indexOf(level);
  return index > 0 ? STEP_LEVELS[index - 1] : null;
}
