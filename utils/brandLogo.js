/**
 * Branch / warehouse receipt & invoice brand logos (frontend public paths).
 */
const BRAND_LOGOS = {
  petzone: '/petzonelogo.png',
  petfamily: '/petfamilylogo.png',
};

const normalizeBrand = (brand) => {
  const key = String(brand || 'petzone').toLowerCase().trim();
  return BRAND_LOGOS[key] ? key : 'petzone';
};

const resolveBrandLogoPath = (brand) => BRAND_LOGOS[normalizeBrand(brand)];

const parseSettings = (settings) => {
  if (!settings) return {};
  if (typeof settings === 'object') return settings;
  try {
    return JSON.parse(settings);
  } catch (_) {
    return {};
  }
};

/** Attach brand + logoUrl from settings (or top-level brand). */
const withBrandFields = (entity = {}, settingsOverride) => {
  const settings = settingsOverride !== undefined
    ? parseSettings(settingsOverride)
    : parseSettings(entity.settings);
  const brand = normalizeBrand(settings.brand || entity.brand);
  return {
    brand,
    logoUrl: resolveBrandLogoPath(brand),
  };
};

module.exports = {
  BRAND_LOGOS,
  normalizeBrand,
  resolveBrandLogoPath,
  parseSettings,
  withBrandFields,
};
