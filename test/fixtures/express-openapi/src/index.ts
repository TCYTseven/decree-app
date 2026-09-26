import express from "express";
import { config } from "./config.js";
import { requireToken } from "./lib/auth.js";
import ordersRouter from "./routes/orders.js";
import { customersRouter } from "./routes/customers.js";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/orders", requireToken, ordersRouter);
app.use("/customers", requireToken, customersRouter);

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => console.log(`acme-orders listening on :${config.port}`));
}
