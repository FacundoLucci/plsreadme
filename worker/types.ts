export interface Env {
  DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  DOCS_BUCKET: R2Bucket;
  DISCORD_WEBHOOK_URL?: string;        // Optional Discord webhook (used for waitlist notifications)
  DISCORD_LINK_WEBHOOK_URL?: string;   // Optional Discord webhook (used for link/doc creation notifications)
  RESEND_API_KEY?: string;       // Optional Resend API key for email notifications
  NOTIFICATION_EMAIL?: string;   // Your email to receive notifications
  OPENAI_API_KEY?: string;       // Optional OpenAI API key for text->markdown conversion
  OPENAI_MODEL?: string;         // Optional OpenAI model override
}

export interface WaitlistSignup {
  id: number;
  email: string;
  created_at: string;
  requested_features: string | null;
  source: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  referrer: string | null;
  landing_path: string | null;
  user_agent: string | null;
  ip_hash: string | null;
}

export interface TrackingEvent {
  event: string;
  path: string;
  referrer: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  anon_id: string;
  cta_location?: string;
  timestamp: number;
}

export interface DocRecord {
  id: string;
  r2_key: string;
  content_type: string;
  bytes: number;
  created_at: string;
  sha256: string | null;
  title: string | null;
}

