// /app/api/items/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { PrismaClient } from "@prisma/client";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { z } from "zod";
import { transporter } from "@/lib/email";

const prisma = new PrismaClient();

// ---------------------- GET ----------------------
export async function GET() {
  try {
    const items = await prisma.item.findMany({
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(items);
  } catch (error) {
    console.error("Error fetching items:", error);
    return NextResponse.json({ message: "Error fetching items" }, { status: 500 });
  }
}

// ---------------------- POST ----------------------
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    const itemSchema = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      category: z.string().min(1),
      type: z.enum(["lost", "found"]),
      location: z.string().optional(),
      date: z.string().optional(),
      imageUrl: z.string().optional(),
    });

    const validation = itemSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { message: "Invalid input data", errors: validation.error.issues },
        { status: 400 }
      );
    }

    const { title, description, category, type, location, date, imageUrl } = body;

    // ✅ Create item first
    const item = await prisma.item.create({
      data: {
        title,
        description,
        category,
        type,
        location,
        date,
        imageUrl,
        status: "active",
        userId: session.user.id,
      },
      include: {
        user: { select: { id: true, name: true, image: true, email: true } },
      },
    });

    // ✅ If no image → skip matching
    if (!imageUrl) {
      return NextResponse.json(item, { status: 201 });
    }

    // ✅ Fetch opposite items
    const oppositeType = type === "lost" ? "found" : "lost";

    const existingItems = await prisma.item.findMany({
      where: { type: oppositeType, status: "active" },
      select: {
        id: true,
        title: true,
        description: true,
        imageUrl: true,
        userId: true,
        location: true,
        date: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    });

    // ✅ Call Python Image Match API
    let imageMatchResult = null;

    try {
      const response = await fetch("http://127.0.0.1:8001/image-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          new_item: { id: item.id, image_url: item.imageUrl },
          existing_items: existingItems
            .filter(i => i.imageUrl)
            .map(i => ({ id: i.id, image_url: i.imageUrl })),
        }),
      });

      imageMatchResult = await response.json();
      console.log("IMAGE MATCH RESULT:", imageMatchResult);
    } catch (err) {
      console.error("Python image match API error:", err);
    }

    // ✅ If Python found a match → send emails
    if (imageMatchResult?.match_found) {
      const matched = existingItems.find(i => i.id === imageMatchResult.matched_item.id);

      if (matched) {
        const siteUrl = process.env.SITE_URL || "http://localhost:3000";

        await transporter.sendMail({
          from: `"Lost & Found" <${process.env.EMAIL_USER}>`,
          to: session.user.email!,
          subject: "We found a possible image-based match!",
          html: `
            <h2>Possible Match Found</h2>
            <p>Your item may match with:</p>
            <h3>${matched.title}</h3>
            <img src="${matched.imageUrl}" style="max-width:200px;" />
            <a href="${siteUrl}/items/${matched.id}">View Item</a>
          `,
        });

        await transporter.sendMail({
          from: `"Lost & Found" <${process.env.EMAIL_USER}>`,
          to: matched.user.email,
          subject: "We found a possible match for your item!",
          html: `
            <h2>Possible Match Found</h2>
            <p>Your item may match with:</p>
            <h3>${item.title}</h3>
            <img src="${item.imageUrl}" style="max-width:200px;" />
            <a href="${siteUrl}/items/${item.id}">View Item</a>
          `,
        });
      }
    }

    return NextResponse.json(item, { status: 201 });

  } catch (error) {
    console.error("Error creating item:", error);
    return NextResponse.json(
      { message: "Error creating item", detail: (error as any).message },
      { status: 500 }
    );
  }
}
