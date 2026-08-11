function validateAdminApplication_(application, allowError) {
  var result = AppamadaAdminLogic.validateApplication(
    application.record,
    application.formulaMap,
    allowError,
  );
  if (!result.ok) throwAdminError_(result.code, result.detail, AppamadaAdminLogic.failureState(result.code));
  return application;
}

function validateAdminMasterFormulaFree_(sheet, rowNumber) {
  var formulas = sheet.getRange(rowNumber, 1, 1, 5).getFormulas()[0];
  if (formulas.some(function (formula) { return Boolean(formula); })) {
    throwAdminError_("CELL_FORMULA_NOT_ALLOWED", "kkj apply target contains a formula", "要確認");
  }
}
