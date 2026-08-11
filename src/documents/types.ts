export interface DocumentArtifact {
  kind: "daily" | "review" | "index" | "preview" | "knowledge";
  relativePath: string;
  content: string;
}

export interface PublishedDocument {
  kind: DocumentArtifact["kind"];
  path: string;
  uri?: string;
}

export interface DocumentStore {
  readonly driver: "local" | "obsidian";
  readonly root: string;
  resolve(relativePath: string): string;
  publish(artifacts: DocumentArtifact[], commit: () => void): Promise<PublishedDocument[]>;
  open(pathname: string): void;
}
