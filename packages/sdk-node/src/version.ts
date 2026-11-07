/**
 * SDK identity sent in the `sdk` field and the `User-Agent` header.
 *
 * VERSION must match `version` in package.json; a test enforces it, so bump
 * both together when releasing.
 */
export const NAME = "@jekimo/sdk-node";
export const VERSION = "0.1.0-alpha.0";
export const USER_AGENT = `${NAME}/${VERSION}`;
