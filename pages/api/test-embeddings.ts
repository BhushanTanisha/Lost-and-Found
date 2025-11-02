import type { NextApiRequest, NextApiResponse } from 'next'
import OpenAI from "openai";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: "test embedding"
    });

    return res.status(200).json({
      message: "OpenAI Embedding API works ✅",
      embeddingLength: response.data[0].embedding.length
    });

  } catch (error: any) {
    return res.status(500).json({
      message: "❌ Embedding API failed",
      error: error.message
    });
  }
}
