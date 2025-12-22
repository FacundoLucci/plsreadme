# Beta Signup Changes Summary

**Date:** Dec 21, 2025

## What You Asked For

1. ✅ Get notified when someone signs up for beta
2. ✅ Ask users what features they want built

## Changes Made

### 1. Database Schema (`db/schema.sql`)
- Added `requested_features` TEXT field to store user feature requests

### 2. Backend (`worker/`)
- **`types.ts`**: Added environment variables for notifications (Discord webhook, Resend API)
- **`routes/waitlist.ts`**: 
  - Added Discord notification function
  - Added email notification function (via Resend)
  - Updated to save `requested_features` field
  - Sends notifications after successful signup

### 3. Frontend (`public/`)
- **`index.html`**: Added textarea for feature requests in the signup modal
- **`track.js`**: Updated to capture and send feature request data
- **`styles.css`**: Added styling for textarea and new form layout

## What Notifications Look Like

### Discord (Recommended - Free & Easy)
```
🎉 New Beta Signup!
Email: user@example.com
Requested Features: I'd love to see PDF export and dark mode!
Source: twitter
Time: 2025-12-21T10:30:00.000Z
```

### Email (via Resend)
Professional HTML email with the same information.

## Next Steps

1. **Migrate Database:**
   ```bash
   npm run db:migrate
   ```

2. **Set up notifications** (pick one or both):
   
   **Discord** (easiest):
   ```bash
   npx wrangler secret put DISCORD_WEBHOOK_URL
   # Paste your Discord webhook URL
   ```
   
   **Email** (via Resend):
   ```bash
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put NOTIFICATION_EMAIL
   ```

3. **Deploy:**
   ```bash
   npm run deploy
   ```

4. **Test it!**
   - Go to your site
   - Sign up with a test email
   - Check your Discord/email for the notification!

## Files Changed

- `db/schema.sql` - Database schema
- `worker/types.ts` - TypeScript types
- `worker/routes/waitlist.ts` - Backend logic
- `public/index.html` - Frontend form
- `public/track.js` - Form submission handler
- `public/styles.css` - Styling

## Documentation

See `NOTIFICATIONS_SETUP.md` for detailed setup instructions and troubleshooting.





