# Beta Signup Notifications Setup

**Last updated:** Dec 21, 2025

## What Changed

✅ **Database**: Added `requested_features` field to store user feedback
✅ **Frontend**: Added textarea asking "What feature would you most like to see?"
✅ **Backend**: Added notification support (Discord + Email via Resend)

## How It Works Now

When someone signs up for beta:
1. Their email + feature request is saved to the database
2. You get notified instantly via Discord and/or Email
3. User sees a thank you page

## Setting Up Notifications

You have **two options** for notifications (you can use both or just one):

### Option 1: Discord Webhook (Easiest - Recommended)

1. **Create a Discord webhook:**
   - Open your Discord server
   - Go to Server Settings → Integrations → Webhooks
   - Click "New Webhook"
   - Name it "Outframer Signups" (or whatever you want)
   - Select the channel where you want notifications
   - Copy the Webhook URL

2. **Add to Cloudflare:**
   ```bash
   npx wrangler secret put DISCORD_WEBHOOK_URL
   # Paste your webhook URL when prompted
   ```

3. **Deploy:**
   ```bash
   npm run deploy
   ```

That's it! You'll now get beautiful Discord notifications like:
```
🎉 New Beta Signup!
Email: user@example.com
Requested Features: I'd love to see dark mode and PDF export!
Source: twitter
Time: 2025-12-21T10:30:00.000Z
```

### Option 2: Email via Resend

1. **Sign up for Resend:**
   - Go to https://resend.com
   - Create a free account (100 emails/day free tier)
   - Get your API key from the dashboard

2. **Add to Cloudflare:**
   ```bash
   # Set your Resend API key
   npx wrangler secret put RESEND_API_KEY
   
   # Set your notification email
   npx wrangler secret put NOTIFICATION_EMAIL
   ```
   
   When prompted for `NOTIFICATION_EMAIL`, enter your email (e.g., `you@yourdomain.com`)

3. **Update the "from" address** (optional but recommended):
   - Edit `worker/routes/waitlist.ts` line 28
   - Change `from: 'Outframer <onboarding@resend.dev>'` to your verified domain
   - Example: `from: 'Outframer <notifications@yourdomain.com>'`

4. **Deploy:**
   ```bash
   npm run deploy
   ```

## Testing

After deploying, test by:
1. Going to your site
2. Clicking "Get beta access"
3. Entering a test email + feature request
4. Check your Discord channel or email inbox!

## Checking Signups Manually

If you want to check signups in the database:

```bash
# Connect to your D1 database
npx wrangler d1 execute DB --command "SELECT email, requested_features, created_at FROM waitlist_signups ORDER BY created_at DESC LIMIT 10"
```

## Updating the Database Schema

If you already have signups in your database, run the migration:

```bash
npm run db:migrate
```

This will recreate the table with the new `requested_features` field.

⚠️ **Note:** This will delete existing signups. If you have important data, export it first:
```bash
npx wrangler d1 execute DB --command "SELECT * FROM waitlist_signups" --json > backup.json
```

## Troubleshooting

**Notifications not working?**
- Check that secrets are set: `npx wrangler secret list`
- Check worker logs: `npx wrangler tail`
- Test Discord webhook directly with curl:
  ```bash
  curl -X POST "YOUR_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{"content": "Test notification"}'
  ```

**Form not showing textarea?**
- Clear your browser cache
- Make sure you deployed the updated `public/` folder

## Making the Feature Request Optional/Required

Currently, the feature request field is **optional**. To make it required:

1. Edit `public/index.html` line 260
2. Add `required` attribute:
   ```html
   <textarea
     name="requested_features"
     id="modal-features"
     placeholder="What feature would you most like to see?"
     required
     ...
   ```

## Need Help?

- Discord webhook docs: https://discord.com/developers/docs/resources/webhook
- Resend docs: https://resend.com/docs/send-with-nodejs
- Cloudflare Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/




