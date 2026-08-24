/**
 * Normalize POS / API sale lines into inventory vs clinic service lines.
 */
function parsePositiveInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractClinicIdFromSku(sku) {
  if (!sku) return null;
  const m = String(sku).trim().match(/^CLINIC-(\d+)$/i);
  return m ? parsePositiveInt(m[1]) : null;
}

function extractClinicIdFromCartId(id) {
  if (id === null || id === undefined) return null;
  const m = String(id).trim().match(/^service-(\d+)$/i);
  return m ? parsePositiveInt(m[1]) : null;
}

/**
 * @returns {{ isClinic: boolean, clinicServiceId: number|null, inventoryItemId: number|null, sku: string|null }}
 */
function normalizeSaleLineIdentity(item = {}) {
  let clinicServiceId =
    parsePositiveInt(item.clinicServiceId) ||
    parsePositiveInt(item.clinic_service_id) ||
    extractClinicIdFromSku(item.sku) ||
    extractClinicIdFromCartId(item.id) ||
    null;

  const flaggedService = Boolean(item.isService || item.is_service);
  if (!clinicServiceId && flaggedService) {
    clinicServiceId =
      parsePositiveInt(item.clinicServiceId) ||
      parsePositiveInt(item.id) ||
      null;
  }

  let inventoryItemId =
    parsePositiveInt(item.inventoryItemId) ||
    parsePositiveInt(item.inventory_item_id) ||
    null;

  // Clinic lines must never keep an inventory id on NEW sales
  if (clinicServiceId || flaggedService) {
    inventoryItemId = null;
  }

  // String cart ids like "service-3" must not become inventory ids
  if (!clinicServiceId && !inventoryItemId) {
    const rawId = item.id;
    if (typeof rawId === 'string' && rawId.startsWith('service-')) {
      clinicServiceId = extractClinicIdFromCartId(rawId);
    }
  }

  const isClinic = Boolean(clinicServiceId) || flaggedService;
  let sku = item.sku || null;
  if (isClinic) {
    if (!sku || !/^CLINIC-/i.test(String(sku))) {
      sku = clinicServiceId ? `CLINIC-${clinicServiceId}` : (sku || `CLINIC-${Date.now()}`);
    }
  }

  return {
    isClinic,
    clinicServiceId: isClinic ? clinicServiceId : null,
    inventoryItemId: isClinic ? null : inventoryItemId,
    sku,
  };
}

/**
 * SQL: clinic service lines (alias `si`).
 * - tagged clinic_service_id
 * - CLINIC-* sku from POS services
 * - OR line name matches a clinic_services catalog name (legacy inventory-sold services)
 */
const CLINIC_LINE_SQL = `(
  si.clinic_service_id IS NOT NULL
  OR UPPER(COALESCE(si.sku, '')) LIKE 'CLINIC-%'
  OR EXISTS (
    SELECT 1 FROM clinic_services _cs
    WHERE CONVERT(LOWER(TRIM(_cs.name)) USING utf8mb4) COLLATE utf8mb4_unicode_ci
        = CONVERT(LOWER(TRIM(si.name)) USING utf8mb4) COLLATE utf8mb4_unicode_ci
  )
)`;

/**
 * SQL: inventory product lines (alias `si`) — excludes clinic services.
 * Keeps inventory_item_id for stocked products only.
 */
const PRODUCT_LINE_SQL = `(
  si.inventory_item_id IS NOT NULL
  AND si.clinic_service_id IS NULL
  AND UPPER(COALESCE(si.sku, '')) NOT LIKE 'CLINIC-%'
  AND NOT EXISTS (
    SELECT 1 FROM clinic_services _cs
    WHERE CONVERT(LOWER(TRIM(_cs.name)) USING utf8mb4) COLLATE utf8mb4_unicode_ci
        = CONVERT(LOWER(TRIM(si.name)) USING utf8mb4) COLLATE utf8mb4_unicode_ci
  )
)`;

module.exports = {
  parsePositiveInt,
  extractClinicIdFromSku,
  extractClinicIdFromCartId,
  normalizeSaleLineIdentity,
  CLINIC_LINE_SQL,
  PRODUCT_LINE_SQL,
};
