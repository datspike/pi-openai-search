import {
  SearchProofError,
  aggregateVerdict,
  buildVerifierCommand,
  classifyVerifierJsonl,
  formatProofHelp,
  formatProofTimestamp,
  isMainModule,
  parseJsonlEvents,
  parseProofCliArgs,
  resolveAbsoluteExtensionPath,
  runSpawnVerifierHarness,
  stampScenarioResult,
} from "./openai-search-proof-lib.mjs";

/**
 * Запуск verifier harness по одному сценарию.
 *
 * @param {{extensionPath: string, modelRef: string, scenario: "A" | "B"}} params Параметры сценария.
 * @returns {{scenario: "A" | "B", verdict: "pass" | "blocker" | "fail", reason: string, summary: Record<string, unknown>}} Итог сценария.
 */
function runVerifierScenario({ extensionPath, modelRef, scenario }) {
  const command = buildVerifierCommand({ extensionPath, modelRef, scenario });
  const harness = runSpawnVerifierHarness({ command });
  const events = parseJsonlEvents(harness.stdout);
  const classification = classifyVerifierJsonl(events, scenario);

  return {
    ...classification,
    summary: {
      command,
      stdoutBytes: harness.stdoutBytes,
      durationMs: harness.durationMs,
      ...classification.summary,
    },
  };
}

/**
 * Основной entrypoint verifier script.
 *
 * @returns {void} Завершение процесса.
 */
function main() {
  const args = parseProofCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(formatProofHelp("scripts/verify-openai-search-proof.mjs"));
    return;
  }

  const extensionPath = resolveAbsoluteExtensionPath(args.extensionPath);
  const capturedAt = formatProofTimestamp();
  const scenarios = args.scenarios.map((scenario) =>
    stampScenarioResult(
      runVerifierScenario({
        extensionPath,
        modelRef: args.modelRef,
        scenario,
      }),
    ),
  );
  const overallVerdict = aggregateVerdict(scenarios);

  console.log(
    JSON.stringify(
      {
        script: "verify-openai-search-proof",
        capturedAt,
        extensionPath,
        model: args.modelRef,
        maxBufferBytes: 1024 * 1024,
        overallVerdict,
        scenarios,
      },
      null,
      2,
    ),
  );

  if (overallVerdict === "fail") {
    process.exitCode = 1;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof SearchProofError) {
      console.error(
        JSON.stringify(
          {
            script: "verify-openai-search-proof",
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
    } else {
      console.error(
        JSON.stringify(
          {
            script: "verify-openai-search-proof",
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
    }
  }
}
