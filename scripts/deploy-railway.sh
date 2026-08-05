#!/usr/bin/env sh
set -eu

if ! command -v railway >/dev/null 2>&1; then
  echo "Railway CLI is not installed. See https://docs.railway.com/guides/cli"
  exit 1
fi

if [ -z "${HEAD_ADMIN_EMAIL:-}" ]; then
  echo "Set HEAD_ADMIN_EMAIL before running this script."
  exit 1
fi

SESSION_SECRET_VALUE="${SESSION_SECRET:-$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")}"

railway init --name corpsdraft
railway add -d postgres
railway add -s corpsdraft-app
railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  "SESSION_SECRET=$SESSION_SECRET_VALUE" \
  "HEAD_ADMIN_EMAIL=$HEAD_ADMIN_EMAIL" \
  "NODE_ENV=production"
railway up
railway domain

echo "CorpsDraft was uploaded and a domain was requested. Review the Railway deployment logs before using the site."
