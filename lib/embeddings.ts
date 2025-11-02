import Jimp from "jimp";
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
  // ✅ Convert image to JPEG using Jimp (Sharp removed)
  const img = await Jimp.read(buffer);
  const jpegBuffer = await img.quality(90).getBufferAsync(Jimp.MIME_JPEG);

  // ✅ Load CLIP encoder
  const encoder = await loadExtractor();

  // ✅ Extract embedding
  const output = await encoder(jpegBuffer, {
    pooling: "mean",
    normalize: true,
  });

  // ✅ Output as array
  return Array.from(output.data);
}
