import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

export function requireToken(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  if (header !== `Bearer ${config.apiToken}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
