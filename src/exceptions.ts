/**
 * Base exception class
 */
export class SynthientException extends Error {
  /**
   * Constructs a new SynthientException.
   * 
   * @param message - The error message.
   */
  constructor(message: string) {
    super(message);
    this.name = "SynthientException";
  }
}

/**
 * Raised when the server returns a 500.
 */
export class InternalServerError extends SynthientException {
  /**
   * Constructs a new InternalServerError.
   * 
   * @param message - The error message.
   */
  constructor(message: string) {
    super(message);
    this.name = "InternalServerError";
  }
}

/**
 * Raised when the server returns a 400 or 401.
 */
export class ErrorResponse extends SynthientException {
  /**
   * Constructs a new ErrorResponse.
   * 
   * @param message - The error message.
   */
  constructor(message: string) {
    super(message);
    this.name = "ErrorResponse";
  }
}
