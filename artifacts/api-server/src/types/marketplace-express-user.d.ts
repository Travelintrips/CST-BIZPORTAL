// Compatibility with the existing upstream Marketplace audit/rate-limit helpers.
// Authentication remains owned by the actual route/session verification.
declare global {
  namespace Express {
    interface Request {
      user?: { id?: string; email?: string | null; companyId?: number | null };
    }
  }
}
export {};
