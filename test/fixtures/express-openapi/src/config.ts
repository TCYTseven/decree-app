export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL!,
  apiToken: process.env.ACME_API_TOKEN!,
  stripeKey: process.env["STRIPE_SECRET_KEY"],
  logLevel: process.env.LOG_LEVEL ?? "info",
};
