#!/bin/sh
set -e

if [ "${RUN_PROD_SCRIPTS:-true}" = "true" ]; then
  npx prisma migrate deploy
  npm run prisma:seed:prod
  npm run models:sync:prod
fi

exec "$@"
