import test from "node:test";
import assert from "node:assert/strict";

import {
  appendStructuredCitations,
  buildWebSearchResultContent,
  extractInlineSourcesFromText,
  extractResultSources,
  extractStructuredSearchCallSources,
  resolveWebSearchResultSources,
} from "../../src/core/truthful/search-results.js";

test("appendStructuredCitations appends only missing URLs", () => {
  const text = "Короткий ответ без ссылок.";
  const next = appendStructuredCitations(text, [
    { title: "OpenAI docs", url: "https://platform.openai.com/docs/guides/tools-web-search" },
    { title: "OpenAI docs", url: "https://platform.openai.com/docs/guides/tools-web-search" },
  ]);

  assert.match(next, /Источники:/);
  assert.match(next, /tools-web-search/);

  const preserved = appendStructuredCitations(next, [
    { title: "OpenAI docs", url: "https://platform.openai.com/docs/guides/tools-web-search" },
  ]);
  assert.equal(preserved, next);
});

test("extractResultSources normalizes results-only payload and drops malformed entries", () => {
  const result = extractResultSources([
    { title: "Result source", url: "https://example.com/result" },
    { source: { title: "Nested result", url: "https://example.com/nested" } },
    { url_citation: { title: "Citation result", url: "https://example.com/citation" } },
    { title: "Missing URL" },
    { source: { title: "Missing nested URL" } },
    { title: "Duplicate result", url: "https://example.com/result" },
    null,
  ]);

  assert.deepEqual(result, [
    { title: "Result source", url: "https://example.com/result" },
    { title: "Nested result", url: "https://example.com/nested" },
    { title: "Citation result", url: "https://example.com/citation" },
  ]);
});

test("extractStructuredSearchCallSources merges action.sources and results without cross-contamination", () => {
  const result = extractStructuredSearchCallSources(
    {
      sources: [
        { title: "Action source", url: "https://example.com/action" },
        { title: "Duplicate from action", url: "https://example.com/result" },
      ],
    },
    [
      { title: "Result source", url: "https://example.com/result" },
      { title: "Malformed result" },
    ],
  );

  assert.deepEqual(result, [
    { title: "Action source", url: "https://example.com/action" },
    { title: "Duplicate from action", url: "https://example.com/result" },
  ]);
});

test("resolveWebSearchResultSources ignores synthetic fallback when structured inputs are absent", () => {
  const result = resolveWebSearchResultSources(
    [],
    [],
    [{ title: "Fallback source", url: "https://example.com/fallback" }],
  );

  assert.deepEqual(result, []);
  assert.deepEqual(buildWebSearchResultContent(result), {
    type: "web_search_tool_result_complete",
  });
});

test("extractInlineSourcesFromText extracts markdown links before plain URLs", () => {
  const result = extractInlineSourcesFromText(
    "- [OpenAI acquires TBPN](https://www.axios.com/2026/04/02/openai-acquires-tbpn)\n- Raw URL: https://openai.com/index/openai-acquires-tbpn",
  );

  assert.deepEqual(result, [
    {
      title: "OpenAI acquires TBPN",
      url: "https://www.axios.com/2026/04/02/openai-acquires-tbpn",
    },
    {
      title: "https://openai.com/index/openai-acquires-tbpn",
      url: "https://openai.com/index/openai-acquires-tbpn",
    },
  ]);
});
