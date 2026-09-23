# A Square Data Sub — Render deployment

This project is a full Node.js app: the same server serves the frontend and `/api/*` backend routes.

## Render Web Service
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`

## Production environment variables
Set these in Render > Environment:

- `DATABASE_URL` = your managed PostgreSQL connection string
- `DATABASE_SSL` = `true`
- `PAYMENT_PROVIDER` = `paystack` when you are ready for real Paystack
- `PAYSTACK_SECRET_KEY` = your Paystack secret key (never put this in frontend code)
- `ADMIN_PHONES` = comma-separated admin phone number(s), e.g. `08012345678`

For a first deployment/test, `PAYMENT_PROVIDER=mock` can be used. Do not treat mock payments as real money.

The app listens on Render's assigned `PORT` and binds to `0.0.0.0`.
