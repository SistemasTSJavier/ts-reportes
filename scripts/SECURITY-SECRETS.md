# Secrets requeridos (Supabase → Edge Functions → Secrets)
#
# TURNSTILE_SECRET_KEY=...
# TURNSTILE_TICKET_SECRET=...   (HMAC tickets; puede ser el mismo valor fuerte dedicado)
# POWER_AUTOMATE_CTPAT_WEBHOOK_URL=https://...
# POWER_AUTOMATE_CTPAT_WEBHOOK_SECRET=...   (OBLIGATORIO; fail-closed)
# PURGE_CRON_SECRET=...
# GOOGLE_TOKEN_ENC_KEY=...      (32 bytes hex o passphrase; fase 4)
# GOOGLE_OAUTH_CLIENT_ID=...    (mismo client que Auth Google)
# GOOGLE_OAUTH_CLIENT_SECRET=...
#
# SQL: scripts/fix-security-strict-clients.sql
# Deploy: npm run deploy:functions
# Frontend: Vercel (CSP + build)
#
# Power Automate: validar header X-Webhook-Secret == secret.
# Admin: activar MFA TOTP en Auth; el panel pide AAL2 tras enrolar.
