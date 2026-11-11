export type PcsErrorCode =
  | "NOT_GIT_REPO"
  | "NOT_INITIALIZED"
  | "INTEGRITY_FAILURE"
  | "SCHEMA_TOO_NEW"
  | "GIT_FAILURE";

export class PcsError extends Error {
  readonly code: PcsErrorCode;

  constructor(code: PcsErrorCode, message: string) {
    super(message);
    this.name = "PcsError";
    this.code = code;
  }
}

/** Process exit code for an error: 2 = integrity failure, 1 = everything else. */
export function exitCodeFor(err: unknown): number {
  return err instanceof PcsError && err.code === "INTEGRITY_FAILURE" ? 2 : 1;
}
