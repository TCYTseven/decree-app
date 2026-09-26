import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const [row] = await db.select().from(notes).where(eq(notes.id, Number(params.id)));
  return row ? NextResponse.json(row) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { title, body } = await req.json();
  const [row] = await db.update(notes).set({ title, body }).where(eq(notes.id, Number(params.id))).returning();
  return NextResponse.json(row);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  await db.delete(notes).where(eq(notes.id, Number(params.id)));
  return new NextResponse(null, { status: 204 });
}
