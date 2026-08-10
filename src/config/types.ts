export interface BriefingIntent {
  version: 1;
  name: string;
  preset: "ai-daily";
  interests: string[];
  schedule: "manual" | "daily-at-10" | "weekdays-at-09";
  output: "markdown";
  outputDirectory: string;
}

export interface SourceDefinition {
  id: string;
  title: string;
  connector:
    | {
        type: "github-releases";
        config: { repository: string };
      }
    | {
        type: "rss";
        config: { url: string };
      };
}

export interface PresetDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  quality: "strict" | "balanced";
  coverage: "focused" | "balanced" | "broad";
  cost: "low" | "moderate" | "high";
  sources: SourceDefinition[];
}

export interface EffectiveConfig {
  configVersion: 1;
  projectRoot: string;
  name: string;
  preset: PresetDefinition;
  interests: string[];
  schedule: BriefingIntent["schedule"];
  output: {
    format: "markdown";
    directory: string;
  };
  storage: {
    driver: "sqlite";
    path: string;
  };
  runtime: {
    httpConcurrency: number;
    retries: number;
    timeoutSeconds: number;
  };
}
