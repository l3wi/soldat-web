export class ContentError extends Error {
  constructor(public readonly code: string, message: string, public readonly offset?: number) {
    super(`${code}: ${message}${offset === undefined ? '' : ` at byte ${offset}`}`);
    this.name = 'ContentError';
  }
}
