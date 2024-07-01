import { LookupResponse, TokenType, ActionType } from './models';

/**
 * Verify the token.
 * @param lookup - The response from the lookup endpoint.
 * @param token_type - The type of token that was issued.
 * @returns A boolean indicating if the token is valid.
 */
export function verifyToken(lookup: LookupResponse, token_type: TokenType): boolean {
  return (
    lookup.consumed === false &&
    (lookup.solved !== undefined ? lookup.solved : true) === true &&
    token_type === lookup.token_type
  );
}

/**
 * Determine the action to take based on the lookup response.
 * @param lookup - The response from the lookup endpoint.
 * @param token_type - The type of token that was issued.
 * @returns The action to take.
 */
export function determineAction(lookup: LookupResponse, token_type: TokenType): ActionType {
  if (verifyToken(lookup, token_type)) {
    return (lookup.risk_level as unknown) as ActionType;
  }
  return ActionType.BLOCK;
}
