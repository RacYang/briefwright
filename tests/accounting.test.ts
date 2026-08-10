import { describe, expect, it } from "vitest";

import { countReceipts } from "../src/core/accounting.js";

describe("due-source accounting", () => {
  it("accounts for exactly one result per due source", () => {
    expect(
      countReceipts(
        ["A", "B", "C"],
        [
          { sourceId: "A", result: "updated" },
          { sourceId: "B", result: "unchanged" },
          { sourceId: "C", result: "failed" },
        ],
      ),
    ).toEqual({ due: 3, observed: 0, updated: 1, unchanged: 1, failed: 1, skipped: 0, missing: 0 });
  });

  it("reports missing receipts", () => {
    expect(countReceipts(["A", "B"], [{ sourceId: "A", result: "updated" }]).missing).toBe(1);
  });

  it("rejects duplicates and receipts outside the frozen manifest", () => {
    expect(() =>
      countReceipts(
        ["A"],
        [
          { sourceId: "A", result: "updated" },
          { sourceId: "A", result: "unchanged" },
        ],
      ),
    ).toThrow("Duplicate receipt");
    expect(() => countReceipts(["A"], [{ sourceId: "B", result: "updated" }])).toThrow(
      "not due",
    );
  });
});
