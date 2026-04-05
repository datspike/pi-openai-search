import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

let resolvedGsdBinPath;
let resolvedAgentBinPath;
let resolvedRuntimeDescriptor;

const PI_RUNTIME_KIND = "pi";
const GSD_RUNTIME_KIND = "gsd";

/**
 * Сброс кеша auto-discovery.
 *
 * @returns {void}
 */
export function resetGsdPiCompatCache() {
  resolvedGsdBinPath = undefined;
  resolvedAgentBinPath = undefined;
  resolvedRuntimeDescriptor = undefined;
}

/**
 * Чтение env-флага compat-слоя.
 *
 * @param {string | undefined} value Сырой env.
 * @param {boolean} fallback Значение по умолчанию.
 * @returns {boolean} Нормализованный флаг.
 */
export function parseCompatBoolean(value, fallback = true) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Определение пути к бинарю gsd через env или PATH.
 *
 * @returns {string} Абсолютный путь к бинарю.
 */
export function resolveGsdBinPath() {
  if (resolvedGsdBinPath) {
    return resolvedGsdBinPath;
  }

  const envBinPath = process.env.GSD_BIN_PATH?.trim();
  if (envBinPath) {
    resolvedGsdBinPath = envBinPath;
    return resolvedGsdBinPath;
  }

  const argvCandidate = process.argv.find((value) => typeof value === "string" && /(^|\/)gsd$/.test(value));
  if (argvCandidate && existsSync(argvCandidate)) {
    resolvedGsdBinPath = argvCandidate;
    return resolvedGsdBinPath;
  }

  const lookup = spawnSync("sh", ["-lc", "command -v gsd"], {
    encoding: "utf8",
  });
  const discoveredPath = String(lookup.stdout || "").trim();
  if (lookup.status === 0 && discoveredPath && existsSync(discoveredPath)) {
    resolvedGsdBinPath = discoveredPath;
    return resolvedGsdBinPath;
  }

  throw new Error("Не удалось определить путь к gsd binary. Укажи GSD_BIN_PATH или добавь gsd в PATH.");
}

/**
 * Определение пути к бинарю активного runtime.
 *
 * Приоритет:
 * 1. `PI_BIN_PATH`
 * 2. `GSD_BIN_PATH`
 * 3. argv текущего процесса
 * 4. `command -v pi`
 * 5. `command -v gsd`
 *
 * @returns {string} Абсолютный путь к бинарю.
 */
export function resolveAgentBinPath() {
  if (resolvedAgentBinPath) {
    return resolvedAgentBinPath;
  }

  const envPiBinPath = process.env.PI_BIN_PATH?.trim();
  if (envPiBinPath) {
    resolvedAgentBinPath = envPiBinPath;
    return resolvedAgentBinPath;
  }

  const envGsdBinPath = process.env.GSD_BIN_PATH?.trim();
  if (envGsdBinPath) {
    resolvedAgentBinPath = envGsdBinPath;
    return resolvedAgentBinPath;
  }

  const argvCandidate = process.argv.find(
    (value) => typeof value === "string" && /(^|\/)(pi|gsd)$/.test(value),
  );
  if (argvCandidate && existsSync(argvCandidate)) {
    resolvedAgentBinPath = argvCandidate;
    return resolvedAgentBinPath;
  }

  for (const command of ["pi", "gsd"]) {
    const lookup = spawnSync("sh", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
    });
    const discoveredPath = String(lookup.stdout || "").trim();
    if (lookup.status === 0 && discoveredPath && existsSync(discoveredPath)) {
      resolvedAgentBinPath = discoveredPath;
      return resolvedAgentBinPath;
    }
  }

  throw new Error(
    "Не удалось определить путь к runtime binary. Укажи PI_BIN_PATH или GSD_BIN_PATH, либо добавь pi/gsd в PATH.",
  );
}

/**
 * Определение корня установленного gsd-pi.
 *
 * @returns {string} Абсолютный путь к корню пакета.
 */
export function resolveGsdPiRoot() {
  const binPath = resolveGsdBinPath();

  const root = path.resolve(path.dirname(binPath), "..", "lib", "node_modules", "gsd-pi");
  if (!existsSync(root)) {
    throw new Error(`Корень gsd-pi не найден по вычисленному пути: ${root}`);
  }

  return root;
}

/**
 * Определение установленного runtime и его корня.
 *
 * @returns {{kind: "pi" | "gsd", binPath: string, root: string}} Дескриптор runtime.
 */
export function resolveRuntimeDescriptor() {
  if (resolvedRuntimeDescriptor) {
    return resolvedRuntimeDescriptor;
  }

  const binPath = resolveAgentBinPath();
  const rootCandidates = [
    {
      kind: PI_RUNTIME_KIND,
      root: path.resolve(path.dirname(binPath), "..", "lib", "node_modules", "@mariozechner", "pi-coding-agent"),
    },
    {
      kind: GSD_RUNTIME_KIND,
      root: path.resolve(path.dirname(binPath), "..", "lib", "node_modules", "gsd-pi"),
    },
  ];

  const matchingCandidate = rootCandidates.find((candidate) => existsSync(candidate.root));
  if (!matchingCandidate) {
    throw new Error(
      `Не удалось определить установленный runtime root рядом с binary ${binPath}. Проверены пути: ${rootCandidates.map((candidate) => candidate.root).join(", ")}`,
    );
  }

  resolvedRuntimeDescriptor = {
    kind: matchingCandidate.kind,
    binPath,
    root: matchingCandidate.root,
  };
  return resolvedRuntimeDescriptor;
}

/**
 * Корень активного runtime.
 *
 * @returns {string} Абсолютный путь к корню runtime.
 */
export function resolveRuntimeRoot() {
  return resolveRuntimeDescriptor().root;
}

/**
 * Переписывание legacy gsd-path в layout standalone pi runtime.
 *
 * @param {string} relativePath Путь относительно gsd layout.
 * @returns {string} Путь для standalone pi layout.
 */
function rewriteRelativePathForPi(relativePath) {
  if (relativePath.startsWith("packages/pi-coding-agent/dist/")) {
    return relativePath.replace(/^packages\/pi-coding-agent\/dist\//u, "dist/");
  }
  if (relativePath.startsWith("packages/pi-ai/dist/")) {
    return relativePath.replace(/^packages\/pi-ai\/dist\//u, "node_modules/@mariozechner/pi-ai/dist/");
  }
  if (relativePath.startsWith("node_modules/@gsd/pi-tui/dist/")) {
    return relativePath.replace(/^node_modules\/@gsd\/pi-tui\/dist\//u, "node_modules/@mariozechner/pi-tui/dist/");
  }
  return relativePath;
}

/**
 * Подбор возможных путей модуля для активного runtime.
 *
 * @param {string} relativePath Путь в legacy формате.
 * @returns {string[]} Список кандидатов относительно runtime root.
 */
function buildRuntimeModuleCandidates(relativePath) {
  const { kind } = resolveRuntimeDescriptor();
  const candidates = [relativePath];

  if (kind === PI_RUNTIME_KIND) {
    candidates.unshift(rewriteRelativePathForPi(relativePath));
  }

  return [...new Set(candidates)];
}

/**
 * Импорт внутреннего модуля gsd-pi по относительному пути.
 *
 * @param {string} relativePath Путь относительно корня gsd-pi.
 * @returns {Promise<any>} Импортированный модуль.
 */
export async function importGsdPiModule(relativePath) {
  const root = resolveRuntimeRoot();
  const candidates = buildRuntimeModuleCandidates(relativePath);

  for (const candidate of candidates) {
    const modulePath = path.join(root, candidate);
    if (!existsSync(modulePath)) {
      continue;
    }
    return import(pathToFileURL(modulePath).href);
  }

  throw new Error(
    `Модуль runtime не найден: ${relativePath}. Проверены пути: ${candidates.map((candidate) => path.join(root, candidate)).join(", ")}`,
  );
}

/**
 * Импорт внутреннего модуля активного runtime.
 *
 * @param {string} relativePath Путь в legacy gsd layout.
 * @returns {Promise<any>} Импортированный модуль.
 */
export async function importRuntimeModule(relativePath) {
  return importGsdPiModule(relativePath);
}

/**
 * Безопасная регистрация compat-слоя с fail-open деградацией.
 *
 * @param {string} featureName Название compat-фичи.
 * @param {() => Promise<any>} loader Функция загрузки/регистрации.
 * @param {string | undefined} envFlag Значение env-флага.
 * @returns {Promise<{enabled: boolean, applied: boolean, reason?: string, error?: Error}>} Результат регистрации.
 */
export async function registerCompatLayer(featureName, loader, envFlag) {
  if (!parseCompatBoolean(envFlag, true)) {
    return {
      enabled: false,
      applied: false,
      reason: `${featureName} disabled by env`,
    };
  }

  try {
    await loader();
    return {
      enabled: true,
      applied: true,
    };
  } catch (error) {
    return {
      enabled: true,
      applied: false,
      reason: `${featureName} compat unavailable`,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
