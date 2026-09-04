export const PI_BASELINE_VERSION = "0.85.0";

export const COMPAT_FEATURES = Object.freeze({
  providerCompat: "provider-compat",
  interactiveInline: "interactive-inline",
  toolRender: "tool-render",
});

export const COMPAT_STATUSES = Object.freeze({
  supported: "supported",
  unsupported: "unsupported",
  unavailable: "unavailable",
  partial: "partial",
});

/**
 * Построение статуса compat-фичи.
 *
 * @param {string} feature Идентификатор фичи.
 * @param {{enabled?: boolean, status?: string, supported?: boolean, reason?: string, diagnostics?: string[]}} options Параметры статуса.
 * @returns {{feature: string, enabled: boolean, status: string, supported: boolean, reason?: string, diagnostics: string[]}} Нормализованный статус.
 */
export function createCompatFeatureStatus(feature, options = {}) {
  const enabled = options.enabled !== false;
  const status = options.status || (options.supported ? COMPAT_STATUSES.supported : COMPAT_STATUSES.unavailable);
  const supported = options.supported === true || status === COMPAT_STATUSES.supported;

  return {
    feature,
    enabled,
    status,
    supported,
    reason: options.reason,
    diagnostics: Array.isArray(options.diagnostics) ? options.diagnostics : [],
  };
}

/**
 * Статус отключённой env-флагом compat-фичи.
 *
 * @param {string} feature Идентификатор фичи.
 * @returns {{feature: string, enabled: boolean, status: string, supported: boolean, reason: string, diagnostics: string[]}} Статус фичи.
 */
export function createDisabledCompatFeatureStatus(feature) {
  return createCompatFeatureStatus(feature, {
    enabled: false,
    status: COMPAT_STATUSES.unavailable,
    supported: false,
    reason: `${feature} disabled by env`,
  });
}

/**
 * Классификация версии standalone pi.
 *
 * @param {string | undefined} version Обнаруженная версия.
 * @returns {{baseline: string, detected?: string, status: string, diagnostics: string[]}} Нормализованная версия.
 */
export function classifyPiVersion(version) {
  if (!version) {
    return {
      baseline: PI_BASELINE_VERSION,
      detected: undefined,
      status: "unknown",
      diagnostics: ["Версия standalone pi не определена; используется capability-first compat probing."],
    };
  }

  if (version === PI_BASELINE_VERSION) {
    return {
      baseline: PI_BASELINE_VERSION,
      detected: version,
      status: "supported",
      diagnostics: [],
    };
  }

  return {
    baseline: PI_BASELINE_VERSION,
    detected: version,
    status: "unknown",
    diagnostics: [
      `Обнаружена непроверенная версия standalone pi ${version}; compat допускается только по успешному capability probe.`,
    ],
  };
}

/**
 * Итоговый статус compat summary.
 *
 * @param {Record<string, {enabled: boolean, supported: boolean}>} features Карта feature status.
 * @returns {"supported" | "partial" | "unavailable"} Сводный статус.
 */
export function summarizeCompatStatus(features) {
  const values = Object.values(features || {});
  const enabledValues = values.filter((feature) => feature?.enabled !== false);

  if (enabledValues.length === 0) {
    return "unavailable";
  }

  const supportedCount = enabledValues.filter((feature) => feature?.supported).length;
  if (supportedCount === enabledValues.length) {
    return "supported";
  }
  if (supportedCount > 0) {
    return "partial";
  }
  return "unavailable";
}

/**
 * Пользовательские warning для недоступных compat-фич.
 *
 * @param {Record<string, {enabled: boolean, supported: boolean, reason?: string}>} features Карта feature status.
 * @returns {string[]} User-facing warnings.
 */
export function buildCompatWarnings(features) {
  return [...new Set(Object.values(features || {})
    .filter((feature) => feature?.enabled && !feature?.supported)
    .map((feature) => feature.reason || `${feature.feature} compat unavailable`))];
}
