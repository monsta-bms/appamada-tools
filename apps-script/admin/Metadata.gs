function createAdminMetadataValue_(application, details) {
  var value = {
    request_id: application.record.requestId,
    application_type: application.record.applicationType,
    application_row: application.rowNumber,
    original_level: application.record.originalLevel,
    target_level: application.record.targetLevel,
  };
  Object.keys(details || {}).forEach(function (key) { value[key] = details[key]; });
  return JSON.stringify(value);
}

function addAdminPlannedMetadata_(sheet, rowNumber, application, details) {
  var existing = sheet
    .createDeveloperMetadataFinder()
    .withKey(ADMIN_CONFIG.metadataKey)
    .find()
    .filter(function (metadata) {
      var row = metadata.getLocation().getRow();
      return row && row.getRow() === rowNumber;
    });
  if (existing.length) throwAdminError_("METADATA_CONFLICT", "planned metadata already exists", "要確認");
  sheet.getRange(rowNumber + ":" + rowNumber).addDeveloperMetadata(
    ADMIN_CONFIG.metadataKey,
    createAdminMetadataValue_(application, details),
    SpreadsheetApp.DeveloperMetadataVisibility.PROJECT,
  );
  var found = findAdminPlannedMetadataByRequestId_(sheet, application.record.requestId);
  if (found.length !== 1) throwAdminError_("METADATA_CONFLICT", "planned metadata was not created", "要確認");
  return found[0];
}

function parseAdminMetadata_(metadata) {
  try {
    var value = JSON.parse(metadata.getValue());
    if (!value || typeof value.request_id !== "string" || typeof value.application_type !== "string") {
      throw new Error("invalid shape");
    }
    return value;
  } catch (error) {
    throwAdminError_("RECOVERY_FAILED", "planned metadata JSON is invalid", "要確認");
  }
}

function findAllAdminPlannedMetadata_(sheet) {
  return sheet.createDeveloperMetadataFinder().withKey(ADMIN_CONFIG.metadataKey).find();
}

function findAdminPlannedMetadataByRequestId_(sheet, requestId) {
  return findAllAdminPlannedMetadata_(sheet).filter(function (metadata) {
    try {
      return JSON.parse(metadata.getValue()).request_id === requestId;
    } catch (error) {
      return false;
    }
  });
}

function requireAdminPlannedMetadataByRequestId_(sheet, requestId) {
  var found = findAdminPlannedMetadataByRequestId_(sheet, requestId);
  if (found.length !== 1) {
    throwAdminError_("METADATA_CONFLICT", "request_id must match exactly one planned metadata entry", "要確認");
  }
  return found[0];
}

function getAdminMetadataRow_(metadata) {
  var row = metadata.getLocation().getRow();
  if (!row) throwAdminError_("RECOVERY_FAILED", "planned metadata is not attached to a row", "要確認");
  return row.getRow();
}

function removeAdminPlannedMetadata_(metadata, requestId) {
  var value = parseAdminMetadata_(metadata);
  if (value.request_id !== requestId) {
    throwAdminError_("METADATA_CONFLICT", "metadata request_id does not match", "要確認");
  }
  metadata.remove();
}
