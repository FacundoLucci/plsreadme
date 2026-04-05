import type { HostedMcpGrantProps } from "./mcp-oauth.ts";
import { createStoredDoc } from "./doc-pipeline.ts";
import {
  WRITE_RATE_LIMITS,
  checkAndConsumeRateLimit,
  logAbuseAttempt,
  resolveRateLimitActorKey,
  sha256,
} from "./security.ts";
import type { Env } from "./types.ts";

export class HostedMcpRateLimitError extends Error {
  maxRequests: number;
  retryAfterSeconds: number;

  constructor(maxRequests: number, retryAfterSeconds: number) {
    super(`Rate limit exceeded. Maximum ${maxRequests} requests per hour.`);
    this.name = "HostedMcpRateLimitError";
    this.maxRequests = maxRequests;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function getHostedMcpGrantProps(
  props?: Partial<HostedMcpGrantProps> | null
): HostedMcpGrantProps | null {
  if (!props?.userId || typeof props.userId !== "string" || props.userId.trim() === "") {
    return null;
  }

  const authMode = props.authMode === "remote_api_key" ? "remote_api_key" : "remote_login";
  const source = props.source === "mcp_remote_api_key" ? "mcp_remote_api_key" : "mcp_remote_login";

  return {
    userId: props.userId,
    sessionId: typeof props.sessionId === "string" ? props.sessionId : null,
    email: typeof props.email === "string" ? props.email : null,
    authMode,
    source,
    clientId: typeof props.clientId === "string" ? props.clientId : "unknown_client",
    clientName: typeof props.clientName === "string" ? props.clientName : "connected editor",
    grantedAt: typeof props.grantedAt === "string" ? props.grantedAt : new Date().toISOString(),
    apiKeyId: typeof props.apiKeyId === "string" ? props.apiKeyId : null,
    apiKeyName: typeof props.apiKeyName === "string" ? props.apiKeyName : null,
  };
}

export async function createHostedMcpDoc(
  env: Env,
  payload: {
    markdown: string;
    title?: string | undefined;
  },
  grant: HostedMcpGrantProps
): Promise<{
  id: string;
  title: string | null;
  url: string;
  rawUrl: string;
  bytes: number;
}> {
  const syntheticIpHash = await sha256(`mcp:${grant.clientId}:${grant.userId}`);
  const actorKey = await resolveRateLimitActorKey({
    ipHash: syntheticIpHash,
    userId: grant.userId,
  });
  const rateLimit = await checkAndConsumeRateLimit(env, actorKey, WRITE_RATE_LIMITS.mcpCreate);

  if (!rateLimit.allowed) {
    await logAbuseAttempt(env, {
      endpoint: "/mcp",
      ipHash: syntheticIpHash,
      reason: "rate_limit_exceeded",
      contentLength: payload.markdown.length,
      payloadBytes: new TextEncoder().encode(payload.markdown).length,
      totalChars: payload.markdown.length,
    });
    throw new HostedMcpRateLimitError(
      rateLimit.maxRequests,
      rateLimit.retryAfterSeconds ?? Math.ceil(WRITE_RATE_LIMITS.mcpCreate.windowMs / 1000)
    );
  }

  const created = await createStoredDoc(env, payload, {
    source: grant.source,
    authMode: grant.authMode,
    ownerUserId: grant.userId,
    clientId: grant.clientId,
    clientName: grant.clientName,
    actorEmail: grant.email,
    actorSessionId: grant.sessionId,
    apiKeyId: grant.apiKeyId,
    apiKeyName: grant.apiKeyName,
  });

  return {
    id: created.id,
    title: created.title,
    url: created.url,
    rawUrl: created.rawUrl,
    bytes: created.bytes,
  };
}
