// Graphbrain API — entry point.
//
// Stage 5: auth + tenant + context middleware + unified error handler. The
// Express 5 app assembly, routes, and server lifecycle land in Stage 12.
//
// Middleware is exported so Stage 12 can mount it in order:
//   clerkAuth → tenantResolver() → contextBuilder → <routes>
//   errorHandler (as the final error handler)

export { clerkAuth, verifyJwt, verifyApiKeyToken, looksLikeJwt } from "./middleware/clerk-auth";
export {
  tenantResolver,
  resolveTenant,
  resetTenantCache,
} from "./middleware/tenant-resolver";
export type { TenantResolverDeps, ResolvedTenant } from "./middleware/tenant-resolver";
export { contextBuilder, DEFAULT_SOURCE_ID } from "./middleware/context";
export {
  errorHandler,
  OperationError,
  statusForError,
  unauthenticated,
  tenantNotFound,
  tenantNotActive,
} from "./middleware/error-handler";
export type { OperationErrorOptions } from "./middleware/error-handler";
export type { HelixCreds } from "./middleware/types";
