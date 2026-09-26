import { Router } from "express";
import { db } from "../lib/db.js";

export const customersRouter = Router();

customersRouter.get("/", async (req, res) => {
  const email = req.query.email as string | undefined;
  res.json(await db.customer.findMany({ where: email ? { email } : {} }));
});

customersRouter.get("/:customerId", async (req, res) => {
  const customer = await db.customer.findUnique({ where: { id: req.params.customerId } });
  if (!customer) return res.status(404).json({ error: "not found" });
  res.json(customer);
});
