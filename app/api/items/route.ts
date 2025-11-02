// /app/api/items/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { PrismaClient } from "@prisma/client";
import { authOptions } from "../auth/[...nextauth]/route";
import { z } from "zod";
import { pusherServer } from "@/lib/pusher";
import { transporter } from "@/lib/email";
import sharp from "sharp";
import { pipeline } from "@xenova/transformers";

const prisma = new PrismaClient();

// ---------------------- helpers ----------------------

function cosineSimilarity(a: number[], b: number[]) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return -1;
  return dot / (magA * magB);
}

function descriptionMatch(textA = "", textB = "", minOverlap = 2) {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const a = new Set(normalize(textA));
  const b = new Set(normalize(textB));
  let overlap = 0;
  for (const w of a) {
    if (b.has(w)) overlap++;
    if (overlap >= minOverlap) return true;
  }
  return false;
}

async function fetchImageBuffer(imageUrl: string) {
  if (!imageUrl) throw new Error("No image URL provided");
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  // Normalize to jpeg
  const jpegBuffer = await sharp(buffer).jpeg().toBuffer();
  return jpegBuffer;
}

// ---------------------- CLIP embedding pipeline ----------------------
// Note: @xenova/transformers will download the model once; keep the extractor cached.
let clipExtractor: any = null;
async function loadClipExtractor() {
  if (!clipExtractor) {
    // Model may download on first run; this can take time.
    clipExtractor = await pipeline("feature-extraction", "Xenova/clip-vit-base-patch32");
  }
  return clipExtractor;
}

async function generateImageEmbeddingFromBuffer(buffer: Buffer): Promise<number[]> {
  // Ensure the buffer is a jpeg
  const jpegBuffer = await sharp(buffer).jpeg().toBuffer();

  const extractor = await loadClipExtractor();

  // The extractor returns a tensor-like object with `.data`
  const output = await extractor(jpegBuffer, { pooling: "mean", normalize: true });

  // Convert to plain JS number array
  if (!output || !output.data) {
    throw new Error("CLIP extractor returned no data");
  }
  return Array.from(output.data as Iterable<number>);
}

// ---------------------- API handlers ----------------------

export async function GET() {
  try {
    const items = await prisma.item.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(items);
  } catch (error) {
    console.error("Error fetching items:", error);
    return NextResponse.json({ message: "Error fetching items" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    // Validate input
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

    // Create item (initially without embedding)
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
        user: {
          select: { id: true, name: true, image: true, email: true },
        },
      },
    });

    // If image exists -> generate embedding and save
    if (imageUrl) {
      try {
        const imgBuffer = await fetchImageBuffer(imageUrl);
        const embedding = await generateImageEmbeddingFromBuffer(imgBuffer);
        console.log("✅ EMBEDDING CREATED (first 10):", embedding.slice(0, 10), "len:", embedding.length);

        await prisma.item.update({
          where: { id: item.id },
          data: { embedding },
        });

        (item as any).embedding = embedding; // for immediate matching below
      } catch (err) {
        console.error("Failed to generate/save embedding:", err);
        // continue without embedding
      }
    }

    const oppositeType = type === "lost" ? "found" : "lost";

    // find active opposite type items which have non-null and non-empty embeddings
    const existingItems = await prisma.item.findMany({
      where: {
        type: oppositeType,
        status: "active",
        NOT: { embedding: { equals: null } },
        embedding: { isEmpty: false },
      },
      select: {
        id: true,
        title: true,
        description: true,
        imageUrl: true,
        userId: true,
        embedding: true,
        location: true,
        date: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    });

    let foundMatch: { existing: any; similarity: number } | null = null;
    const SIMILARITY_THRESHOLD = 0.75;

    if (item.embedding && item.embedding.length > 0 && existingItems.length > 0) {
      for (const ex of existingItems) {
        if (!ex.embedding || !Array.isArray(ex.embedding)) continue;
        const sim = cosineSimilarity(item.embedding as number[], ex.embedding as number[]);
        const descMatch = descriptionMatch(item.description, ex.description);
        console.log(`🔎 compare new:${item.id} ↔ ex:${ex.id} sim=${sim.toFixed(3)} descMatch=${descMatch}`);

        if (sim >= SIMILARITY_THRESHOLD && descMatch) {
          foundMatch = { existing: ex, similarity: sim };
          break;
        }
      }
    }

    if (foundMatch) {
      const matched = foundMatch.existing;
      const similarity = foundMatch.similarity;
      const siteUrl = process.env.SITE_URL || "http://localhost:3000";

      // update statuses
      try {
        await prisma.item.update({ where: { id: item.id }, data: { status: "matched" } });
        await prisma.item.update({ where: { id: matched.id }, data: { status: "matched" } });
      } catch (err) {
        console.warn("Warning: could not update match status fields:", err);
      }

      // email reporter of new item
      try {
        await transporter.sendMail({
          from: `"Lost & Found" <${process.env.EMAIL_USER}>`,
          to: session.user.email!,
          subject: "We Found a Possible Match for Your Item!",
          html: `
            <div style="font-family: Arial, sans-serif; padding: 10px;">
              <h2 style="color: #333;">🎉 We Found a Possible Match!</h2>
              <p>Your reported item (${item.title}) matches with the following:</p>
              <h3>${matched.title}</h3>
              <p>${matched.description}</p>
              ${matched.imageUrl ? `<img src="${matched.imageUrl}" alt="Item image" style="max-width: 200px; height: auto; border-radius: 5px; margin-top: 10px;">` : ''}
              <p><b>Similarity:</b> ${similarity.toFixed(3)}</p>
              <p><b>Location:</b> ${matched.location || "N/A"}</p>
              <p><b>Date Reported:</b> ${new Date(matched.createdAt).toLocaleDateString()}</p>
              <a href="${siteUrl}/items/${matched.id}" style="display: inline-block; margin-top: 15px; padding: 10px 15px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">View Matched Item</a>
            </div>
          `,
        });
      } catch (err) {
        console.error("Failed to send email to new item owner:", err);
      }

      // email matched item owner
      try {
        await transporter.sendMail({
          from: `"Lost & Found" <${process.env.EMAIL_USER}>`,
          to: matched.user.email,
          subject: "We Found a Possible Match for Your Item!",
          html: `
            <div style="font-family: Arial, sans-serif; padding: 10px;">
              <h2 style="color: #333;">🎉 We Found a Possible Match!</h2>
              <p>Your reported item (${matched.title}) matches with the following:</p>
              <h3>${item.title}</h3>
              <p>${item.description}</p>
              ${item.imageUrl ? `<img src="${item.imageUrl}" alt="Item image" style="max-width: 200px; height: auto; border-radius: 5px; margin-top: 10px;">` : ''}
              <p><b>Similarity:</b> ${similarity.toFixed(3)}</p>
              <p><b>Location:</b> ${item.location || "N/A"}</p>
              <p><b>Date Reported:</b> ${new Date(item.createdAt).toLocaleDateString()}</p>
              <a href="${siteUrl}/items/${item.id}" style="display: inline-block; margin-top: 15px; padding: 10px 15px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">View Matched Item</a>
            </div>
          `,
        });
      } catch (err) {
        console.error("Failed to send email to matched item owner:", err);
      }
    }

    // optionally push real-time event
    // await pusherServer.trigger("items", "new-item", { item });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error("Error creating item:", error);
    return NextResponse.json({ message: "Error creating item", detail: (error as any).message }, { status: 500 });
  }
}
