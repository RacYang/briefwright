export type RecoveryPathRole = "target" | "backup" | "displaced" | "temporary";
export type RecoveryPathState = "file" | "directory" | "symlink" | "other" | "absent" | "unreadable";

export interface RecoveryPathObservation {
  role: RecoveryPathRole;
  path: string;
  observed: RecoveryPathState;
  action: "PRESERVE" | "NONE";
}

export interface CommandErrorContext {
  command?: string;
  proposalId?: string;
  receiptStatus?: "ABSENT" | "MATCH";
}

export class RecoveryIncompleteError extends Error {
  readonly code = "RECOVERY_INCOMPLETE";
  readonly retryable = false;
  readonly recovery: { status: "INCOMPLETE"; paths: RecoveryPathObservation[] };
  context: CommandErrorContext;

  constructor(paths: RecoveryPathObservation[], options: { cause?: unknown } = {}) {
    super("Conditional artifact write failed and recovery was incomplete", options);
    this.name = "RecoveryIncompleteError";
    this.recovery = { status: "INCOMPLETE", paths };
    this.context = {};
  }

  attachContext(context: CommandErrorContext): this {
    this.context = { ...this.context, ...context };
    return this;
  }
}

export class VaultPathUnsafeError extends Error {
  readonly retryable = false;
  context: CommandErrorContext;

  constructor(
    readonly code: string,
    message: string,
    readonly path: string,
    readonly phase: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "VaultPathUnsafeError";
    this.context = {};
  }

  attachContext(context: CommandErrorContext): this {
    this.context = { ...this.context, ...context };
    return this;
  }
}

export function serializeCommandError(error: unknown): {
  command?: string;
  error: Record<string, unknown>;
} {
  if (error instanceof RecoveryIncompleteError) {
    return {
      ...(error.context.command ? { command: error.context.command } : {}),
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.context.proposalId ? { proposalId: error.context.proposalId } : {}),
        ...(error.context.receiptStatus ? { receiptStatus: error.context.receiptStatus } : {}),
        recovery: error.recovery,
      },
    };
  }
  if (error instanceof VaultPathUnsafeError) {
    return {
      ...(error.context.command ? { command: error.context.command } : {}),
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        path: error.path,
        phase: error.phase,
        ...(error.context.proposalId ? { proposalId: error.context.proposalId } : {}),
        ...(error.context.receiptStatus ? { receiptStatus: error.context.receiptStatus } : {}),
      },
    };
  }
  return {
    error: {
      code: "COMMAND_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
