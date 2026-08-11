export class ConfigurationError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(message);
    this.name = "ConfigurationError";
  }
}
