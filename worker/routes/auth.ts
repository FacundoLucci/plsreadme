import { Hono } from "hono";
import { attachRequestAuth, getRequestAuth, requireAuth } from "../auth.ts";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", attachRequestAuth);

app.get("/config", (c) => {
  const publishableKey = c.env.CLERK_PUBLISHABLE_KEY?.trim() ?? "";
  const issuer = c.env.CLERK_JWT_ISSUER?.trim() ?? "";

  return c.json({
    enabled: Boolean(publishableKey && issuer),
    publishableKey: publishableKey || null,
    signInUrl: c.env.CLERK_SIGN_IN_URL?.trim() || "/sign-in",
    signUpUrl: c.env.CLERK_SIGN_UP_URL?.trim() || "/sign-up",
    providers: ["github", "google"],
  });
});

app.get("/session", async (c) => {
  const auth = await getRequestAuth(c);

  if (!auth.isAuthenticated) {
    return c.json({
      authenticated: false,
      reason: auth.reason ?? "missing_token",
    });
  }

  return c.json({
    authenticated: true,
    userId: auth.userId,
    sessionId: auth.sessionId,
    email: auth.email,
    tokenSource: auth.tokenSource,
  });
});

app.get("/me", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  return c.json({
    userId: authOrResponse.userId,
    sessionId: authOrResponse.sessionId,
    email: authOrResponse.email,
    tokenSource: authOrResponse.tokenSource,
  });
});

export { app as authRoutes };
