import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";

const router = Router();

const OrderCreate = z.object({
  customerId: z.string(),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1) })),
  note: z.string().optional(),
});

router.get("/", async (req, res) => {
  const status = req.query.status as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const orders = await db.order.findMany({ where: status ? { status } : {}, take: limit });
  res.json(orders);
});

router.post("/", async (req, res) => {
  const input = OrderCreate.parse(req.body);
  const order = await db.order.create({
    data: { customerId: input.customerId, note: input.note, items: { create: input.items } },
  });
  res.status(201).json(order);
});

router.get("/:id", async (req, res) => {
  const order = await db.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!order) return res.status(404).json({ error: "not found" });
  res.json(order);
});

router.delete("/:id", async (req, res) => {
  await db.order.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

router.post("/:id/cancel", async (req, res) => {
  const { reason } = z.object({ reason: z.string() }).parse(req.body);
  const order = await db.order.update({ where: { id: req.params.id }, data: { status: "cancelled", note: reason } });
  res.json(order);
});

// Not documented in openapi.yaml yet.
router.get("/:id/events", async (req, res) => {
  res.json([{ orderId: req.params.id, type: "created" }]);
});

export default router;
