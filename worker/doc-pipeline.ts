import { nanoid } from "nanoid";
import { ensureDocTelemetrySchema, buildDocCustomMetadata, recordDocCreateEvent } from "./doc-telemetry.ts";
import { ensureOwnershipSchema } from "./ownership.ts";
import { sha256, validateMarkdown, type MarkdownMetrics, type ValidationFailure } from "./security.ts";
import type { Env } from "./types.ts";

export interface StoredDocAttribution {
  source: string;
  authMode: string;
  ownerUserId?: string | null;
  adminToken?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  actorEmail?: string | null;
  actorSessionId?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
}

export class DocValidationError extends Error {
  failure: ValidationFailure;
  metrics: MarkdownMetrics;

  constructor(failure: ValidationFailure, metrics: MarkdownMetrics) {
    super(failure.message);
    this.name = "DocValidationError";
    this.failure = failure;
    this.metrics = metrics;
  }
}

export function extractMarkdownTitle(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.substring(2).trim();
    }
  }

  return null;
}

export async function createStoredDoc(
  env: Env,
  payload: {
    markdown: string;
    title?: string | undefined;
  },
  attribution: StoredDocAttribution
): Promise<{
  id: string;
  title: string | null;
  url: string;
  rawUrl: string;
  bytes: number;
  createdAt: string;
  sha256: string;
}> {
  const { metrics, failure } = validateMarkdown(payload.markdown);
  if (failure) {
    throw new DocValidationError(failure, metrics);
  }

  const id = nanoid(10);
  const r2Key = `md/${id}.md`;
  const hash = await sha256(payload.markdown);
  const title = payload.title || extractMarkdownTitle(payload.markdown);
  const createdAt = new Date().toISOString();

  await ensureOwnershipSchema(env);
  await ensureDocTelemetrySchema(env);

  await env.DOCS_BUCKET.put(r2Key, payload.markdown, {
    httpMetadata: {
      contentType: "text/markdown",
    },
    customMetadata: buildDocCustomMetadata({
      createdAt,
      sha256: hash,
      source: attribution.source,
      authMode: attribution.authMode,
      ownerUserId: attribution.ownerUserId,
      clientId: attribution.clientId,
      clientName: attribution.clientName,
      actorEmail: attribution.actorEmail,
      actorSessionId: attribution.actorSessionId,
      apiKeyId: attribution.apiKeyId,
      apiKeyName: attribution.apiKeyName,
    }),
  });

  if (attribution.adminToken) {
    await env.DB.prepare(
      "INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title, admin_token, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        r2Key,
        "text/markdown",
        metrics.payloadBytes,
        createdAt,
        hash,
        title,
        attribution.adminToken,
        attribution.ownerUserId ?? null
      )
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title, view_count, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        r2Key,
        "text/markdown",
        metrics.payloadBytes,
        createdAt,
        hash,
        title,
        0,
        attribution.ownerUserId ?? null
      )
      .run();
  }

  await recordDocCreateEvent(env, {
    docId: id,
    createdAt,
    source: attribution.source,
    authMode: attribution.authMode,
    clientId: attribution.clientId,
    clientName: attribution.clientName,
    actorUserId: attribution.ownerUserId,
    actorEmail: attribution.actorEmail,
    actorSessionId: attribution.actorSessionId,
    apiKeyId: attribution.apiKeyId,
    apiKeyName: attribution.apiKeyName,
  });

  try {
    await env.ANALYTICS.writeDataPoint({
      blobs: [
        "doc_create",
        id,
        attribution.source,
        attribution.authMode,
        attribution.clientName ?? "",
        attribution.clientId ?? "",
      ],
      doubles: [metrics.payloadBytes],
      indexes: [
        attribution.source,
        (attribution.ownerUserId || attribution.authMode || "anonymous").slice(0, 32),
      ],
    });
  } catch (error) {
    console.error("doc_create analytics error:", error);
  }

  return {
    id,
    title,
    url: `https://plsreadme.com/v/${id}`,
    rawUrl: `https://plsreadme.com/v/${id}/raw`,
    bytes: metrics.payloadBytes,
    createdAt,
    sha256: hash,
  };
}
