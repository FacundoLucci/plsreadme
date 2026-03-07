import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Env } from "../types";
import {
  WRITE_RATE_LIMITS,
  checkAndConsumeRateLimit,
  failureToErrorPayload,
  getClientIp,
  logAbuseAttempt,
  parseContentLength,
  sha256,
  validateContentLength,
  validateMarkdown,
} from "../security.ts";
import { getRequestAuth } from "../auth.ts";
import { ensureOwnershipSchema } from "../ownership.ts";

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

// Helper: Extract title from markdown
function extractTitle(markdown: string): string | null {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.substring(2).trim();
    }
  }
  return null;
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

    const rateLimit = await checkAndConsumeRateLimit(
      c.env,
      ipHash,
      WRITE_RATE_LIMITS.createLink
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

    // Generate ID and hash
    const id = nanoid(10);
    const hash = await sha256(markdown);
    const r2Key = `md/${id}.md`;
    const title = extractTitle(markdown);
    const now = new Date().toISOString();

    await ensureOwnershipSchema(c.env);
    const requestAuth = await getRequestAuth(c);
    const ownerUserId = requestAuth.isAuthenticated ? requestAuth.userId : null;

    let isFirstSavedLink = false;
    if (ownerUserId) {
      const existingCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM docs WHERE owner_user_id = ?"
      )
        .bind(ownerUserId)
        .first<{ count: number | string | null }>();
      isFirstSavedLink = (Number(existingCount?.count ?? 0) || 0) === 0;
    }

    // Store in R2
    await c.env.DOCS_BUCKET.put(r2Key, markdown, {
      httpMetadata: {
        contentType: "text/markdown",
      },
      customMetadata: {
        created_at: now,
        sha256: hash,
      },
    });

    // Store metadata in D1 docs table
    await c.env.DB.prepare(
      "INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title, view_count, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, r2Key, "text/markdown", metrics.payloadBytes, now, hash, title, 0, ownerUserId)
      .run();

    // Send Discord notification (optional, best-effort)
    const linkWebhookUrl = c.env.DISCORD_LINK_WEBHOOK_URL;
    if (linkWebhookUrl) {
      const baseUrl = "https://plsrd.me";
      const notifyPromise = sendDiscordLinkCreatedNotification(linkWebhookUrl, {
        id,
        title,
        url: `${baseUrl}/v/${id}`,
        rawUrl: `${baseUrl}/v/${id}/raw`,
        bytes: metrics.payloadBytes,
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
          blobs: ["first_saved_link", ownerUserId, id],
          doubles: [Date.now()],
          indexes: [ownerUserId.slice(0, 32)],
        });
      } catch (analyticsError) {
        console.error("first_saved_link analytics error:", analyticsError);
      }
    }

    // Return id and url
    const baseUrl = "https://plsrd.me";
    return c.json({
      id,
      url: `${baseUrl}/v/${id}`,
    });
  } catch (error) {
    console.error("Error creating link:", error);
    return c.json({ error: "Failed to create link" }, 500);
  }
});

export { app as linksRoutes };
