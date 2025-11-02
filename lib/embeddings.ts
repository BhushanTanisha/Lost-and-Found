import sharp from "sharp";
import { pipeline } from "@xenova/transformers";

// Load CLIP model once
let extractor: any = null;

async function loadExtractor() {
  if (!extractor) {
    extractor = await pipeline(
      "feature-extraction",
      "Xenova/clip-vit-base-patch32"
    );
  }
  return extractor;
}

export async function generateImageEmbeddingFromBuffer(buffer: Buffer) {
  // Convert image to jpeg buffer
  const jpegBuffer = await sharp(buffer).jpeg().toBuffer();

  // Load CLIP image encoder
  const encoder = await loadExtractor();

  // Extract embedding
  const output = await encoder(jpegBuffer, {
    pooling: "mean",
    normalize: true,
  });

  // Convert from tensor to array
  return Array.from(output.data);
}
