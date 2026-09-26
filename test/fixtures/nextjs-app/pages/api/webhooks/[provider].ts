import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  res.status(200).json({ provider: req.query.provider, verified: Boolean(secret) });
}
