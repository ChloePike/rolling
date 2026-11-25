/** Raised before any provider call when a request does not fit the model's capabilities. */
export class InvalidGenerateRequestError extends Error {
  override readonly name = 'InvalidGenerateRequestError';
  constructor(
    readonly modelKey: string,
    readonly problems: string[],
  ) {
    super(`Request does not fit model ${modelKey}: ${problems.join('; ')}`);
  }
}
