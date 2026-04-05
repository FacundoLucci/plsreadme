import { Hono } from "hono";
import type { Env } from "../types";
import {
  buildDemoGrantErrorPayload,
  clearDemoGrantCookie,
  WRITE_RATE_LIMITS,
  checkAndConsumeRateLimit,
  consumeDemoGrant,
  failureToErrorPayload,
  getClientIp,
  logAbuseAttempt,
  parseContentLength,
  readCookieValue,
  resolveRateLimitActorKey,
  sha256,
  validateContentLength,
  validateMarkdown,
  DEMO_GRANT_COOKIE_NAME,
} from "../security.ts";
import { getRequestAuth } from "../auth.ts";
import { createStoredDoc, DocValidationError } from "../doc-pipeline.ts";

const app = new Hono<{ Bindings: Env }>();

// Send Discord notification (link/doc creation)
async function sendDiscordLinkCreatedNotification(
  webhookUrl: string,
  payload: {
    id: string;
    title: string | null;
    url: string;
    rawUrl: string;
    bytes: number;
  }
): Promise<void> {
  try {
    if (!webhookUrl || webhookUrl.trim() === "") return;

    const safeTitle = (payload.title || "Untitled").slice(0, 256);
    const embed = {
      title: "🔗 New link generated",
      color: 0x10b981, // emerald
      fields: [
        { name: "Title", value: safeTitle, inline: false },
        { name: "Doc ID", value: payload.id, inline: true },
        { name: "Size", value: `${payload.bytes} bytes`, inline: true },
        { name: "View", value: payload.url, inline: false },
        { name: "Raw", value: payload.rawUrl, inline: false },
        { name: "Time", value: new Date().toISOString(), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Discord link notification failed:", {
        status: res.status,
        statusText: res.statusText,
        body: text.slice(0, 500),
      });
    }
  } catch (error) {
    console.error(
      "Discord link notification error:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

// POST /api/create-link
app.post("/", async (c) => {
  const endpoint = "/api/create-link";
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  try {
    const contentLengthFailure = validateContentLength(contentLength);
    if (contentLengthFailure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: contentLengthFailure.reason,
        contentLength,
      });
      return c.json(failureToErrorPayload(contentLengthFailure), contentLengthFailure.status);
    }

    const requestAuth = await getRequestAuth(c);
    const isAuthenticated = !!(requestAuth.isAuthenticated && requestAuth.userId);

    if (!isAuthenticated) {
      const demoGrant = readCookieValue(c.req.header("cookie"), DEMO_GRANT_COOKIE_NAME);
      const demoGrantCheck = await consumeDemoGrant(c.env, {
        token: demoGrant,
        ipHash,
        userAgent: c.req.header("user-agent"),
      });

      if (!demoGrantCheck.valid) {
        await logAbuseAttempt(c.env, {
          endpoint,
          ipHash,
          reason: `demo_grant_${demoGrantCheck.reason}`,
          contentLength,
        });

        const response = c.json(
          buildDemoGrantErrorPayload(
            demoGrantCheck.reason,
            c.env.CLERK_SIGN_IN_URL?.trim() || "/sign-in"
          ),
          403
        );
        response.headers.append("Set-Cookie", clearDemoGrantCookie(c.req.url));
        return response;
      }
    }

    const rateLimitActorKey = await resolveRateLimitActorKey({
      ipHash,
      userId: isAuthenticated ? requestAuth.userId : null,
    });

    const rateLimit = await checkAndConsumeRateLimit(
      c.env,
      rateLimitActorKey,
      isAuthenticated
        ? WRITE_RATE_LIMITS.createLinkAuthenticated
        : WRITE_RATE_LIMITS.createLinkAnonymous
    );
    if (!rateLimit.allowed) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: "rate_limit_exceeded",
        contentLength,
      });
      return c.json(
        {
          error: `Rate limit exceeded. Maximum ${rateLimit.maxRequests} requests per hour.`,
          reason: "rate_limit_exceeded",
          limit: rateLimit.maxRequests,
          actual: rateLimit.count,
          retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
        },
        429
      );
    }

    const body = await c.req
      .json<{ markdown?: unknown }>()
      .catch(() => null);

    if (!body || typeof body.markdown !== "string") {
      return c.json(
        { error: "Invalid JSON body. Expected { markdown: string }" },
        400
      );
    }

    const markdown = body.markdown;
    const { metrics, failure } = validateMarkdown(markdown);

    if (failure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: failure.reason,
        contentLength,
        payloadBytes: metrics.payloadBytes,
        totalChars: metrics.totalChars,
        maxLineChars: metrics.maxLineChars,
      });
      return c.json(failureToErrorPayload(failure), failure.status);
    }

    const ownerUserId = isAuthenticated ? requestAuth.userId : null;

    let isFirstSavedLink = false;
    if (ownerUserId) {
      const existingCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM docs WHERE owner_user_id = ?"
      )
        .bind(ownerUserId)
        .first<{ count: number | string | null }>();
      isFirstSavedLink = (Number(existingCount?.count ?? 0) || 0) === 0;
    }

    const created = await createStoredDoc(c.env, { markdown }, {
      source: ownerUserId ? "web_signed_in" : "web_demo",
      authMode: ownerUserId ? "clerk_session" : "anonymous_demo",
      ownerUserId,
      clientName: "website",
      actorEmail: requestAuth.email,
      actorSessionId: requestAuth.sessionId,
    });

    // Send Discord notification (optional, best-effort)
    const linkWebhookUrl = c.env.DISCORD_LINK_WEBHOOK_URL;
    if (linkWebhookUrl) {
      const baseUrl = "https://plsrd.me";
      const notifyPromise = sendDiscordLinkCreatedNotification(linkWebhookUrl, {
        id: created.id,
        title: created.title,
        url: `${baseUrl}/v/${created.id}`,
        rawUrl: `${baseUrl}/v/${created.id}/raw`,
        bytes: created.bytes,
      });

      const execCtx = (c as any).executionCtx as ExecutionContext | undefined;
      if (execCtx && typeof execCtx.waitUntil === "function") {
        execCtx.waitUntil(notifyPromise);
      } else {
        notifyPromise.catch(() => {});
      }
    }

    if (ownerUserId && isFirstSavedLink) {
      try {
        await c.env.ANALYTICS.writeDataPoint({
          blobs: ["first_saved_link", ownerUserId, created.id],
          doubles: [Date.now()],
          indexes: [ownerUserId.slice(0, 32)],
        });
      } catch (analyticsError) {
        console.error("first_saved_link analytics error:", analyticsError);
      }
    }

    // Return id and url
    const baseUrl = "https://plsrd.me";
    const response = c.json({
      id: created.id,
      url: `${baseUrl}/v/${created.id}`,
      owned: Boolean(ownerUserId),
      authMode: ownerUserId ? "authenticated" : "anonymous_demo",
      source: ownerUserId ? "web_signed_in" : "web_demo",
    });
    if (!isAuthenticated) {
      response.headers.append("Set-Cookie", clearDemoGrantCookie(c.req.url));
    }
    return response;
  } catch (error) {
    if (error instanceof DocValidationError) {
      return c.json(failureToErrorPayload(error.failure), error.failure.status);
    }
    console.error("Error creating link:", error);
    return c.json({ error: "Failed to create link" }, 500);
  }
});

export { app as linksRoutes };
