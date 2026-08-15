import { execFileSync } from "node:child_process";

export type OutputLanguage = "zh-CN" | "en";

interface LocaleInputs {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  appleLanguages?: () => string | undefined;
  intlLocale?: string;
}

function supportedLanguage(locale?: string): OutputLanguage | undefined {
  const normalized = locale?.trim().replace(/^['"]|['"]$/g, "").replace(/_/g, "-");
  if (!normalized || /^(C|POSIX)(\.|$)/i.test(normalized)) return undefined;
  return /^zh(?:-|$)/i.test(normalized) ? "zh-CN" : "en";
}

function readAppleLanguage(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const languages = execFileSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = /"([^"]+)"/.exec(languages)?.[1];
    if (first) return first;
    return execFileSync("defaults", ["read", "-g", "AppleLocale"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function resolveOutputLanguage(inputs: LocaleInputs = {}): OutputLanguage {
  const env = inputs.env ?? process.env;
  const explicit = supportedLanguage(env.BRIEFWRIGHT_LOCALE);
  if (explicit) return explicit;
  for (const candidate of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const language = supportedLanguage(candidate);
    if (language) return language;
  }
  const appleLocale = inputs.appleLanguages?.() ?? ((inputs.platform ?? process.platform) === "darwin" ? readAppleLanguage() : undefined);
  return supportedLanguage(appleLocale) ?? supportedLanguage(inputs.intlLocale ?? Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
}

export function detectOutputLanguage(): OutputLanguage {
  return resolveOutputLanguage();
}
