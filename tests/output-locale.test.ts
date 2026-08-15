import { describe, expect, it } from "vitest";

import { resolveOutputLanguage } from "../src/outputs/locale.js";

describe("output locale", () => {
  it("uses an explicit Briefwright locale before environment and system settings", () => {
    expect(resolveOutputLanguage({ env: { BRIEFWRIGHT_LOCALE: "zh-Hans-CN", LANG: "en_US.UTF-8" }, platform: "linux", intlLocale: "en-US" })).toBe("zh-CN");
  });

  it("ignores C/POSIX launch environments and reads the macOS user language", () => {
    expect(resolveOutputLanguage({ env: { LC_ALL: "C.UTF-8", LANG: "C.UTF-8" }, platform: "darwin", appleLanguages: () => "zh-Hans-CN", intlLocale: "en-US" })).toBe("zh-CN");
  });

  it("uses English for non-Chinese runtime locales", () => {
    expect(resolveOutputLanguage({ env: { LANG: "en_GB.UTF-8" }, platform: "linux", intlLocale: "zh-CN" })).toBe("en");
  });
});
