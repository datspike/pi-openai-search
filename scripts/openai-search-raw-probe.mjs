import {
  SEARCH_PROOF_INCLUDE_FIELDS,
  SEARCH_PROOF_SCENARIOS,
  SearchProofError,
  aggregateVerdict,
  classifyRawResponse,
  formatProofHelp,
  isMainModule,
  loadModelClient,
  parseProofCliArgs,
  resolveAbsoluteExtensionPath,
} from "./openai-search-proof-lib.mjs";

/**
 * Запуск raw Responses probe по одному сценарию.
 *
 * @param {{client: any, model: any, scenario: "A" | "B"}} params Параметры probe.
 * @returns {Promise<{scenario: "A" | "B", verdict: "pass" | "blocker" | "fail", reason: string, summary: Record<string, unknown>}>} Итог сценария.
 */
async function runRawScenario({ client, model, scenario }) {
  const response = await client.responses.create({
    model: model.id,
    input: SEARCH_PROOF_SCENARIOS[scenario].prompt,
    tools: [{ type: "web_search", external_web_access: true }],
    include: SEARCH_PROOF_INCLUDE_FIELDS,
    parallel_tool_calls: true,
    store: false,
  });

  return classifyRawResponse(response, scenario);
}

/**
 * Основной entrypoint raw proof script.
 *
 * @returns {Promise<void>} Promise завершения.
 */
async function main() {
  const args = parseProofCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(formatProofHelp("scripts/openai-search-raw-probe.mjs"));
    return;
  }

  const extensionPath = resolveAbsoluteExtensionPath(args.extensionPath);
  const { client, model, agentDir } = await loadModelClient(args.modelRef);
  const scenarios = [];

  for (const scenario of args.scenarios) {
    scenarios.push(await runRawScenario({ client, model, scenario }));
  }

  console.log(
    JSON.stringify(
      {
        script: "openai-search-raw-probe",
        extensionPath,
        agentDir,
        model: `${model.provider}/${model.id}`,
        include: SEARCH_PROOF_INCLUDE_FIELDS,
        overallVerdict: aggregateVerdict(scenarios),
        scenarios,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    if (error instanceof SearchProofError) {
      console.error(
        JSON.stringify(
          {
            script: "openai-search-raw-probe",
            verdict: "fail",
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }

    console.error(
      JSON.stringify(
        {
          script: "openai-search-raw-probe",
          verdict: "fail",
          error: {
            code: "unexpected_error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
