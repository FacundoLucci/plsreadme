export interface Env {
  DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  DISCORD_WEBHOOK_URL?: string;  // Optional Discord webhook for notifications
  RESEND_API_KEY?: string;       // Optional Resend API key for email notifications
  NOTIFICATION_EMAIL?: string;   // Your email to receive notifications
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

