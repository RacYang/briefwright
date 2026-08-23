import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATE_SCHEMA = "briefwright.engineering.sql-gate.v1";
export const REQUIRED_ENVIRONMENT = [
  "BRIEFWRIGHT_TEST_POSTGRES_URL",
  "BRIEFWRIGHT_TEST_MYSQL_URL",
];
export const REQUIRED_TESTS = [
  "postgres control-plane contract creates, reads, compares, and transactionally updates canonical records",
  "mysql control-plane contract creates, reads, compares, and transactionally updates canonical records",
];

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function environmentState(environment) {
  return Object.fromEntries(REQUIRED_ENVIRONMENT.map((name) => [name, environment[name]?.trim() ? "present" : "missing"]));
}

function failedReceipt(environment, reason, errors, tests = null) {
  return {
    schema: GATE_SCHEMA,
    gate: "sql-control-plane-integration",
    result: "fail",
    reason,
    environment: environmentState(environment),
    requiredTests: REQUIRED_TESTS,
    tests,
    errors,
  };
}

export function evaluateSqlContractGate({ environment, execution }) {
  const missingEnvironment = REQUIRED_ENVIRONMENT.filter((name) => !environment[name]?.trim());
  if (missingEnvironment.length > 0) {
    return failedReceipt(
      environment,
      "missing_environment",
      missingEnvironment.map((name) => `${name} is required for the authoritative SQL lane`),
    );
  }

  if (!execution || execution.error || execution.status !== 0) {
    const detail = execution?.error
      ? `test process could not start: ${execution.error.message}`
      : `test process exited with ${execution?.status ?? "unknown"}`;
    return failedReceipt(environment, "test_process_failed", [detail]);
  }

  let summary;
  try {
    summary = JSON.parse(execution.stdout);
  } catch {
    return failedReceipt(environment, "invalid_test_summary", ["Vitest did not emit one valid JSON summary"]);
  }

  const assertions = (summary.testResults ?? []).flatMap((result) => result.assertionResults ?? []);
  const requiredMatches = Object.fromEntries(
    REQUIRED_TESTS.map((fullName) => [fullName, assertions.filter((assertion) => assertion.fullName === fullName)]),
  );
  const requiredStatuses = Object.fromEntries(
    Object.entries(requiredMatches).map(([fullName, matches]) => [fullName, matches.length === 1 ? matches[0].status : matches.length === 0 ? "missing" : "duplicate"]),
  );
  const errors = [];
  const total = Number(summary.numTotalTests ?? 0);
  const passed = Number(summary.numPassedTests ?? 0);
  const failed = Number(summary.numFailedTests ?? 0);
  const skipped = Number(summary.numPendingTests ?? 0);
  const todo = Number(summary.numTodoTests ?? 0);

  if (summary.success !== true) errors.push("Vitest summary is not successful");
  if (total !== REQUIRED_TESTS.length) errors.push(`Vitest reported ${total} tests; expected exactly ${REQUIRED_TESTS.length}`);
  if (passed !== REQUIRED_TESTS.length) errors.push(`Vitest reported ${passed} passed tests; expected exactly ${REQUIRED_TESTS.length}`);
  if (assertions.length !== total) errors.push(`Vitest assertion count ${assertions.length} does not match total ${total}`);
  if (assertions.filter((assertion) => assertion.status === "passed").length !== passed) errors.push("Vitest passed assertion count does not match its summary");
  if (failed !== 0) errors.push("Vitest reported failed tests");
  if (skipped !== 0) errors.push("Vitest reported skipped tests");
  if (todo !== 0) errors.push("Vitest reported todo tests");
  for (const [fullName, status] of Object.entries(requiredStatuses)) {
    if (status !== "passed") errors.push(`required test is ${status}: ${fullName}`);
  }

  const tests = {
    total,
    passed,
    failed,
    skipped,
    todo,
    requiredStatuses,
  };

  if (errors.length > 0) return failedReceipt(environment, "authoritative_tests_not_proven", errors, tests);

  return {
    schema: GATE_SCHEMA,
    gate: "sql-control-plane-integration",
    result: "pass",
    environment: environmentState(environment),
    requiredTests: REQUIRED_TESTS,
    tests,
    errors: [],
  };
}

export function runSqlContractGate({ environment = process.env, spawn = spawnSync } = {}) {
  const missingEnvironment = REQUIRED_ENVIRONMENT.some((name) => !environment[name]?.trim());
  if (missingEnvironment) return evaluateSqlContractGate({ environment, execution: null });

  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const execution = spawn(
    command,
    ["exec", "vitest", "run", "tests/control-plane-sql.integration.test.ts", "--reporter=json", "--allowOnly=false"],
    {
      cwd: path.resolve(repositoryRoot),
      env: environment,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return evaluateSqlContractGate({ environment, execution });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const receipt = runSqlContractGate();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = receipt.result === "pass" ? 0 : 1;
}
