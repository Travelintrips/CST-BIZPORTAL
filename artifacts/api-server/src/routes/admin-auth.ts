import type { NextFunction, Request, Response } from "express";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  type DevAuthUser,
} from "./dev-auth";

export type AdminRequest = Request & { adminUser?: DevAuthUser };

const ADMIN_ROLES = new Set(["admin", "owner", "super_admin", "finance", "accounting"]);

export async function authenticateAdmin(
  request: AdminRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = isDevelopmentEnvironment()
      ? getDevSession(request)
      : (() => {
          const session = getProductionSession(request);
          return session ? getProductionUser(session) : Promise.resolve(null);
        })();
    const resolvedUser = await user;

    if (!resolvedUser) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!ADMIN_ROLES.has(resolvedUser.role.toLowerCase())) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    request.adminUser = resolvedUser;
    next();
  } catch (error) {
    request.log.error({ error }, "Admin API authorization failed");
    response.status(503).json({ error: "Authorization service unavailable." });
  }
}