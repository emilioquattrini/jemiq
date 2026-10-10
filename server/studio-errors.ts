/** Safe, user-facing errors only. Never include raw upstream bodies or credentials. */
export class StudioError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'StudioError';
  }
}
