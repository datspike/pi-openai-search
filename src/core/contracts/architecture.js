export const SUPPORTED_RUNTIME = Object.freeze({
  product: "standalone-pi",
  provider: "openai",
  api: "openai-responses",
});

export const ARCHITECTURE_LAYERS = Object.freeze({
  core: {
    stability: "stable",
    namespace: "src/core",
    description: "Поддерживаемый core-first слой на публичных extension hooks.",
    forbiddenImports: Object.freeze([
      "pi-ai/dist/**",
      "@mariozechner/pi-coding-agent/dist/**",
      "src/compat/**",
      "node_modules/**/dist/**",
    ]),
    inputs: Object.freeze([
      "model_select",
      "before_provider_request",
      "message_update",
      "message_end",
    ]),
    outputs: Object.freeze([
      "payload mutation",
      "truthful source set",
      "status state",
    ]),
  },
  compat: {
    stability: "experimental",
    namespace: "src/compat",
    description: "Опциональный compat-слой для runtime/UI internals standalone pi.",
    allowedImports: Object.freeze([
      "pi-ai/dist/**",
      "@mariozechner/pi-coding-agent/dist/**",
      "node_modules/**/dist/**",
    ]),
    outputs: Object.freeze([
      "optional renderer patch",
      "optional provider override",
      "runtime warning",
    ]),
  },
});

export const CANONICAL_SOURCE_EVIDENCE = Object.freeze({
  documentedStructured: Object.freeze([
    "web_search_call.action.sources",
    "message.output_text.annotations",
  ]),
  observedNonStructured: Object.freeze([
    "web_search_call.results",
    "inline_urls_in_final_text",
  ]),
  forbiddenSyntheticFallbacks: Object.freeze([
    "synthetic citations",
    "synthetic query labels",
    "prompt-derived search artifacts",
    "fabricated webSearchResult blocks",
  ]),
});

export const ENV_TAXONOMY = Object.freeze({
  stable: Object.freeze([
    "PI_OPENAI_NATIVE_SEARCH",
    "PI_OPENAI_NATIVE_SEARCH_MODE",
    "PI_OPENAI_NATIVE_SEARCH_CONTEXT_SIZE",
    "PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS",
    "PI_OPENAI_NATIVE_SEARCH_COUNTRY",
    "PI_OPENAI_NATIVE_SEARCH_REGION",
    "PI_OPENAI_NATIVE_SEARCH_CITY",
    "PI_OPENAI_NATIVE_SEARCH_TIMEZONE",
    "PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE",
    "PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE",
  ]),
  experimental: Object.freeze([
    "PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT",
    "PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT",
    "PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT",
    "PI_BIN_PATH",
    "PI_AGENT_DIR",
  ]),
});

export const CANONICAL_CONTRACT_MAP = Object.freeze({
  supportedRuntime: SUPPORTED_RUNTIME,
  layers: ARCHITECTURE_LAYERS,
  sourceEvidence: CANONICAL_SOURCE_EVIDENCE,
  env: ENV_TAXONOMY,
});
