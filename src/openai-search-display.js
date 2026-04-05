export {
  appendStructuredCitations,
  buildWebSearchResultContent,
  dedupeSources,
  extractActionSources,
  extractAnnotationSources,
  extractInlineSourcesFromText,
  extractResultSources,
  extractStructuredSearchCallSources,
  extractUrlsFromText,
  normalizeSource,
  resolveWebSearchResultSources,
} from "./core/truthful/search-results.js";
export {
  formatFactualSearchDescriptor,
  formatTruthfulWebSearchDoneLabel,
  formatTruthfulWebSearchPendingLabel,
  formatWebSearchResult,
  formatWebSearchResultStatus,
  getFactualSearchLifecycleUpdate,
  summarizeSearchInput,
} from "./core/lifecycle/search-status.js";
