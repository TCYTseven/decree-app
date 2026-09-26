import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";

export async function GET() {
  const rows = await db.select().from(notes);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const { title, body } = await req.json();
  const [row] = await db.insert(notes).values({ title, body }).returning();
  return NextResponse.json(row, { status: 201 });
}
