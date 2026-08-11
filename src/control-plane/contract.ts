import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";

import type { CanonicalControlRecord } from "./types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(readFileSync(path.join(root, "schemas/control-plane-record.schema.json"), "utf8")) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
(formatsModule as unknown as FormatsPlugin)(ajv);
const validate = ajv.compile(schema);

export function validateControlRecords(records: CanonicalControlRecord[]): void {
  const failures: string[] = [];
  for (const record of records) {
    const label = `${record.kind}:${record.id}`;
    if (!validate(record as unknown)) failures.push(`${label}: ${(validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ")}`);
  }
  if (failures.length) throw new Error(`Canonical control-plane contract rejected ${failures.length} record(s): ${failures.slice(0, 10).join(" | ")}`);
}
