import { NextResponse } from "next/server";

export const GET = async () => NextResponse.json({ user: null, secretConfigured: Boolean(process.env.NEXTAUTH_SECRET) });
