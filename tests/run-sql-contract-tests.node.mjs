import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_TESTS,
  evaluateSqlContractGate,
  runSqlContractGate,
} from "../scripts/run-sql-contract-tests.mjs";

const environment = {
  BRIEFWRIGHT_TEST_POSTGRES_URL: "postgresql://test.invalid/briefwright",
  BRIEFWRIGHT_TEST_MYSQL_URL: "mysql://test.invalid/briefwright",
};
const require = createRequire(import.meta.url);

function summary(statuses = ["passed", "passed"]) {
  const assertionResults = REQUIRED_TESTS.map((fullName, index) => ({ fullName, status: statuses[index] }));
  const passed = statuses.filter((status) => status === "passed").length;
  const skipped = statuses.filter((status) => status === "skipped").length;
  const failed = statuses.filter((status) => status === "failed").length;
  return {
    numTotalTests: statuses.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: skipped,
    numTodoTests: 0,
    success: failed === 0,
    testResults: [{ assertionResults }],
  };
}

function execution(testSummary, status = 0) {
  return { status, stdout: JSON.stringify(testSummary) };
}

test("accepts only the two named authoritative database tests when both pass", () => {
  const receipt = evaluateSqlContractGate({ environment, execution: execution(summary()) });
  assert.equal(receipt.result, "pass");
  assert.deepEqual(Object.values(receipt.tests.requiredStatuses), ["passed", "passed"]);
});

test("the executable gate invokes the exact suite with focused tests disabled", () => {
  let invocation;
  const receipt = runSqlContractGate({
    environment,
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return execution(summary());
    },
  });
  assert.equal(receipt.result, "pass");
  assert.equal(invocation.args.includes("tests/control-plane-sql.integration.test.ts"), true);
  assert.equal(invocation.args.includes("--allowOnly=false"), true);
  assert.equal(invocation.options.env, environment);
});

test("rejects the historical two-skipped false green", () => {
  const receipt = evaluateSqlContractGate({ environment, execution: execution(summary(["skipped", "skipped"])) });
  assert.equal(receipt.result, "fail");
  assert.equal(receipt.reason, "authoritative_tests_not_proven");
  assert.equal(receipt.tests.skipped, 2);
});

test("rejects zero executed tests even when the runner says success", () => {
  const receipt = evaluateSqlContractGate({
    environment,
    execution: execution({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: true,
      testResults: [],
    }),
  });
  assert.equal(receipt.result, "fail");
  assert.match(receipt.errors.join("\n"), /required test is missing/);
});

test("rejects a stale summary whose counters say zero but assertions still say passed", () => {
  const stale = summary();
  stale.numTotalTests = 0;
  stale.numPassedTests = 0;
  const receipt = evaluateSqlContractGate({ environment, execution: execution(stale) });
  assert.equal(receipt.result, "fail");
  assert.match(receipt.errors.join("\n"), /expected exactly 2|does not match total/);
});

test("rejects a renamed or missing required suite", () => {
  const altered = summary();
  altered.testResults[0].assertionResults[0].fullName = "unrelated passing test";
  const receipt = evaluateSqlContractGate({ environment, execution: execution(altered) });
  assert.equal(receipt.result, "fail");
  assert.match(receipt.errors.join("\n"), /required test is missing/);
});

test("rejects a non-zero child process", () => {
  const receipt = evaluateSqlContractGate({ environment, execution: execution(summary(), 1) });
  assert.equal(receipt.result, "fail");
  assert.equal(receipt.reason, "test_process_failed");
});

test("real Vitest rejects a focused test when allowOnly is false", () => {
  const root = mkdtempSync(path.join(tmpdir(), "briefwright-focused-test-"));
  try {
    const fixture = path.join(root, "focused.test.mjs");
    writeFileSync(fixture, 'test.only("focused", () => { expect(1).toBe(1); });\n', "utf8");
    const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    const result = spawnSync(process.execPath, [vitest, "run", "--root", root, fixture, "--globals", "--allowOnly=false"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unexpected \.only modifier|allowOnly/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails before spawning when either database target is absent", () => {
  let spawned = false;
  const receipt = runSqlContractGate({
    environment: { BRIEFWRIGHT_TEST_POSTGRES_URL: environment.BRIEFWRIGHT_TEST_POSTGRES_URL },
    spawn: () => { spawned = true; },
  });
  assert.equal(spawned, false);
  assert.equal(receipt.result, "fail");
  assert.equal(receipt.reason, "missing_environment");
});

test("the CLI missing-environment path exits non-zero and does not print secret values", () => {
  const script = fileURLToPath(new URL("../scripts/run-sql-contract-tests.mjs", import.meta.url));
  const cliEnvironment = { ...process.env, UNRELATED_SECRET: "must-not-be-printed" };
  delete cliEnvironment.BRIEFWRIGHT_TEST_POSTGRES_URL;
  delete cliEnvironment.BRIEFWRIGHT_TEST_MYSQL_URL;
  const result = spawnSync(process.execPath, [script], {
    env: cliEnvironment,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.result, "fail");
  assert.equal(receipt.environment.BRIEFWRIGHT_TEST_POSTGRES_URL, "missing");
  assert.doesNotMatch(result.stdout, /postgresql:\/\//);
  assert.doesNotMatch(result.stdout, /must-not-be-printed/);
});
