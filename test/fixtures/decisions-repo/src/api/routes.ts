import express from "express";
import { getAccount } from "../db/accounts.js";

export const router = express.Router();

router.get("/accounts/:id", async (req, res) => {
  const [account] = await getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: "not found" });
  res.json(account);
});
