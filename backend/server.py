from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import json
import re
import io
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone
from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
from docx import Document
from docx.shared import Pt, RGBColor, Inches


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Ignore MongoDB's _id field
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.model_dump()
    status_obj = StatusCheck(**status_dict)
    
    # Convert to dict and serialize datetime to ISO string for MongoDB
    doc = status_obj.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    
    _ = await db.status_checks.insert_one(doc)
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    # Exclude MongoDB's _id field from the query results
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    
    # Convert ISO string timestamps back to datetime objects
    for check in status_checks:
        if isinstance(check['timestamp'], str):
            check['timestamp'] = datetime.fromisoformat(check['timestamp'])
    
    return status_checks


# ─── BRIEF ANALYSIS (Claude via Emergent LLM Key) ─────────────────────────────

class AnalyzeBriefRequest(BaseModel):
    prompt: str

class AnalyzeBriefResponse(BaseModel):
    text: str

@api_router.post("/analyze-brief", response_model=AnalyzeBriefResponse)
async def analyze_brief(payload: AnalyzeBriefRequest):
    api_key = os.environ.get('EMERGENT_LLM_KEY')
    if not api_key:
        raise HTTPException(status_code=500, detail="LLM key not configured")
    if not payload.prompt or not payload.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt is required")

    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f"olc-brief-{uuid.uuid4()}",
            system_message="You are the internal creative intelligence for The Old Line Company (OLC)."
        ).with_model("anthropic", "claude-4-sonnet-20250514")

        response = await chat.send_message(UserMessage(text=payload.prompt))
        return AnalyzeBriefResponse(text=str(response))
    except Exception as e:
        logger.exception("Brief analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


# ─── INSPO ANALYZER (Gemini 2.5 Flash vision) ─────────────────────────────────

class AnalyzeImageRequest(BaseModel):
    image_base64: str  # raw base64 (no data: prefix) OR full data URL
    mime_type: Optional[str] = "image/jpeg"
    notes: Optional[str] = ""  # any creator notes to bias the analysis


INSPO_SYSTEM = (
    "You are a senior art director and image analyst for The Old Line Company (OLC). "
    "Given a reference image, you produce a precise structured breakdown a creator can act on, "
    "and you propose creative directional choices for a NEW piece inspired by it."
)

INSPO_PROMPT_TEMPLATE = """Analyze the attached reference image and return STRICT JSON only — no markdown, no commentary.

For each dimension, provide:
- "observed": a concise, specific description of what is in the reference image (1-3 sentences, concrete, no fluff)
- "options": THREE alternative creative directions an OLC creator could take for a NEW piece inspired by this reference. Each option is a short directive (under 25 words), genuinely distinct, not paraphrases of each other.

For "designer" dimension, also include "philosophy": a 1-2 sentence read on the design philosophy / school / movement at play (or best-guess attribution if unknown).

Return this EXACT JSON shape and nothing else:

{
  "subject": {"observed": "...", "options": ["...", "...", "..."]},
  "method": {"observed": "...", "options": ["...", "...", "..."]},
  "composition": {"observed": "...", "options": ["...", "...", "..."]},
  "designer": {"observed": "designer/firm name or 'unknown — likely [school/era]'", "philosophy": "...", "options": ["...", "...", "..."]},
  "method_to_achieve": {"observed": "concrete how-to: tools, technique, sequence", "options": ["...", "...", "..."]},
  "technical_specs": {"observed": "likely camera/software/equipment/settings — be specific even if inferred", "options": ["...", "...", "..."]}
}

Creator notes (bias the analysis if present): {notes}
"""


def _extract_json(text: str) -> Dict[str, Any]:
    """Extract the first JSON object from a string, tolerating code fences."""
    # Strip code fences if present
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    # Find first {...} block
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("No JSON object found in model response")
    return json.loads(match.group(0))


@api_router.post("/analyze-image")
async def analyze_image(payload: AnalyzeImageRequest):
    api_key = os.environ.get('EMERGENT_LLM_KEY')
    if not api_key:
        raise HTTPException(status_code=500, detail="LLM key not configured")
    if not payload.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    # Strip data URL prefix if present
    b64 = payload.image_base64
    if b64.startswith('data:'):
        comma = b64.find(',')
        if comma == -1:
            raise HTTPException(status_code=400, detail="Malformed data URL")
        b64 = b64[comma + 1:]

    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f"olc-inspo-{uuid.uuid4()}",
            system_message=INSPO_SYSTEM,
        ).with_model("gemini", "gemini-2.5-flash")

        prompt = INSPO_PROMPT_TEMPLATE.replace("{notes}", payload.notes or "(none)")

        image = ImageContent(image_base64=b64)
        response = await chat.send_message(UserMessage(
            text=prompt,
            file_contents=[image]
        ))

        raw = str(response)
        try:
            data = _extract_json(raw)
        except Exception:
            # Return raw so frontend can show it for manual triage instead of failing silently
            return {"raw": raw, "parsed": None}

        return {"raw": raw, "parsed": data}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Image analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


# ─── STRUCTURED PROMPT GENERATION ─────────────────────────────────────────────

class GeneratePromptRequest(BaseModel):
    title: Optional[str] = ""
    subject: Optional[str] = ""
    method: Optional[str] = ""
    composition: Optional[str] = ""
    designer: Optional[str] = ""
    method_to_achieve: Optional[str] = ""
    technical_specs: Optional[str] = ""
    notes: Optional[str] = ""

@api_router.post("/generate-prompt")
async def generate_prompt(payload: GeneratePromptRequest):
    """Assemble a structured executor prompt from the chosen directions.
    Pure template — no LLM call, no credit cost.
    """
    def _s(v):
        return (v or "").strip() if isinstance(v, str) else ""

    title = _s(payload.title) or "Untitled inspiration → new piece"
    lines = [
        f"# Brief Prompt — {title}",
        "",
        "You are an executor (designer / illustrator / photographer / motion artist) producing a new piece in the OLC voice. Use the structure below as your spec. Make choices within these directions; do not deviate from the dimensions called out.",
        "",
        "## SUBJECT",
        _s(payload.subject) or "(not specified)",
        "",
        "## METHOD",
        _s(payload.method) or "(not specified)",
        "",
        "## COMPOSITION",
        _s(payload.composition) or "(not specified)",
        "",
        "## DESIGN LINEAGE / PHILOSOPHY",
        _s(payload.designer) or "(not specified)",
        "",
        "## METHOD TO ACHIEVE THE LOOK",
        _s(payload.method_to_achieve) or "(not specified)",
        "",
        "## TECHNICAL SPECS / SETTINGS",
        _s(payload.technical_specs) or "(not specified)",
        "",
        "## CREATOR NOTES",
        _s(payload.notes) or "(none)",
        "",
        "## DELIVERY",
        "- Honor the subject and composition exactly.",
        "- Match the method and technical specs as closely as your tools allow.",
        "- Reference the design philosophy as a guardrail, not a costume.",
        "- Surface choices you made and why in a short note alongside the deliverable.",
    ]
    return {"prompt": "\n".join(lines)}


# ─── DOCX EXPORT ──────────────────────────────────────────────────────────────

class ExportDocxRequest(BaseModel):
    title: Optional[str] = "OLC Inspo Analysis"
    image_base64: Optional[str] = None  # optional — embed reference image
    mime_type: Optional[str] = "image/jpeg"
    breakdown: Dict[str, Any] = Field(default_factory=dict)  # observed values
    choices: Dict[str, Any] = Field(default_factory=dict)    # chosen values
    notes: Optional[str] = ""
    generated_prompt: Optional[str] = ""


def _add_heading(doc: Document, text: str, level: int = 1):
    h = doc.add_heading(text, level=level)
    return h


@api_router.post("/export-docx")
async def export_docx(payload: ExportDocxRequest):
    doc = Document()

    # Title
    title = doc.add_heading(payload.title or "OLC Inspo Analysis", level=0)
    sub = doc.add_paragraph()
    sub_run = sub.add_run(f"The Old Line Company  •  {datetime.now().strftime('%B %d, %Y')}")
    sub_run.italic = True
    sub_run.font.size = Pt(10)

    # Embed reference image if provided
    if payload.image_base64:
        try:
            import base64 as b64lib
            b64 = payload.image_base64
            if b64.startswith('data:'):
                comma = b64.find(',')
                if comma != -1:
                    b64 = b64[comma + 1:]
            img_bytes = b64lib.b64decode(b64)
            img_stream = io.BytesIO(img_bytes)
            doc.add_heading("Reference", level=1)
            doc.add_picture(img_stream, width=Inches(4.0))
        except Exception:
            logger.warning("Could not embed reference image into docx", exc_info=True)

    # Breakdown sections
    sections = [
        ("subject", "Subject"),
        ("method", "Method"),
        ("composition", "Composition"),
        ("designer", "Design Lineage / Philosophy"),
        ("method_to_achieve", "Method To Achieve The Look"),
        ("technical_specs", "Technical Specs / Settings"),
    ]

    doc.add_heading("Breakdown & Direction", level=1)
    for key, label in sections:
        doc.add_heading(label, level=2)
        observed = (payload.breakdown.get(key) or "").strip() or "—"
        chosen = (payload.choices.get(key) or "").strip() or "—"
        p = doc.add_paragraph()
        r = p.add_run("Observed: ")
        r.bold = True
        p.add_run(observed)
        p2 = doc.add_paragraph()
        r2 = p2.add_run("Direction chosen: ")
        r2.bold = True
        p2.add_run(chosen)

    # Notes
    if payload.notes and payload.notes.strip():
        doc.add_heading("Work Product Notes", level=1)
        doc.add_paragraph(payload.notes.strip())

    # Generated prompt
    if payload.generated_prompt and payload.generated_prompt.strip():
        doc.add_heading("Brief Prompt (for executor)", level=1)
        for line in payload.generated_prompt.split('\n'):
            if line.startswith('# '):
                doc.add_heading(line[2:], level=1)
            elif line.startswith('## '):
                doc.add_heading(line[3:], level=2)
            elif line.strip().startswith('- '):
                doc.add_paragraph(line.strip()[2:], style='List Bullet')
            elif line.strip() == '':
                doc.add_paragraph('')
            else:
                doc.add_paragraph(line)

    # Stream back
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    safe_title = re.sub(r"[^A-Za-z0-9_-]+", "_", (payload.title or "OLC_Inspo_Analysis"))[:60]
    filename = f"{safe_title}_{datetime.now().strftime('%Y%m%d_%H%M')}.docx"

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
