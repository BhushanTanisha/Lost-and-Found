from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
import requests
from io import BytesIO
from transformers import CLIPProcessor, CLIPModel
import torch

app = FastAPI()

# Load CLIP model once
model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
model.eval()

class Req(BaseModel):
    image_url: str

@app.post("/embedding")
def embedding(req: Req):
    try:
        # Fetch image
        r = requests.get(req.image_url, timeout=10)
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")

    # Open image
    img = Image.open(BytesIO(r.content)).convert("RGB")

    # Preprocess + compute embedding
    inputs = processor(images=img, return_tensors="pt")
    with torch.no_grad():
        features = model.get_image_features(**inputs)
        vec = features[0].tolist()

    return {"embedding": vec}
