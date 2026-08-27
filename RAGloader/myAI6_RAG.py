"""
myAI6_RAG.py — myAI6 Semantic Document Chunking Pipeline
Written by Daniel M. Ringel, 2026

Copyright (c) 2026 Daniel M. Ringel
Released under the MIT License - see the LICENSE file in this repository.
Provided "as is", without warranty of any kind, express or implied; in no
event shall the author be liable for any claim, damages, or other liability
arising from the use of this software. Built for teaching and research -
please credit the author when you use or adapt this code.

All pipeline classes, helpers, and utilities for the myAI6 RAG system.
Import into a notebook or script and use with minimal boilerplate.

The pipeline: parse (Unstructured jobs API, with page-furniture removal,
formula-to-LaTeX and figure re-rendering) -> parent/child chunking ->
LLM enrichment (keywords, summaries, questions) -> proposition decomposition ->
image hosting (Cloudinary or SFTP) -> upsert into Pinecone (integrated
inference, 3 namespaces: children / parents / propositions).

Usage:
    from myAI6_RAG import *

    cfg = PipelineConfig(
        unstructured_api_key="...",              # platform.unstructured.io
        anthropic_api_key="...",                 # console.anthropic.com (paid credits)
        pinecone_api_key="...",                  # app.pinecone.io
        pinecone_index_host="https://<index-host>.pinecone.io",
        upload_provider="cloudinary",            # or "sftp" for a self-hosted webserver
        cloudinary_url="cloudinary://key:secret@cloud",
    )

    doc = DocumentConfig(
        source_name="My_Paper",                  # unique ID of this document everywhere
        source_description="A paper about X",    # shown to the LLM and embedded for search
        source_url="https://doi.org/...",        # "" = no link | URL | "upload" = host the file
        content_type="research_paper",           # see DocumentConfig for all types
    )

    result = process_and_upsert(cfg, "./paper.pdf", doc)

All tunable settings live in DEFAULT_CHUNKING_CONFIG below; override any subset
via PipelineConfig(chunking={...}). The companion notebook
(RAG_loader_pipeline.ipynb) documents every setting for end users.
"""

from __future__ import annotations
import base64, hashlib, json, logging, mimetypes, os, re, tempfile, time, urllib.parse
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from enum import Enum
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Optional

import anthropic
import requests
from keybert import KeyBERT
from pinecone import Pinecone
from unstructured_client import UnstructuredClient
from unstructured_client.models import operations
from unstructured_client.models import shared

logger = logging.getLogger("myAI6_RAG")


# ═════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═════════════════════════════════════════════════════════════════

# Fallback defaults only. The authoritative, editable copy of this config lives
# in the notebook (RAG_loader_pipeline.ipynb) and is passed in via
# PipelineConfig(chunking=...). Values here apply only when a key is not set there.
DEFAULT_CHUNKING_CONFIG = {
    # --- Document parsing (Unstructured jobs API) ---
    "hi_res": True,                    # analyze page layout visually (needed for figures/tables);
                                       # False falls back to the faster "auto" strategy
    "extract_image_block_types": ["Image", "Table"],  # visual elements to cut out as images
    "api_timeout": 600,                # max seconds to wait for a parsing job (~80-page papers fit)

    # --- Page furniture removal ---
    # Drop running headers/footers/page numbers and rotated margin watermarks
    # (e.g. "Downloaded from ... For personal use only") from elements and chunk
    # text. They pollute chunks and section breadcrumbs, and reversed
    # letter-spaced watermark text can trigger false-positive safety refusals.
    "strip_page_furniture": True,

    # --- Formula transcription ---
    # Display equations are OCR'd by Unstructured into flat (often garbled) text.
    # Crop each Formula element from the PDF and have the vision model transcribe
    # it to LaTeX; the chunk text then carries $$...$$ instead of the OCR text.
    "formula_latex": True,
    "formula_region_pad": 6,           # padding (PDF points) around the equation crop
    "formula_render_zoom": 3.0,        # crop zoom; 3x is sharp enough for symbols

    # --- Figure re-rendering ---
    # Re-render each detected figure directly from the PDF, expanding the crop to
    # include neighboring elements (side labels/annotations) in the figure's
    # vertical span. Fixes figures whose text columns get cropped off.
    "figure_region_render": True,
    "figure_region_pad": 12,           # padding (PDF points); lower if captions bleed in

    # --- Parent-child chunking (small-to-match, big-to-read) ---
    # Small "child" chunks are matched by vector search; their large "parent"
    # chunk is what the chatbot reads as context.
    "parent_max_characters": 3000,     # parent size: ~1 paper section, full context
    "parent_overlap": 200,             # overlap between parents (no sentences cut at boundaries)
    "parent_combine_under": 500,       # merge tiny sections into neighbors
    "parent_new_after": 2500,          # soft cap: start a new parent even mid-section
    "child_max_characters": 500,       # child size: ~3-4 sentences, precise query matching
    "child_overlap": 80,               # sentence overlap between children
    "child_min_characters": 100,       # smaller fragments merge into the previous child

    # --- LLM enrichment (Claude writes search metadata per child) ---
    "llm_thinking": "adaptive",        # "adaptive" (best quality) | "disabled" (faster/cheaper)
    "llm_effort": "high",              # reasoning depth when adaptive: low|medium|high|xhigh|max
    "llm_structured_output": True,     # schema-enforced JSON; prevents parse failures
    "llm_max_tokens": 16000,           # response ceiling; generous so reasoning+output never truncate
    "llm_content_truncation": 2000,    # max chars of a chunk shown to the LLM
    "enrichment_batch_size": 5,        # chunks per LLM call (cost vs per-chunk attention)
    "llm_requests_per_minute": 200,    # client-side rate limit (default Anthropic tier)
    "llm_retry_attempts": 3,           # retries on transient API errors per batch

    # --- Propositions (atomic facts as a second search index) ---
    "enable_propositions": True,       # Dense X Retrieval; biggest boost to answer precision
    "proposition_batch_size": 5,       # chunks per LLM call
    "proposition_max_tokens": 16000,   # ~15 facts x 5 chunks + reasoning fits comfortably

    # --- KeyBERT (local keyword extraction, free) ---
    "keyword_top_n": 10,               # keywords per chunk added to the embedding text
    "keybert_ngram_range": (1, 2),     # single words and two-word phrases
    "keybert_diversity": 0.5,          # 0=most relevant (repetitive) ... 1=most diverse

    # --- Vision (provider chosen by PipelineConfig.vision_model) ---
    "vision_thinking": "adaptive",     # "adaptive" | "disabled" (Claude models only)
    "vision_effort": "high",           # low|medium|high|xhigh|max (GPT models capped at high)
    "vision_max_tokens_describe": 4000,   # ceilings include reasoning tokens - generous so
    "vision_max_tokens_table": 8000,      #   answers never truncate; only used tokens are billed
    "vision_max_tokens_consolidate": 4000,

    # --- Slide rendering & local output folders ---
    "slide_render_zoom": 2.0,          # 2x render = crisp slide PNGs at reasonable size
    "output_dir_images": "./content/images",  # local copies of every uploaded image
    "output_dir_slides": "./content/slides",  # local copies of rendered slide PNGs

    # --- Pinecone namespaces (do not change after first upsert) ---
    "pinecone_ns_children": "children",         # retrieval units (matched by search)
    "pinecone_ns_parents": "parents",           # context units (read by the chatbot)
    "pinecone_ns_propositions": "propositions", # atomic facts (secondary index)
}



@dataclass
class PipelineConfig:
    """All credentials and settings in one place."""
    # API keys
    unstructured_api_key: str = ""
    anthropic_api_key: str = ""
    pinecone_api_key: str = ""
    openai_api_key: str = ""  # optional - only used when vision_model is a GPT model and/or moderations endpoint used

    # Unstructured jobs API host (bare host, no /api/v1 path - the SDK appends it)
    unstructured_api_url: str = "https://platform-api.transform.unstructured.io"

    # Pinecone
    pinecone_index_host: str = ""
    pinecone_index_name: str = "myAI6"  # needed for backups/restores (control plane uses names, not hosts)

    # LLM (text enrichment + propositions)
    llm_model: str = "claude-sonnet-5"

    # Vision (figure/table/slide descriptions).
    # A claude-* model runs on the Anthropic API; a gpt-* model runs on OpenAI.
    vision_model: str = "claude-sonnet-5"

    # Asset upload provider: where figure/table/slide images are hosted.
    #   "sftp"       - own webserver via SFTP (sftp_* fields below)
    #   "cloudinary" - Cloudinary free tier (pip install cloudinary); images are
    #                  served immediately; PDF/ZIP delivery is blocked on free
    #                  accounts until enabled in Settings -> Security
    upload_provider: str = "cloudinary"

    # Cloudinary provider ("cloudinary"): either set cloudinary_url
    # ("cloudinary://api_key:api_secret@cloud_name") or the CLOUDINARY_URL env var
    cloudinary_url: str = ""

    # SFTP
    sftp_host: str = ""
    sftp_port: int = 22
    sftp_user: str = ""
    sftp_pass: str = ""
    public_base: str = "https://data.domain.ai/src/example"

    # Chunking config (merged with DEFAULT_CHUNKING_CONFIG)
    chunking: dict = field(default_factory=dict)

    @property
    def cfg(self) -> dict:
        """Merged chunking config (defaults + overrides)."""
        merged = dict(DEFAULT_CHUNKING_CONFIG)
        merged.update(self.chunking)
        return merged


# ═════════════════════════════════════════════════════════════════
# DATA MODELS
# ═════════════════════════════════════════════════════════════════

@dataclass
class DocumentConfig:
    """Per-document metadata for myAI6 citations and content-type handling."""
    source_name: str = ""
    source_description: str = ""
    source_url: str = ""
    content_type: str = "text_doc"  # text_doc | research_paper | presentation | slides+text | standalone_image | standalone_table | notebook

    def __post_init__(self):
        if self.source_name:
            self.source_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", self.source_name).strip("_")
            self.source_name = re.sub(r"_+", "_", self.source_name)


class ChunkType(str, Enum):
    """Kind of content a chunk holds; drives enrichment and post-processing."""
    TEXT = "text"; TABLE = "table"; FIGURE = "figure"; MIXED = "mixed"
    CODE = "code"; CODE_OUTPUT = "code_output"


def _mkid(prefix, content, idx):
    return f"{prefix}_{idx}_{hashlib.sha256(content.encode()).hexdigest()[:12]}"


def _est_tok(text):
    return int(len(text.split()) * 1.3)


def _rid(source_name, plain_id):
    """Namespaced Pinecone record id: '<source_name>::<plain_id>'.

    Makes ids unique per source (no cross-document collisions) and enables
    exact prefix-based deletion via index.list(prefix=...)."""
    return f"{source_name}::{plain_id}" if source_name else plain_id


def _plain_id(record_id):
    """Strip the '<source_name>::' prefix from a record id (no-op for legacy ids)."""
    return record_id.split("::")[-1] if record_id else record_id


def _thinking_param(mode):
    """Anthropic thinking parameter from a config mode string."""
    return {"type": "disabled"} if mode == "disabled" else {"type": "adaptive"}


def _looks_garbled(text: str) -> bool:
    """True for OCR letter-salad like 'EEE EEEER EEEER' or 'o JOD' - captions
    must contain at least two plausible words to count as real text."""
    t = (text or "").strip()
    if re.match(r"^\s*(Figure|Table|Exhibit)\s+\d", t, re.I):
        return False
    words = re.findall(r"[A-Za-z]{3,}", t)
    real = [w for w in words if re.search(r"[aeiouAEIOU]", w) and len(set(w.lower())) >= 3]
    return len(real) < 2 or len(real) < max(1, len(words) // 3)


def _remote_dir(source_name: str) -> str:
    """Short, unique remote folder for a source's images: first 40 chars of the
    source name plus a 6-char hash. Keeps image URLs ~100 chars - long URLs
    (the full source name repeated in folder and file name) get mis-copied by
    the chatbot's LLM and render as 'Image not available'."""
    slug = re.sub(r"[^A-Za-z0-9_-]", "_", source_name)[:40].rstrip("_-")
    return f"{slug}-{hashlib.sha1(source_name.encode()).hexdigest()[:6]}"


@dataclass
class ChunkMeta:
    """Raw element metadata carried along from the Unstructured parser."""
    element_id: str = ""; element_types: list[str] = field(default_factory=list)
    page_numbers: list[int] = field(default_factory=list)
    filename: str = ""; filetype: str = ""; languages: list[str] = field(default_factory=list)
    coordinates: Optional[dict] = None; text_as_html: Optional[str] = None
    link_urls: list[str] = field(default_factory=list)
    is_continuation: bool = False; orig_elements_count: int = 1
    def to_dict(self): return {k: v for k, v in asdict(self).items() if v}


@dataclass
class StructChunk:
    """One structural unit from parsing: a text block, table, or figure."""
    chunk_id: str = ""; content: str = ""; chunk_type: str = "text"
    element_types: list[str] = field(default_factory=list)
    page_numbers: list[int] = field(default_factory=list)
    section_hierarchy: list[str] = field(default_factory=list)
    context_breadcrumb: str = ""; char_count: int = 0
    metadata: ChunkMeta = field(default_factory=ChunkMeta)
    table_html: Optional[str] = None; table_data: Optional[list[list[str]]] = None
    table_markdown: Optional[str] = None
    figure_caption: Optional[str] = None; figure_base64: Optional[str] = None


@dataclass
class ParentChunk:
    """Large chunk (~3000 chars) — CONTEXT unit for LLM."""
    parent_id: str = ""; content: str = ""; chunk_type: str = "text"
    section_hierarchy: list[str] = field(default_factory=list)
    context_breadcrumb: str = ""; page_numbers: list[int] = field(default_factory=list)
    child_ids: list[str] = field(default_factory=list)
    char_count: int = 0; token_estimate: int = 0
    table_html: Optional[str] = None; figure_caption: Optional[str] = None
    table_markdown: Optional[str] = None; figure_base64: Optional[str] = None
    source_url: Optional[str] = None
    source_name: str = ""; source_description: str = ""
    image_url: Optional[str] = None
    def to_dict(self): return {k: v for k, v in asdict(self).items() if v}


@dataclass
class ChildChunk:
    """Small chunk (~500 chars) — RETRIEVAL unit for vector search."""
    child_id: str = ""; parent_id: str = ""; content: str = ""
    chunk_type: str = "text"; position_in_parent: int = 0
    keywords: list[str] = field(default_factory=list)
    summary: str = ""; description: str = ""
    context_breadcrumb: str = ""; section_hierarchy: list[str] = field(default_factory=list)
    hypothetical_questions: list[str] = field(default_factory=list)
    page_numbers: list[int] = field(default_factory=list)
    char_count: int = 0; token_estimate: int = 0; content_hash: str = ""
    table_html: Optional[str] = None; table_data: Optional[list[list[str]]] = None
    table_markdown: Optional[str] = None
    figure_caption: Optional[str] = None; figure_base64: Optional[str] = None
    source_url: Optional[str] = None
    source_name: str = ""; source_description: str = ""
    image_url: Optional[str] = None; order: int = 0
    def to_dict(self): return {k: v for k, v in asdict(self).items() if v}


@dataclass
class Proposition:
    """Atomic, self-contained factual statement."""
    proposition_id: str = ""; proposition: str = ""
    source_child_id: str = ""; source_parent_id: str = ""
    source_content: str = ""; context_breadcrumb: str = ""
    section_hierarchy: list[str] = field(default_factory=list)
    page_numbers: list[int] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    token_estimate: int = 0; source_url: Optional[str] = None
    source_name: str = ""; source_description: str = ""
    def to_dict(self): return {k: v for k, v in asdict(self).items() if v}


@dataclass
class PipelineResult:
    """Everything one document produced: parents, children, propositions, stats."""
    filename: str = ""; source_url: Optional[str] = None
    total_pages: int = 0; raw_element_count: int = 0
    parent_chunks: list[ParentChunk] = field(default_factory=list)
    child_chunks: list[ChildChunk] = field(default_factory=list)
    propositions: list[Proposition] = field(default_factory=list)
    llm_calls_made: int = 0; llm_tokens_used: int = 0; processing_time_seconds: float = 0.0

    @property
    def parent_lookup(self):
        return {p.parent_id: p for p in self.parent_chunks}

    def get_parent_for_child(self, c):
        return self.parent_lookup.get(c.parent_id)

    def get_children_for_parent(self, pid):
        return [c for c in self.child_chunks if c.parent_id == pid]

    def get_propositions_for_child(self, cid):
        return [p for p in self.propositions if p.source_child_id == cid]

    def to_dict(self):
        return {
            "filename": self.filename, "source_url": self.source_url,
            "total_pages": self.total_pages, "raw_element_count": self.raw_element_count,
            "parent_chunks": [p.to_dict() for p in self.parent_chunks],
            "child_chunks": [c.to_dict() for c in self.child_chunks],
            "propositions": [p.to_dict() for p in self.propositions],
            "stats": {
                "parents": len(self.parent_chunks), "children": len(self.child_chunks),
                "propositions": len(self.propositions), "llm_calls": self.llm_calls_made,
                "llm_tokens": self.llm_tokens_used, "seconds": self.processing_time_seconds,
            },
        }

    def to_json(self, indent=2):
        return json.dumps(self.to_dict(), indent=indent, ensure_ascii=False)


@dataclass
class RetrievalHit:
    """One retrieval result: matched child plus its parent context."""
    child_id: str = ""; parent_id: str = ""; child_content: str = ""
    parent_content: str = ""; score: float = 0.0; chunk_type: str = "text"
    context_breadcrumb: str = ""; page_numbers: list[int] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list); summary: str = ""
    matched_propositions: list[str] = field(default_factory=list)
    source_url: Optional[str] = None


@dataclass
class RetrievalResponse:
    """Retrieval results plus a ready-to-use context string for an LLM."""
    query: str = ""; results: list[RetrievalHit] = field(default_factory=list)
    total_context_tokens: int = 0

    @property
    def context_for_llm(self):
        parts = []
        for i, r in enumerate(self.results):
            src = f" | Source: {r.source_url}" if r.source_url else ""
            parts.append(
                f"[Source {i+1}] Pages {r.page_numbers} | Section: {r.context_breadcrumb}{src}\n{r.parent_content}"
            )
        return "\n\n---\n\n".join(parts)


# ═════════════════════════════════════════════════════════════════
# KEYBERT KEYWORDS
# ═════════════════════════════════════════════════════════════════

_kw_model = None

def extract_keywords(text: str, top_n: int = 10, cfg: dict | None = None) -> list[str]:
    """Local (free) keyword extraction with KeyBERT; returns top_n keyphrases."""
    global _kw_model
    if not text or not text.strip():
        return []
    if _kw_model is None:
        _kw_model = KeyBERT()
    c = cfg or DEFAULT_CHUNKING_CONFIG
    try:
        return [
            kw for kw, _ in _kw_model.extract_keywords(
                text,
                keyphrase_ngram_range=c.get("keybert_ngram_range", (1, 2)),
                stop_words="english",
                top_n=top_n,
                use_mmr=True,
                diversity=c.get("keybert_diversity", 0.5),
            )
        ]
    except Exception as e:
        logger.warning("KeyBERT failed: %s", e)
        return []


# ═════════════════════════════════════════════════════════════════
# HTML TABLE PARSER
# ═════════════════════════════════════════════════════════════════

def _parse_table_html(html):
    """Parse HTML table into a 2D grid, expanding colspan/rowspan."""
    try:
        class P(HTMLParser):
            def __init__(self):
                super().__init__()
                self.rows = []; self._current_row = []; self._cell_text = ""
                self._in_cell = False; self._cell_attrs = {}
            def handle_starttag(self, tag, attrs):
                if tag == "tr":
                    self._current_row = []
                elif tag in ("td", "th"):
                    self._in_cell = True; self._cell_text = ""
                    self._cell_attrs = dict(attrs)
            def handle_endtag(self, tag):
                if tag in ("td", "th") and self._in_cell:
                    self._in_cell = False
                    colspan = int(self._cell_attrs.get("colspan", 1))
                    rowspan = int(self._cell_attrs.get("rowspan", 1))
                    text = self._cell_text.strip()
                    self._current_row.append({"text": text, "colspan": colspan, "rowspan": rowspan})
                elif tag == "tr" and self._current_row:
                    self.rows.append(self._current_row)
            def handle_data(self, data):
                if self._in_cell:
                    self._cell_text += data
        p = P(); p.feed(html)
        if not p.rows:
            return None
        max_cols = max(sum(c["colspan"] for c in row) for row in p.rows)
        grid = [[""] * max_cols for _ in range(len(p.rows) * 2)]
        for ri, row in enumerate(p.rows):
            ci = 0
            for cell in row:
                while ci < len(grid[ri]) and grid[ri][ci] != "":
                    ci += 1
                for dr in range(cell["rowspan"]):
                    for dc in range(cell["colspan"]):
                        r, c = ri + dr, ci + dc
                        if r < len(grid) and c < len(grid[r]):
                            grid[r][c] = cell["text"]
                ci += cell["colspan"]
        grid = [row for row in grid[:len(p.rows)] if any(cell != "" for cell in row)]
        return grid or None
    except Exception:
        return None


def _html_table_to_markdown(table_html):
    """Convert HTML table to markdown format."""
    rows = _parse_table_html(table_html)
    if not rows:
        return ""
    max_cols = max(len(r) for r in rows)
    rows = [r + [""] * (max_cols - len(r)) for r in rows]
    rows = [[c.replace("|", "\\|") for c in r] for r in rows]
    header = "| " + " | ".join(rows[0]) + " |"
    sep = "| " + " | ".join(["---"] * max_cols) + " |"
    body = "\n".join("| " + " | ".join(r) + " |" for r in rows[1:])
    return f"{header}\n{sep}\n{body}" if body else f"{header}\n{sep}"


# ═════════════════════════════════════════════════════════════════
# DOCUMENT SOURCE
# ═════════════════════════════════════════════════════════════════

class DocumentSource:
    """Resolves a document from local path or URL."""
    def __init__(self, source: str, source_url: Optional[str] = None, timeout: int = 120):
        self.original_source = source
        self._user_url = source_url
        self.source_url: Optional[str] = None
        self.filepath = Path(); self.filename = ""
        self._tmp: Optional[tempfile.TemporaryDirectory] = None
        self._timeout = timeout

    def resolve(self) -> Path:
        if self.original_source.strip().startswith(("http://", "https://")):
            self._download(self.original_source)
            self.source_url = self._user_url or self.original_source
        else:
            p = Path(self.original_source)
            if not p.exists():
                raise FileNotFoundError(f"Not found: {p}")
            self.filepath = p; self.filename = p.name
            self.source_url = self._user_url
        return self.filepath

    def cleanup(self):
        if self._tmp:
            self._tmp.cleanup(); self._tmp = None

    def _download(self, url):
        resp = requests.get(url, timeout=self._timeout, stream=True)
        resp.raise_for_status()
        self.filename = self._fname(url, resp)
        self._tmp = tempfile.TemporaryDirectory(prefix="chunker_")
        self.filepath = Path(self._tmp.name) / self.filename
        with open(self.filepath, "wb") as f:
            for chunk in resp.iter_content(8192):
                f.write(chunk)

    @staticmethod
    def _fname(url, resp):
        cd = resp.headers.get("Content-Disposition", "")
        if "filename=" in cd:
            n = cd.split("filename=")[1].strip().strip('"\'')
            if n:
                return n
        n = Path(urllib.parse.unquote(urllib.parse.urlparse(url).path)).name
        if n and "." in n:
            return n
        ct = resp.headers.get("Content-Type", "")
        for m, e in [("application/pdf", ".pdf"), ("text/html", ".html")]:
            if m in ct:
                return f"document{e}"
        return "document.pdf"


# ═════════════════════════════════════════════════════════════════
# STRUCTURAL PARSER (Unstructured Python SDK)
# ═════════════════════════════════════════════════════════════════

class StructuralParser:
    """Unstructured jobs-API parser: one job per document with a partition node
    and a chunk_by_title node; both node outputs are downloaded separately
    (raw elements for hierarchy/figures/tables, chunked elements for parents)."""

    def __init__(self, api_key, config, server_url, pcfg: "PipelineConfig | None" = None):
        self.client = UnstructuredClient(api_key_auth=api_key, server_url=server_url)
        self.cfg = config
        self.pcfg = pcfg  # needed for formula transcription (vision model)

    def parse(self, filepath: Path, content_type: str = "text_doc") -> list[StructChunk]:
        fp = Path(filepath)

        # Standalone image
        if content_type == "standalone_image":
            b64 = base64.b64encode(fp.read_bytes()).decode("utf-8")
            return [StructChunk(
                chunk_id=f"img-{fp.stem}-001", content="",
                chunk_type=ChunkType.FIGURE, element_types=["Image"],
                page_numbers=[1], figure_base64=b64, char_count=0,
            )]

        # Standalone table
        if content_type == "standalone_table":
            import csv
            suffix = fp.suffix.lower()
            if suffix in (".csv", ".tsv"):
                raw_text = fp.read_text(encoding="utf-8")
                dialect = csv.Sniffer().sniff(raw_text[:2048])
                reader = csv.reader(raw_text.strip().splitlines(), dialect)
                rows = list(reader)
                if rows:
                    max_cols = max(len(r) for r in rows)
                    rows = [r + [""] * (max_cols - len(r)) for r in rows]
                    header = "| " + " | ".join(rows[0]) + " |"
                    sep = "| " + " | ".join(["---"] * max_cols) + " |"
                    body = "\n".join("| " + " | ".join(r) + " |" for r in rows[1:])
                    md = f"{header}\n{sep}\n{body}" if body else f"{header}\n{sep}"
                else:
                    md = raw_text
                return [StructChunk(
                    chunk_id=f"tbl-{fp.stem}-001", content=md,
                    chunk_type=ChunkType.TABLE, element_types=["Table"],
                    page_numbers=[1], table_markdown=md, char_count=len(md),
                )]
            else:
                b64 = base64.b64encode(fp.read_bytes()).decode("utf-8")
                return [StructChunk(
                    chunk_id=f"tbl-{fp.stem}-001", content="",
                    chunk_type=ChunkType.TABLE, element_types=["Table"],
                    page_numbers=[1], figure_base64=b64, char_count=0,
                )]

        # Notebook
        if content_type == "notebook":
            nb_data = json.loads(fp.read_text(encoding="utf-8"))
            chunks = []
            current_heading = ""
            for ci, cell in enumerate(nb_data.get("cells", [])):
                cell_src = "".join(cell.get("source", []))
                if not cell_src.strip():
                    continue
                cell_type = cell.get("cell_type", "code")
                if cell_type == "markdown":
                    for line in cell_src.splitlines():
                        line = line.strip()
                        if line.startswith("#"):
                            current_heading = line.lstrip("#").strip()
                    ct = ChunkType.TEXT
                else:
                    ct = ChunkType.CODE
                chunks.append(StructChunk(
                    chunk_id=f"nb-{fp.stem}-cell{ci:03d}", content=cell_src,
                    chunk_type=ct,
                    element_types=["NarrativeText" if cell_type == "markdown" else "CodeSnippet"],
                    page_numbers=[ci + 1], context_breadcrumb=current_heading,
                    char_count=len(cell_src),
                ))
                if cell_type == "code":
                    for out in cell.get("outputs", []):
                        img_data = out.get("data", {})
                        png_b64 = img_data.get("image/png", "")
                        if png_b64:
                            chunks.append(StructChunk(
                                chunk_id=f"nb-{fp.stem}-cell{ci:03d}-out",
                                content=cell_src[:200], chunk_type=ChunkType.CODE_OUTPUT,
                                element_types=["Image"], page_numbers=[ci + 1],
                                context_breadcrumb=current_heading,
                                figure_base64=png_b64.strip(), char_count=len(cell_src[:200]),
                            ))
            return chunks

        # Standard document: one Unstructured job, two node outputs
        raw_elements, chunked_elements = self._run_partition_job(fp)
        if self.cfg.get("strip_page_furniture", True):
            raw_elements, chunked_elements = self._strip_page_furniture(raw_elements, chunked_elements)
        if self.cfg.get("formula_latex", True) and fp.suffix.lower() == ".pdf" and self.pcfg is not None:
            raw_elements, chunked_elements = self._formulas_to_latex(fp, raw_elements, chunked_elements)

        # Section hierarchy from unchunked elements
        hstack = []
        page_sections = {}
        for elem in raw_elements:
            et = elem.get("type", "")
            txt = elem.get("text", "").strip()
            meta = elem.get("metadata", {})
            pg = meta.get("page_number")
            if et in ("Title", "Header") and txt:
                depth = meta.get("category_depth", 0) or 0
                hstack = hstack[:depth]
                hstack.append(txt)
            if pg and hstack:
                page_sections[pg] = (list(hstack), " > ".join(hstack))

        # Extract figures and tables (skip for presentations)
        if content_type in ("presentation", "slides+text"):
            figures, tables, captions = [], [], {}
        else:
            figures, tables, captions = [], [], {}
            for elem in raw_elements:
                if elem.get("type") == "FigureCaption":
                    pg = elem.get("metadata", {}).get("page_number")
                    if pg:
                        captions[pg] = elem.get("text", "")
            for elem in raw_elements:
                meta = elem.get("metadata", {})
                pg = meta.get("page_number")
                et = elem.get("type", "")
                b64 = meta.get("image_base64")
                if et == "Image" and b64 and pg and len(b64) > 5000:
                    sec = page_sections.get(pg, ([], ""))
                    cap = captions.get(pg, "") or elem.get("text", "")
                    if _looks_garbled(cap):
                        cap = ""  # OCR junk (e.g. graphics misread as a caption)
                    figures.append({
                        "page": pg, "base64": b64,
                        "caption": cap,
                        "text": elem.get("text", ""),
                        "hierarchy": sec[0], "breadcrumb": sec[1],
                        "coordinates": meta.get("coordinates"),
                    })
                elif et == "Table" and pg:
                    sec = page_sections.get(pg, ([], ""))
                    tables.append({
                        "page": pg, "base64": b64,
                        "html": meta.get("text_as_html"),
                        "text": elem.get("text", ""),
                        "hierarchy": sec[0], "breadcrumb": sec[1],
                    })

            if figures and fp.suffix.lower() == ".pdf" and self.cfg.get("figure_region_render", True):
                figures = self._merge_figure_fragments(figures, raw_elements)
                self._rerender_figures(fp, figures, raw_elements)

            print(f"   Pass 1 (unchunked): {len(raw_elements)} elements, "
                  f"{len(figures)} figures, {len(tables)} tables, "
                  f"{len(page_sections)} pages with sections")
            print(f"   Pass 2 (chunked):   {len(chunked_elements)} chunks")

        text_chunks = self._build_text_chunks(chunked_elements, filepath.name, page_sections)

        # Standalone figure chunks
        fig_chunks = []
        for fi, fig in enumerate(figures):
            content = fig["caption"] or fig["text"] or f"Figure on page {fig['page']}"
            fig_chunks.append(StructChunk(
                chunk_id=_mkid("sf", content, fi), content=content,
                chunk_type=ChunkType.FIGURE, element_types=["Image"],
                page_numbers=[fig["page"]], section_hierarchy=fig["hierarchy"],
                context_breadcrumb=fig["breadcrumb"], char_count=len(content),
                figure_caption=fig["caption"], figure_base64=fig["base64"],
                metadata=ChunkMeta(page_numbers=[fig["page"]], filename=filepath.name),
            ))

        # Standalone table chunks
        tbl_chunks = []
        for ti, tbl in enumerate(tables):
            content = tbl["text"] or f"Table on page {tbl['page']}"
            thtml = tbl.get("html")
            tbl_chunks.append(StructChunk(
                chunk_id=_mkid("st", content, ti), content=content,
                chunk_type=ChunkType.TABLE, element_types=["Table"],
                page_numbers=[tbl["page"]], section_hierarchy=tbl["hierarchy"],
                context_breadcrumb=tbl["breadcrumb"], char_count=len(content),
                table_html=thtml,
                table_data=_parse_table_html(thtml) if thtml else None,
                table_markdown=_html_table_to_markdown(thtml) if thtml else None,
                figure_base64=tbl.get("base64"),
                metadata=ChunkMeta(page_numbers=[tbl["page"]], filename=filepath.name, text_as_html=thtml),
            ))

        all_chunks = text_chunks + fig_chunks + tbl_chunks
        all_chunks.sort(key=lambda c: (c.page_numbers[0] if c.page_numbers else 999, c.chunk_id))
        print(f"   Merged: {len(text_chunks)} text + {len(fig_chunks)} figures + {len(tbl_chunks)} tables = {len(all_chunks)} total")
        return all_chunks

    _SPACED_RUN = re.compile(r"(?:(?<!\S)\S(?!\S)\s+){5,}(?:(?<!\S)\S(?!\S))?")

    def _strip_page_furniture(self, raw_elements, chunked_elements):
        """Remove page furniture from both node outputs.

        Junk = Header/Footer/PageNumber elements plus any element whose box is
        a tall narrow strip (rotated margin text such as download watermarks).
        Those elements are dropped from the raw list (so they cannot enter the
        section hierarchy) and their text is cut out of every chunk; runs of
        isolated single characters (the reversed, letter-spaced watermark) are
        removed as a safety net. Chunks left empty are dropped."""
        junk_texts, kept = set(), []
        for el in raw_elements:
            text = (el.get("text") or "").strip()
            parsed = self._coords_to_box(el.get("metadata", {}).get("coordinates"))
            tall = False
            if parsed:
                (x0, y0, x1, y1), _, _ = parsed
                tall = (y1 - y0) / max(x1 - x0, 1) > 4
            if el.get("type") in ("Header", "Footer", "PageNumber") or tall:
                if text:
                    junk_texts.add(text)
                continue
            kept.append(el)
        removed_raw = len(raw_elements) - len(kept)

        # Long junk strings (running headers, watermark fragments) are removed
        # wherever they appear; short ones (page numbers like "15") only when
        # they form a whole line, so they never eat digits inside real text.
        long_junk = sorted((j for j in junk_texts if len(j) >= 12), key=len, reverse=True)
        short_junk = [j for j in junk_texts if len(j) < 12]
        short_line = re.compile(
            r"^[ \t]*(?:" + "|".join(re.escape(j) for j in short_junk) + r")[ \t]*$", re.M
        ) if short_junk else None
        def clean(text):
            for j in long_junk:
                if j in text:
                    text = text.replace(j, " ")
            if short_line:
                text = short_line.sub("", text)
            text = self._SPACED_RUN.sub(" ", text)
            # leftover debris: lines holding a single character (watermark letters,
            # rotated axis/table labels) or nothing but whitespace
            text = re.sub(r"^[ \t]*\S?[ \t]*$\n?", "", text, flags=re.M)
            text = re.sub(r"[ \t]+", " ", text)
            return re.sub(r"\n{3,}", "\n\n", text).strip()

        # raw elements feed tables, captions and the section hierarchy: clean them too
        kept = [dict(el, text=clean(el.get("text") or "")) for el in kept]

        cleaned = []
        for el in chunked_elements:
            text = clean(el.get("text") or "")
            if not text:
                continue
            el = dict(el); el["text"] = text
            cleaned.append(el)
        print(f"   Page furniture: removed {removed_raw} elements, "
              f"{len(chunked_elements) - len(cleaned)} empty chunks dropped")
        return kept, cleaned

    def _formulas_to_latex(self, pdf_path: Path, raw_elements, chunked_elements):
        """Transcribe Formula elements to LaTeX with the vision model and replace
        their OCR text in the chunks with $$...$$ blocks."""
        try:
            import fitz
        except ImportError:
            logger.warning("pymupdf not installed - formulas left as OCR text")
            return raw_elements, chunked_elements
        forms = [el for el in raw_elements
                 if el.get("type") == "Formula" and len((el.get("text") or "").strip()) >= 6
                 and el.get("metadata", {}).get("coordinates") and el.get("metadata", {}).get("page_number")]
        if not forms:
            return raw_elements, chunked_elements
        zoom = self.cfg.get("formula_render_zoom", 3.0)
        pad = self.cfg.get("formula_region_pad", 6)
        mapping = {}
        doc = fitz.open(str(pdf_path))
        try:
            for el in forms:
                m = el["metadata"]; pg = m["page_number"]
                parsed = self._coords_to_box(m.get("coordinates"))
                if not parsed or not (1 <= pg <= len(doc)):
                    continue
                (x0, y0, x1, y1), lw, lh = parsed
                page = doc[pg - 1]
                sx = page.rect.width / (lw or page.rect.width)
                sy = page.rect.height / (lh or page.rect.height)
                clip = fitz.Rect(max(0, x0 * sx - pad), max(0, y0 * sy - pad),
                                 min(page.rect.width, x1 * sx + pad), min(page.rect.height, y1 * sy + pad))
                try:
                    png = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False).tobytes("png")
                    latex = formula_image_to_latex(png, el["text"].strip(), pcfg=self.pcfg, cfg=self.cfg)
                except Exception as e:
                    logger.warning("Formula transcription failed on page %s: %s", pg, e)
                    continue
                if latex:
                    mapping[el["text"].strip()] = latex
        finally:
            doc.close()

        def substitute(text):
            for ocr, latex in mapping.items():
                block = f"\n\n$$\n{latex}\n$$\n\n"
                if ocr in text:
                    text = text.replace(ocr, block)
                else:  # whitespace may differ between the raw element and the chunk
                    pat = r"\s+".join(re.escape(t) for t in ocr.split())
                    text = re.sub(pat, lambda _m: block, text)
            return re.sub(r"\n{3,}", "\n\n", text).strip()

        raw_out = [dict(el, text=f"$$\n{mapping[el['text'].strip()]}\n$$")
                   if el.get("type") == "Formula" and (el.get("text") or "").strip() in mapping else el
                   for el in raw_elements]
        chunk_out = [dict(c, text=substitute(c.get("text") or "")) for c in chunked_elements]
        print(f"   Formulas: {len(mapping)}/{len(forms)} transcribed to LaTeX")
        return raw_out, chunk_out

    @staticmethod
    def _coords_to_box(coords):
        """Unstructured coordinates dict -> ([x0, y0, x1, y1], layout_w, layout_h)."""
        pts = (coords or {}).get("points") or []
        if not pts:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return [min(xs), min(ys), max(xs), max(ys)], coords.get("layout_width"), coords.get("layout_height")

    def _merge_figure_fragments(self, figures: list[dict], raw_elements: list[dict] | None = None) -> list[dict]:
        """Merge image fragments that belong to ONE multi-panel figure.

        Unstructured detects each panel of a composite figure (e.g. a four-phase
        framework diagram) as a separate Image element; rendered individually,
        every panel loses the shared labels. Two fragments are merged when they
        sit in the same horizontal band (side-by-side panels) or are stacked
        with almost no vertical gap (tight grids). Distinct figures on one page
        keep their separating whitespace/captions and stay apart."""
        out, by_page = [], defaultdict(list)
        for f in figures:
            parsed = self._coords_to_box(f.get("coordinates"))
            if parsed:
                by_page[f["page"]].append((f, parsed))
            else:
                out.append(f)
        # count "Figure N." caption lines per page: a page with several image
        # fragments but a SINGLE figure caption is one full-page figure
        fig_caption_lines = defaultdict(int)
        for el in (raw_elements or []):
            if re.match(r"^\s*(Figure|Exhibit)\s+\d", (el.get("text") or "").strip(), re.I):
                pg = el.get("metadata", {}).get("page_number")
                if pg:
                    fig_caption_lines[pg] += 1
        for page, items in by_page.items():
            def find(i):
                while parent[i] != i:
                    parent[i] = parent[parent[i]]; i = parent[i]
                return i
            n = len(items)
            if n >= 2 and fig_caption_lines.get(page, 0) == 1:
                parent = [0] * n  # one caption -> merge every fragment
            else:
                parent = list(range(n))
                for i in range(n):
                    (x0a, y0a, x1a, y1a), lw, lh = items[i][1]
                    for j in range(i + 1, n):
                        (x0b, y0b, x1b, y1b), _, _ = items[j][1]
                        v_ov = min(y1a, y1b) - max(y0a, y0b)
                        h_ov = min(x1a, x1b) - max(x0a, x0b)
                        same_row = (v_ov > 0.4 * min(y1a - y0a, y1b - y0b)
                                    and -h_ov < 0.20 * (lw or 1))
                        stacked = (h_ov > 0.4 * min(x1a - x0a, x1b - x0b)
                                   and -v_ov < 0.04 * (lh or 1))
                        if same_row or stacked:
                            parent[find(i)] = find(j)
            groups = defaultdict(list)
            for i in range(n):
                groups[find(i)].append(items[i])
            for members in groups.values():
                if len(members) == 1:
                    out.append(members[0][0]); continue
                boxes = [m[1][0] for m in members]
                lw, lh = members[0][1][1], members[0][1][2]
                x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
                x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
                first = members[0][0]
                merged = dict(first)
                merged["caption"] = next((m[0]["caption"] for m in members if m[0].get("caption")), "")
                merged["text"] = " ".join(dict.fromkeys(m[0].get("text", "") for m in members if m[0].get("text"))).strip()
                merged["coordinates"] = {"points": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                                         "layout_width": lw, "layout_height": lh}
                out.append(merged)
                print(f"   Merged {len(members)} figure fragments on page {page} into one figure")
        out.sort(key=lambda f: (f["page"],))
        return out

    def _rerender_figures(self, pdf_path: Path, figures: list[dict], raw_elements: list[dict]):
        """Replace each figure's extracted image with a region rendered straight
        from the PDF. The crop is the figure's bounding box expanded to include
        any element that sits mostly within the figure's vertical span (side
        labels, step descriptions, annotations) - Unstructured's own crop covers
        only the graphic block and cuts those off."""
        try:
            import fitz
        except ImportError:
            logger.warning("pymupdf not installed - keeping Unstructured's figure crops")
            return
        # Union candidates: real text blocks only - not other figures/tables (would
        # merge separate figures on the same page), not page furniture, and not
        # stray punctuation fragments from rotated margin watermarks.
        skip_types = {"Image", "Table", "Header", "Footer", "PageNumber", "PageBreak"}
        caption_re = re.compile(r"^\s*(Figure|Table|Exhibit)\s+\d|^\s*Notes?\s*[:.]", re.I)
        boxes_by_page = {}
        for el in raw_elements:
            if el.get("type") in skip_types:
                continue
            text = (el.get("text") or "").strip()
            if len(text) < 3:
                continue
            m = el.get("metadata", {})
            pg = m.get("page_number")
            parsed = self._coords_to_box(m.get("coordinates"))
            if pg and parsed:
                boxes_by_page.setdefault(pg, []).append((parsed[0], bool(caption_re.match(text)), text))
        zoom = self.cfg.get("slide_render_zoom", 2.0)
        pad = self.cfg.get("figure_region_pad", 12)
        doc = fitz.open(str(pdf_path))
        rerendered = 0
        try:
            for fig in figures:
                pg = fig["page"]
                parsed = self._coords_to_box(fig.get("coordinates"))
                if not parsed or not (1 <= pg <= len(doc)):
                    continue
                (x0, y0, x1, y1), lw, lh = parsed
                fig_top, fig_bot = y0, y1
                band = 0.03 * (lh or 1)  # caption/title band just above or below the figure
                # iterate: newly included label rows can pull in the text right
                # below them (phase descriptions, notes) on the next pass. A
                # caption/notes line ("Figure N.", "Notes:") is the natural
                # bottom boundary - once absorbed, nothing below it joins.
                floor = None
                for _ in range(4):
                    changed = False
                    for ob, is_caption, ob_text in boxes_by_page.get(pg, []):
                        ow = max(ob[2] - ob[0], 1)
                        oh = max(ob[3] - ob[1], 1)
                        if oh / ow > 4:  # tall narrow strip: margin text/watermark, not figure content
                            continue
                        if floor is not None and ob[1] >= floor:
                            continue  # below the caption line: body text, not figure content
                        overlap = min(y1, ob[3]) - max(y0, ob[1])
                        h_ov = min(x1, ob[2]) - max(x0, ob[0])
                        near_band = (h_ov > 0.5 * ow and
                                     (0 <= y0 - ob[3] <= band or 0 <= ob[1] - y1 <= band))
                        if overlap / oh >= 0.6 or near_band:
                            nx0 = min(x0, ob[0]); ny0 = min(y0, ob[1])
                            nx1 = max(x1, ob[2]); ny1 = max(y1, ob[3])
                            if (nx0, ny0, nx1, ny1) != (x0, y0, x1, y1):
                                x0, y0, x1, y1 = nx0, ny0, nx1, ny1
                                changed = True
                            if is_caption:
                                # "Figure N." lines name the figure (findable for
                                # "show me figure N") and ALWAYS win; "Notes:" lines
                                # only fill an empty or garbled caption
                                new_cap = ob_text.strip()
                                cur = fig.get("caption", "")
                                new_is_fig = bool(re.match(r"^(Figure|Table|Exhibit)\s+\d", new_cap, re.I))
                                cur_is_fig = bool(re.match(r"^(Figure|Table|Exhibit)\s+\d", cur, re.I))
                                if new_is_fig or (not cur_is_fig and (not cur or _looks_garbled(cur))):
                                    fig["caption"] = new_cap
                                if ob[1] > (fig_top + fig_bot) / 2:
                                    floor = ob[3] + 1  # caption below the figure: hard bottom
                    if not changed:
                        break
                page = doc[pg - 1]
                sx = page.rect.width / (lw or page.rect.width)
                sy = page.rect.height / (lh or page.rect.height)
                clip = fitz.Rect(
                    max(0, x0 * sx - pad), max(0, y0 * sy - pad),
                    min(page.rect.width, x1 * sx + pad), min(page.rect.height, y1 * sy + pad),
                )
                try:
                    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
                    fig["base64"] = base64.b64encode(pix.tobytes("png")).decode("utf-8")
                    rerendered += 1
                except Exception as e:
                    logger.warning("Figure re-render failed on page %s: %s", pg, e)
        finally:
            doc.close()
        if rerendered:
            print(f"   Re-rendered {rerendered}/{len(figures)} figures from PDF regions")

    def _run_partition_job(self, filepath: Path) -> tuple[list[dict], list[dict]]:
        """Create one Unstructured job with partition + chunk_by_title nodes,
        poll until it finishes, and return (raw_elements, chunked_elements)."""
        partition_node = {
            "name": "Partitioner", "type": "partition", "subtype": "unstructured_api",
            "settings": {
                "strategy": "hi_res" if self.cfg["hi_res"] else "auto",
                "include_page_breaks": True,
                "infer_table_structure": True,
                "coordinates": True,
                "extract_image_block_types": [t.lower() for t in self.cfg["extract_image_block_types"]],
            },
        }
        chunk_node = {
            "name": "Chunker", "type": "chunk", "subtype": "chunk_by_title",
            "settings": {
                "max_characters": self.cfg["parent_max_characters"],
                "new_after_n_chars": self.cfg["parent_new_after"],
                "combine_text_under_n_chars": self.cfg["parent_combine_under"],
                "overlap": self.cfg["parent_overlap"],
                "include_orig_elements": True,
            },
        }
        content = filepath.read_bytes()
        ctype, _ = mimetypes.guess_type(str(filepath))
        # Bounded retries on 5xx (the SDK default backs off for a very long time):
        # 1s -> 10s intervals, give up after ~2 minutes with a clear error.
        from unstructured_client.utils import RetryConfig, BackoffStrategy
        retry = RetryConfig("backoff", BackoffStrategy(1000, 10000, 1.5, 120000), True)
        try:
            resp = self.client.jobs.create_job(request=operations.CreateJobRequest(
                body_create_job=shared.BodyCreateJob(
                    request_data=json.dumps({"job_nodes": [partition_node, chunk_node]}),
                    input_files=[shared.InputFiles(
                        content=content, file_name=filepath.name,
                        content_type=ctype or "application/octet-stream")],
                )), retries=retry)
        except Exception as e:
            raise RuntimeError(
                f"Unstructured could not create a job for {filepath.name} after ~2 minutes of retries "
                f"({str(e)[:120]}). Persistent 500s mean a service-side problem or an account/credit issue - "
                f"check https://status.unstructured.io and your Unstructured dashboard, then re-run."
            ) from e
        job = resp.job_information
        print(f"   Unstructured job {job.id} submitted, waiting...")
        t0 = time.time()
        while True:
            time.sleep(5)
            job = self.client.jobs.get_job(
                request=operations.GetJobRequest(job_id=job.id)).job_information
            status = str(job.status).rsplit(".", 1)[-1].upper()
            if status in ("COMPLETED", "FAILED", "STOPPED", "CANCELLED"):
                break
            if time.time() - t0 > self.cfg["api_timeout"]:
                raise TimeoutError(
                    f"Unstructured job {job.id} did not finish within {self.cfg['api_timeout']}s")
        if status != "COMPLETED":
            details = ""
            try:
                failed = self.client.jobs.get_job_failed_files(
                    request=operations.GetJobFailedFilesRequest(job_id=job.id))
                details = f" | failed files: {failed.job_failed_files}"
            except Exception:
                pass
            raise RuntimeError(f"Unstructured job {job.id} ended with status {status}{details}")
        print(f"   Job completed in {time.time() - t0:.0f}s")
        raw, chunked = [], []
        for nf in job.output_node_files or []:
            out = self.client.jobs.download_job_output(
                request=operations.DownloadJobOutputRequest(
                    job_id=job.id, file_id=nf.file_id, node_id=nf.node_id))
            data = out.any if isinstance(out.any, list) else []
            if nf.node_type == "partition":
                raw = data
            elif nf.node_type == "chunk":
                chunked = data
        return raw, chunked

    def _get_page_numbers(self, meta, orig):
        if meta.get("page_number"):
            return [meta["page_number"]]
        if orig:
            pages = set()
            for oe in orig:
                p = oe.get("metadata", {}).get("page_number")
                if p:
                    pages.add(p)
            return sorted(pages) if pages else []
        return []

    def _parse_orig_elements(self, meta):
        orig_raw = meta.get("orig_elements") or []
        if isinstance(orig_raw, str):
            # Either plain JSON or base64-encoded compressed JSON (jobs API)
            try:
                orig_raw = json.loads(orig_raw)
            except Exception:
                import gzip, zlib
                decoded = None
                for decompress in (zlib.decompress, gzip.decompress):
                    try:
                        decoded = json.loads(decompress(base64.b64decode(orig_raw)))
                        break
                    except Exception:
                        continue
                orig_raw = decoded if decoded is not None else []
        if isinstance(orig_raw, dict):
            orig_raw = orig_raw.get("elements", [])
        if not isinstance(orig_raw, list):
            orig_raw = []
        orig = []
        for oe in orig_raw:
            if isinstance(oe, dict):
                orig.append(oe)
            elif isinstance(oe, str):
                try:
                    parsed = json.loads(oe)
                    if isinstance(parsed, dict):
                        orig.append(parsed)
                except Exception:
                    pass
            elif hasattr(oe, "type"):
                d = {"type": getattr(oe, "type", ""), "text": getattr(oe, "text", "")}
                oe_meta = getattr(oe, "metadata", None)
                if oe_meta:
                    if isinstance(oe_meta, dict):
                        d["metadata"] = oe_meta
                    else:
                        d["metadata"] = {
                            k: v for k, v in vars(oe_meta).items()
                            if not k.startswith("_") and v is not None
                        }
                else:
                    d["metadata"] = {}
                orig.append(d)
        return orig

    def _build_text_chunks(self, elements, filename, page_sections=None):
        ps = page_sections or {}
        chunks = []
        for idx, elem in enumerate(elements):
            et = elem.get("type", "UncategorizedText")
            txt = elem.get("text", "")
            meta = elem.get("metadata", {})
            orig = self._parse_orig_elements(meta)
            pn = self._get_page_numbers(meta, orig)
            hierarchy, breadcrumb = [], ""
            for pg in pn:
                if pg in ps:
                    hierarchy, breadcrumb = ps[pg]
                    break
            thtml = meta.get("text_as_html")
            if not thtml and orig:
                for oe in orig:
                    h = oe.get("metadata", {}).get("text_as_html")
                    if h:
                        thtml = h; break
            chunks.append(StructChunk(
                chunk_id=_mkid("s", txt, idx), content=txt,
                chunk_type=ChunkType.TEXT, element_types=[et], page_numbers=pn,
                section_hierarchy=list(hierarchy), context_breadcrumb=breadcrumb,
                char_count=len(txt), table_html=thtml,
                table_data=_parse_table_html(thtml) if thtml else None,
                table_markdown=_html_table_to_markdown(thtml) if thtml else None,
                metadata=ChunkMeta(
                    element_id=elem.get("element_id", ""), element_types=[et],
                    page_numbers=pn, filename=meta.get("filename", filename),
                    filetype=meta.get("filetype", ""), languages=meta.get("languages", []),
                    coordinates=meta.get("coordinates"), text_as_html=thtml,
                    link_urls=meta.get("link_urls", []),
                    is_continuation=meta.get("is_continuation", False),
                    orig_elements_count=len(orig) if orig else 1,
                ),
            ))
        return chunks


# ═════════════════════════════════════════════════════════════════
# PARENT-CHILD SPLITTER
# ═════════════════════════════════════════════════════════════════

class ParentChildSplitter:
    """Splits structural chunks into large parents (context units, ~3000 chars)
    and small children (retrieval units, ~500 chars, sentence-aligned)."""
    def __init__(self, config):
        self.cfg = config

    def split(self, structural, source_url=None):
        parents, children = [], []
        for i, sc in enumerate(structural):
            p = ParentChunk(
                parent_id=_mkid("p", sc.content, i), content=sc.content,
                chunk_type=sc.chunk_type, section_hierarchy=sc.section_hierarchy,
                context_breadcrumb=sc.context_breadcrumb, page_numbers=sc.page_numbers,
                child_ids=[], char_count=len(sc.content), token_estimate=_est_tok(sc.content),
                table_html=sc.table_html, table_markdown=sc.table_markdown,
                figure_caption=sc.figure_caption, figure_base64=sc.figure_base64,
                source_url=source_url,
            )
            if sc.chunk_type in (ChunkType.TABLE, ChunkType.FIGURE):
                c = self._mkc(p, sc.content, 0, sc, source_url)
                p.child_ids.append(c.child_id); children.append(c)
            else:
                for ci, ct in enumerate(self._split_text(
                        sc.content, self.cfg["child_max_characters"],
                        self.cfg["child_overlap"], self.cfg["child_min_characters"])):
                    c = self._mkc(p, ct, ci, sc, source_url)
                    p.child_ids.append(c.child_id); children.append(c)
            parents.append(p)
        return parents, children

    def _mkc(self, parent, content, pos, sc, url):
        return ChildChunk(
            child_id=_mkid("c", content, pos), parent_id=parent.parent_id,
            content=content, chunk_type=sc.chunk_type, position_in_parent=pos,
            context_breadcrumb=sc.context_breadcrumb, section_hierarchy=sc.section_hierarchy,
            page_numbers=sc.page_numbers, char_count=len(content), token_estimate=_est_tok(content),
            content_hash=hashlib.sha256(content.encode()).hexdigest()[:16],
            table_html=sc.table_html if sc.chunk_type == ChunkType.TABLE else None,
            table_markdown=sc.table_markdown if sc.chunk_type == ChunkType.TABLE else None,
            table_data=sc.table_data if sc.chunk_type == ChunkType.TABLE else None,
            figure_caption=sc.figure_caption if sc.chunk_type == ChunkType.FIGURE else None,
            figure_base64=sc.figure_base64 if sc.chunk_type in (ChunkType.FIGURE, ChunkType.MIXED) else None,
            source_url=url,
        )

    def _split_text(self, text, mx, ov, mn):
        if len(text) <= mx:
            return [text]
        sents = self._sentsplit(text)
        if not sents:
            return [text]
        chunks, cur, cl = [], [], 0
        for s in sents:
            if cl + len(s) > mx and cur:
                chunks.append(" ".join(cur))
                ovs, ovt = [], ""
                for x in reversed(cur):
                    if len(ovt) + len(x) > ov:
                        break
                    ovs.insert(0, x); ovt = " ".join(ovs)
                cur, cl = ovs, len(ovt)
            cur.append(s); cl += len(s) + 1
        if cur:
            t = " ".join(cur)
            if len(t) < mn and chunks:
                chunks[-1] += " " + t
            else:
                chunks.append(t)
        return chunks

    @staticmethod
    def _sentsplit(text):
        text = re.sub(r"(\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.) ", r"\1<P> ", text)
        text = re.sub(r"(\b[A-Z]\.) ", r"\1<P> ", text)
        text = re.sub(r"(\b(?:e\.g|i\.e|al|fig|eq|no|vol))\. ", r"\1.<P> ", text)
        return [
            p.replace("<P> ", ". ").replace("<P>", ".").strip()
            for p in re.split(r"(?<=[.!?])\s+", text) if p.strip()
        ]


# ═════════════════════════════════════════════════════════════════
# ANTHROPIC LLM
# ═════════════════════════════════════════════════════════════════

class AnthropicLLM:
    """Thin Claude client: rate limiting, retries, adaptive thinking, effort,
    structured JSON output, and token accounting for the pipeline."""
    def __init__(self, api_key, model, config):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model; self.cfg = config
        self.total_tokens = 0; self.total_calls = 0
        self.last_stop_reason = None; self.last_block_types = []; self.last_raw = ""
        self.last_refusal_category = None
        self._last = 0.0
        self._interval = 60.0 / max(config["llm_requests_per_minute"], 1)

    def complete(self, prompt, system="", max_tokens=None, schema=None):
        self._rl()
        mt = max_tokens or self.cfg["llm_max_tokens"]
        for att in range(self.cfg["llm_retry_attempts"]):
            try:
                kw = {
                    "model": self.model, "max_tokens": mt,
                    "thinking": _thinking_param(self.cfg.get("llm_thinking", "adaptive")),
                    "messages": [{"role": "user", "content": prompt}],
                }
                if system:
                    kw["system"] = system
                # extra_body carries output_config so it works on SDK versions
                # predating the output_config kwarg
                extra = {}
                effort = self.cfg.get("llm_effort", "high")
                if effort != "high":
                    extra.setdefault("output_config", {})["effort"] = effort
                if schema and self.cfg.get("llm_structured_output", True):
                    extra.setdefault("output_config", {})["format"] = {"type": "json_schema", "schema": schema}
                if extra:
                    kw["extra_body"] = extra
                r = self.client.messages.create(**kw)
                if r.usage:
                    self.total_tokens += r.usage.input_tokens + r.usage.output_tokens
                self.total_calls += 1
                if getattr(r, "stop_reason", "") == "max_tokens":
                    logger.warning("LLM response truncated at max_tokens=%d - raise llm_max_tokens "
                                   "(enrichment) or proposition_max_tokens (propositions)", mt)
                text = "".join(b.text for b in r.content if b.type == "text") if r.content else ""
                self.last_stop_reason = getattr(r, "stop_reason", None)
                self.last_block_types = [b.type for b in (r.content or [])]
                self.last_raw = text
                self.last_refusal_category = None
                if self.last_stop_reason == "refusal":
                    det = getattr(r, "stop_details", None)
                    if det is None and hasattr(r, "model_extra"):
                        det = (r.model_extra or {}).get("stop_details")
                    if isinstance(det, dict):
                        self.last_refusal_category = det.get("category")
                    else:
                        self.last_refusal_category = getattr(det, "category", None)
                    logger.warning("LLM refused the request (safety category=%s)", self.last_refusal_category)
                return text
            except Exception as e:
                logger.warning("LLM %d/%d: %s", att + 1, self.cfg["llm_retry_attempts"], e)
                if att < self.cfg["llm_retry_attempts"] - 1:
                    time.sleep(2 * (att + 1))
                else:
                    raise
        return ""

    def complete_json(self, prompt, system="", max_tokens=None, schema=None):
        """JSON completion. With `schema` (a JSON Schema object), the API's
        structured-output mode guarantees schema-valid JSON; without it, the
        response is parsed leniently (fenced/truncated JSON salvage)."""
        raw = self.complete(prompt, system, max_tokens, schema=schema)
        return self._pj(raw)

    def _rl(self):
        e = time.time() - self._last
        if e < self._interval:
            time.sleep(self._interval - e)
        self._last = time.time()

    @staticmethod
    def _pj(text):
        text = text.strip()
        if text.startswith("```"):
            ls = text.split("\n")
            if ls[0].startswith("```"):
                ls = ls[1:]
            if ls and ls[-1].strip() == "```":
                ls = ls[:-1]
            text = "\n".join(ls).strip()
        try:
            return json.loads(text)
        except Exception:
            for sc, ec in [("{", "}"), ("[", "]")]:
                s, e = text.find(sc), text.rfind(ec)
                if s != -1 and e > s:
                    try:
                        return json.loads(text[s:e + 1])
                    except Exception:
                        continue
            # Truncated array (max_tokens hit mid-output): keep the complete items
            s = text.find("[")
            if s != -1:
                body = text[s:]
                while True:
                    e = body.rfind("}")
                    if e == -1:
                        break
                    try:
                        items = json.loads(body[:e + 1] + "]")
                        if isinstance(items, list) and items:
                            logger.warning("Salvaged %d complete item(s) from truncated JSON", len(items))
                            return items
                    except Exception:
                        pass
                    body = body[:e]
            return {}


# ═════════════════════════════════════════════════════════════════
# CHUNK ENRICHER
# ═════════════════════════════════════════════════════════════════

_ENR_SYS = ("You are a document analysis assistant for a knowledge base of peer-reviewed academic papers, "
            "talks and CVs in marketing, operations and information systems. "
            "Generate structured metadata for search. Valid JSON only.")
_ENR_P = """Analyze these chunks:
{chunks_xml}
Respond ONLY with JSON: {{"items": [{{"chunk_index":0, "summary":"1-2 sentences.", "description":"Meta-level (1 sentence).",
"hypothetical_questions":["Question this answers?"]}}]}} - one item per chunk."""

# JSON Schemas for structured outputs (guarantee valid, complete JSON)
_ENR_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "chunk_index": {"type": "integer"},
            "summary": {"type": "string"},
            "description": {"type": "string"},
            "hypothetical_questions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["chunk_index", "summary", "description", "hypothetical_questions"],
        "additionalProperties": False,
    }}},
    "required": ["items"], "additionalProperties": False,
}
_PR_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "chunk_index": {"type": "integer"},
            "propositions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["chunk_index", "propositions"],
        "additionalProperties": False,
    }}},
    "required": ["items"], "additionalProperties": False,
}


def _items(r):
    """Unwrap {'items': [...]} (structured output) or accept a bare list (legacy)."""
    if isinstance(r, dict):
        r = r.get("items", [])
    return r if isinstance(r, list) else []


class ChunkEnricher:
    """Adds search metadata to children: KeyBERT keywords plus LLM-written
    summaries, descriptions, and hypothetical questions (batched calls)."""
    def __init__(self, llm, config):
        self.llm = llm; self.cfg = config

    def enrich(self, children):
        for c in children:
            c.keywords = extract_keywords(c.content, self.cfg["keyword_top_n"], self.cfg)
        bs = self.cfg["enrichment_batch_size"]
        for bi, batch in enumerate([children[i:i + bs] for i in range(0, len(children), bs)]):
            try:
                self._batch(batch)
            except Exception as e:
                logger.error("Enrich batch %d: %s", bi, e)
                for c in batch:
                    self._fb(c)
        return children

    def _batch(self, batch):
        """Enrich a batch; chunks the LLM skipped get one targeted retry before
        falling back to heuristic summaries."""
        self._call(batch)
        missing = [c for c in batch if not c.summary]
        if missing and self.llm.last_stop_reason == "refusal" and len(batch) > 1:
            # One chunk tripped the safety classifier; process the rest individually
            logger.warning("Batch refused - retrying %d chunk(s) one at a time", len(missing))
            for c in missing:
                self._call([c])
                if self.llm.last_stop_reason == "refusal":
                    # refusals on legitimate text are stochastic - one more try
                    self._call([c])
                if self.llm.last_stop_reason == "refusal":
                    logger.warning("Chunk %s refused twice (category=%s) - heuristic fallback. Content: %r",
                                   c.child_id, self.llm.last_refusal_category, c.content[:120])
        elif missing:
            logger.warning("Retrying enrichment for %d chunk(s) the LLM did not cover", len(missing))
            self._call(missing)
        for c in batch:
            if not c.summary:
                self._fb(c)

    def _call(self, batch):
        trunc = self.cfg.get("llm_content_truncation", 2000)
        xml = "\n".join(
            f'<chunk index="{i}">\nSection: {c.context_breadcrumb}\n'
            f'Keywords: {", ".join(c.keywords[:5])}\nContent:\n{c.content[:trunc]}\n</chunk>'
            for i, c in enumerate(batch)
        )
        r = _items(self.llm.complete_json(_ENR_P.format(chunks_xml=xml), system=_ENR_SYS, schema=_ENR_SCHEMA))
        if not r:
            logger.warning("Enrichment batch returned no items for %d chunk(s) - will retry "
                           "[stop_reason=%s blocks=%s raw=%r]", len(batch), self.llm.last_stop_reason,
                           self.llm.last_block_types, (self.llm.last_raw or "")[:200])
        if isinstance(r, list):
            for it in r:
                ix = it.get("chunk_index", -1)
                if 0 <= ix < len(batch):
                    batch[ix].summary = it.get("summary", "")
                    if not batch[ix].description:  # keep vision descriptions on figure/table chunks
                        batch[ix].description = it.get("description", "")
                    batch[ix].hypothetical_questions = it.get("hypothetical_questions", [])

    @staticmethod
    def _fb(c):
        if not c.summary:
            ss = c.content.replace("\n", " ").split(".")
            c.summary = (ss[0].strip() + ".") if ss[0].strip() else ""
        if not c.description:
            c.description = f"{c.chunk_type} from: {c.context_breadcrumb}"


# ═════════════════════════════════════════════════════════════════
# PROPOSITION DECOMPOSER
# ═════════════════════════════════════════════════════════════════

_PR_SYS = ("Decompose academic text (peer-reviewed papers, talks and CVs in marketing, operations and "
           "information systems) into atomic propositions. Single fact, no unresolved pronouns, self-contained. JSON only.")
_PR_P = """Decompose each chunk:
{chunks_xml}
Rules: resolve pronouns, stand-alone facts, 3-15 per chunk, no hallucination.
Respond ONLY with JSON: {{"items": [{{"chunk_index":0,"propositions":["..."]}}]}} - one item per chunk."""


class PropositionDecomposer:
    """Decomposes children into atomic, self-contained facts (Dense X
    Retrieval) that form the propositions namespace."""
    def __init__(self, llm, config):
        self.llm = llm; self.cfg = config

    def decompose(self, children, source_url=None):
        if not self.cfg["enable_propositions"]:
            return []
        bs = self.cfg["proposition_batch_size"]
        props = []
        for bi, batch in enumerate([children[i:i + bs] for i in range(0, len(children), bs)]):
            try:
                props.extend(self._batch(batch, source_url))
            except Exception as e:
                logger.error("Prop batch %d: %s", bi, e)
        return props

    def _batch(self, batch, url):
        """Decompose a batch; chunks that got no propositions get one targeted retry."""
        out = self._call(batch, url)
        covered = {p.source_child_id for p in out}
        missing = [c for c in batch if c.child_id not in covered and c.content.strip()]
        if missing and self.llm.last_stop_reason == "refusal" and len(batch) > 1:
            logger.warning("Batch refused - retrying %d chunk(s) one at a time", len(missing))
            for c in missing:
                out.extend(self._call([c], url))
                if self.llm.last_stop_reason == "refusal":
                    out.extend(self._call([c], url))
                if self.llm.last_stop_reason == "refusal":
                    logger.warning("Chunk %s refused twice (category=%s) - no propositions. Content: %r",
                                   c.child_id, self.llm.last_refusal_category, c.content[:120])
        elif missing:
            logger.warning("Retrying propositions for %d chunk(s) the LLM did not cover", len(missing))
            out.extend(self._call(missing, url))
        return out

    def _call(self, batch, url):
        trunc = self.cfg.get("llm_content_truncation", 2000)
        xml = "\n".join(
            f'<chunk index="{i}">\nSection: {c.context_breadcrumb}\n{c.content[:trunc]}\n</chunk>'
            for i, c in enumerate(batch)
        )
        r = _items(self.llm.complete_json(
            _PR_P.format(chunks_xml=xml), system=_PR_SYS,
            max_tokens=self.cfg.get("proposition_max_tokens", 16000), schema=_PR_SCHEMA,
        ))
        out = []
        if not r:
            logger.warning("Proposition batch returned no items for %d chunk(s) - will retry "
                           "[stop_reason=%s blocks=%s raw=%r]", len(batch), self.llm.last_stop_reason,
                           self.llm.last_block_types, (self.llm.last_raw or "")[:200])
        if isinstance(r, list):
            for it in r:
                ix = it.get("chunk_index", -1)
                if 0 <= ix < len(batch):
                    ch = batch[ix]
                    for pi, t in enumerate(it.get("propositions", [])):
                        if isinstance(t, str) and t.strip():
                            out.append(Proposition(
                                proposition_id=_mkid("pr", t, pi), proposition=t.strip(),
                                source_child_id=ch.child_id, source_parent_id=ch.parent_id,
                                source_content=ch.content[:500], context_breadcrumb=ch.context_breadcrumb,
                                section_hierarchy=ch.section_hierarchy, page_numbers=ch.page_numbers,
                                keywords=extract_keywords(t, 5, self.cfg), token_estimate=_est_tok(t),
                                source_url=url,
                                source_name=getattr(ch, "source_name", ""),
                                source_description=getattr(ch, "source_description", ""),
                            ))
        return out


# ═════════════════════════════════════════════════════════════════
# PINECONE INDEXER + RETRIEVER
# ═════════════════════════════════════════════════════════════════

class PineconeIndexer:
    """Indexes into Pinecone with llama-text-embed-v2 integrated inference.
    3 namespaces: children, parents, propositions."""

    def __init__(self, api_key, index_host, config):
        self.index = Pinecone(api_key=api_key).Index(host=index_host)
        self.cfg = config

    def upsert_result(self, result: PipelineResult, batch_size=50):
        stats = {"children": 0, "parents": 0, "propositions": 0}
        # Children
        recs = []
        for c in result.child_chunks:
            recs.append({
                "id": _rid(c.source_name, c.child_id),
                "text": (
                    f"Source: {c.source_description}\nSection: {c.context_breadcrumb}\n"
                    f"Keywords: {', '.join(c.keywords)}\nSummary: {c.summary}\n"
                    f"{c.description or ''}\n{c.content}"
                ),
                "parent_id": _rid(c.source_name, c.parent_id), "chunk_type": c.chunk_type,
                "context_breadcrumb": c.context_breadcrumb,
                "keywords": json.dumps(c.keywords), "summary": c.summary,
                "description": c.description,
                "questions": json.dumps(c.hypothetical_questions),
                "page_numbers": json.dumps(c.page_numbers),
                "source_name": c.source_name, "source_description": c.source_description,
                "image_url": c.image_url or "", "order": c.order,
                "source_url": c.source_url or "", "figure_caption": c.figure_caption or "",
                "table_markdown": c.table_markdown or "",
            })
        for i in range(0, len(recs), batch_size):
            self.index.upsert_records(namespace=self.cfg["pinecone_ns_children"], records=recs[i:i + batch_size])
            stats["children"] += len(recs[i:i + batch_size])
        # Parents
        recs = []
        for p in result.parent_chunks:
            recs.append({
                "id": _rid(p.source_name, p.parent_id), "text": p.content,
                "chunk_type": p.chunk_type, "context_breadcrumb": p.context_breadcrumb,
                "child_ids": json.dumps([_rid(p.source_name, cid) for cid in p.child_ids]),
                "page_numbers": json.dumps(p.page_numbers),
                "source_url": p.source_url or "", "content": p.content,
                "source_name": p.source_name, "source_description": p.source_description,
                "table_markdown": getattr(p, "table_markdown", "") or "",
            })
        for i in range(0, len(recs), batch_size):
            self.index.upsert_records(namespace=self.cfg["pinecone_ns_parents"], records=recs[i:i + batch_size])
            stats["parents"] += len(recs[i:i + batch_size])
        # Propositions
        if result.propositions:
            recs = []
            for pr in result.propositions:
                recs.append({
                    "id": _rid(pr.source_name, pr.proposition_id), "text": pr.proposition,
                    "source_child_id": _rid(pr.source_name, pr.source_child_id),
                    "source_parent_id": _rid(pr.source_name, pr.source_parent_id),
                    "context_breadcrumb": pr.context_breadcrumb,
                    "page_numbers": json.dumps(pr.page_numbers),
                    "keywords": json.dumps(pr.keywords),
                    "source_url": pr.source_url or "", "content": pr.proposition,
                    "source_name": pr.source_name, "source_description": pr.source_description,
                })
            for i in range(0, len(recs), batch_size):
                self.index.upsert_records(namespace=self.cfg["pinecone_ns_propositions"], records=recs[i:i + batch_size])
                stats["propositions"] += len(recs[i:i + batch_size])
        return stats

    def retrieve(self, query, result, top_k=5, child_k=10, prop_k=10, use_propositions=True):
        pl = result.parent_lookup
        cl = {c.child_id: c for c in result.child_chunks}
        ch = self.index.search(
            namespace=self.cfg["pinecone_ns_children"],
            query={"top_k": child_k, "inputs": {"text": query}},
            fields=["parent_id", "chunk_type", "context_breadcrumb", "keywords", "summary", "page_numbers", "source_url", "content"],
        )
        hits = getattr(getattr(ch, "result", None), "hits", []) or []
        scores = {}
        for h in hits:
            hid = getattr(h, "_id", None) or getattr(h, "id", "")
            hsc = getattr(h, "_score", None) or getattr(h, "score", 0.0)
            scores[_plain_id(hid)] = hsc
        pbc = {}
        if use_propositions and result.propositions:
            ph = self.index.search(
                namespace=self.cfg["pinecone_ns_propositions"],
                query={"top_k": prop_k, "inputs": {"text": query}},
                fields=["source_child_id", "content"],
            )
            phits = getattr(getattr(ph, "result", None), "hits", []) or []
            for h in phits:
                hsc = getattr(h, "_score", None) or getattr(h, "score", 0.0)
                flds = getattr(h, "fields", {}) or {}
                cid = flds.get("source_child_id", "") if isinstance(flds, dict) else getattr(flds, "source_child_id", "")
                cid = _plain_id(cid)
                pcontent = flds.get("content", "") if isinstance(flds, dict) else getattr(flds, "content", "")
                if cid:
                    pbc.setdefault(cid, []).append(pcontent)
                    scores[cid] = scores.get(cid, 0.0) + hsc * 0.5
        seen, results = set(), []
        for cid, sc in sorted(scores.items(), key=lambda x: x[1], reverse=True):
            child = cl.get(cid)
            if not child or child.parent_id in seen:
                continue
            seen.add(child.parent_id)
            parent = pl.get(child.parent_id)
            results.append(RetrievalHit(
                child_id=child.child_id, parent_id=child.parent_id,
                child_content=child.content,
                parent_content=parent.content if parent else child.content,
                score=sc, chunk_type=child.chunk_type,
                context_breadcrumb=child.context_breadcrumb,
                page_numbers=child.page_numbers, keywords=child.keywords,
                summary=child.summary, matched_propositions=pbc.get(cid, []),
                source_url=child.source_url,
            ))
            if len(results) >= top_k:
                break
        return RetrievalResponse(
            query=query, results=results,
            total_context_tokens=int(sum(len(r.parent_content.split()) for r in results) * 1.3),
        )


# ═════════════════════════════════════════════════════════════════
# SFTP UPLOAD
# ═════════════════════════════════════════════════════════════════

def _sftp_mkdir_p(sftp, remote_dir):
    parts = remote_dir.strip("/").split("/")
    cur = ""
    for p in parts:
        cur = p if not cur else cur + "/" + p
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def upload_asset(local_path, remote_subdir, pcfg: PipelineConfig) -> str:
    """Upload one file with the configured provider; returns its public URL."""
    provider = (pcfg.upload_provider or "sftp").lower()
    if provider == "cloudinary":
        return _upload_to_cloudinary(local_path, remote_subdir, pcfg)
    return upload_to_sftp(local_path, remote_subdir, pcfg)


def batch_upload_assets(local_paths, remote_subdir, pcfg: PipelineConfig) -> dict:
    """Upload many files; returns {page_number: url} like batch_upload_to_sftp."""
    provider = (pcfg.upload_provider or "sftp").lower()
    if provider == "cloudinary":
        uploads = {}
        for p in sorted(local_paths):
            p = Path(p)
            url = upload_asset(str(p), remote_subdir, pcfg)
            try:
                page_num = int(p.stem.split("slide-")[1])
            except (IndexError, ValueError):
                page_num = 0
            uploads[page_num] = url
            print(f"  Uploaded: {p.name}")
        return uploads
    return batch_upload_to_sftp(local_paths, remote_subdir, pcfg)


_cloudinary_ready = False

def _upload_to_cloudinary(local_path, remote_subdir, pcfg: PipelineConfig) -> str:
    global _cloudinary_ready
    try:
        import cloudinary, cloudinary.uploader
    except ImportError:
        raise RuntimeError("upload_provider='cloudinary' needs: pip install cloudinary")
    if not _cloudinary_ready:
        url = pcfg.cloudinary_url or os.environ.get("CLOUDINARY_URL", "")
        if url:
            # the SDK only reads CLOUDINARY_URL at import time - configure explicitly
            parsed = urllib.parse.urlparse(url.split("=", 1)[-1] if url.startswith("CLOUDINARY_URL=") else url)
            cloudinary.config(cloud_name=parsed.hostname, api_key=parsed.username,
                              api_secret=parsed.password, secure=True)
        else:
            cloudinary.config(secure=True)
        if not cloudinary.config().cloud_name:
            raise RuntimeError("Cloudinary not configured - set cloudinary_url or the CLOUDINARY_URL env var")
        _cloudinary_ready = True
    local = Path(local_path)
    resource_type = "image" if local.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp") else "raw"
    res = cloudinary.uploader.upload(
        str(local), public_id=local.stem, folder=remote_subdir,
        resource_type=resource_type, overwrite=True)
    # strip the /v<version>/ component: the version-less URL always serves the
    # latest upload, so records stay valid when an image is re-processed
    url = re.sub(r"/v\d+/", "/", res["secure_url"])
    print(f"  Cloudinary: {local.name} -> {url}")
    return url


def upload_to_sftp(local_path, remote_subdir, pcfg: PipelineConfig):
    """Upload one file to the configured SFTP server; returns its public URL."""
    import paramiko, posixpath
    local = Path(local_path)
    if not local.exists():
        print(f"  SFTP: Local file not found: {local}")
        return ""
    print(f"  SFTP: Connecting to {pcfg.sftp_host}:{pcfg.sftp_port}...")
    transport = paramiko.Transport((pcfg.sftp_host, pcfg.sftp_port))
    transport.connect(username=pcfg.sftp_user, password=pcfg.sftp_pass)
    sftp = paramiko.SFTPClient.from_transport(transport)
    _sftp_mkdir_p(sftp, remote_subdir)
    remote_path = posixpath.join(remote_subdir, local.name)
    print(f"  SFTP: PUT {local.name} -> {remote_path}")
    sftp.put(str(local), remote_path)
    try:
        stat = sftp.stat(remote_path)
        print(f"  SFTP: Verified on server ({stat.st_size} bytes)")
    except Exception as e:
        print(f"  SFTP: Verification failed: {e}")
    sftp.close(); transport.close()
    return f"{pcfg.public_base}/{remote_subdir}/{local.name}"


def batch_upload_to_sftp(local_paths, remote_subdir, pcfg: PipelineConfig):
    """Upload many files over one SFTP connection; returns {page_number: url}."""
    import paramiko, posixpath
    transport = paramiko.Transport((pcfg.sftp_host, pcfg.sftp_port))
    transport.connect(username=pcfg.sftp_user, password=pcfg.sftp_pass)
    sftp = paramiko.SFTPClient.from_transport(transport)
    _sftp_mkdir_p(sftp, remote_subdir)
    uploads = {}
    for p in sorted(local_paths):
        p = Path(p)
        remote_path = posixpath.join(remote_subdir, p.name)
        sftp.put(str(p), remote_path)
        url = f"{pcfg.public_base}/{remote_subdir}/{p.name}"
        try:
            page_num = int(p.stem.split("slide-")[1])
        except (IndexError, ValueError):
            page_num = 0
        uploads[page_num] = url
        print(f"  Uploaded: {p.name}")
    sftp.close(); transport.close()
    return uploads


# ═════════════════════════════════════════════════════════════════
# SLIDE RENDERING
# ═════════════════════════════════════════════════════════════════

def render_slides_to_png(pdf_path, output_dir, prefix, zoom=2.0):
    """Render every PDF page to a PNG (used for presentation slide decks)."""
    import fitz
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    paths = []
    for i in range(len(doc)):
        pix = doc[i].get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        p = out / f"{prefix}_slide-{i + 1:03d}.png"
        pix.save(str(p))
        paths.append(str(p))
    print(f"Rendered {len(paths)} slide PNGs")
    return paths


def extract_slides_from_pages(pdf_path, output_dir, prefix, zoom=2.0):
    """Extract embedded slide images directly from PDF pages."""
    import fitz
    from PIL import Image
    import io
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    page_to_slide = {}
    last_slide_path = None
    for i in range(len(doc)):
        page = doc[i]
        images = page.get_images(full=True)
        slide_path = out / f"{prefix}_slide-{i + 1:03d}.png"
        found = False
        if images:
            best_img, best_size = None, 0
            for img_info in images:
                xref = img_info[0]
                try:
                    extracted = doc.extract_image(xref)
                    img_size = extracted["width"] * extracted["height"]
                    if img_size > best_size:
                        best_size = img_size
                        best_img = extracted
                except Exception:
                    continue
            if best_img:
                pil_img = Image.open(io.BytesIO(best_img["image"]))
                pil_img.save(str(slide_path), format="PNG")
                last_slide_path = str(slide_path)
                page_to_slide[i + 1] = last_slide_path
                print(f"  Page {i + 1}: extracted slide ({best_img['width']}x{best_img['height']})")
                found = True
        if not found:
            if last_slide_path:
                page_to_slide[i + 1] = last_slide_path
                print(f"  Page {i + 1}: text continuation (inherits previous slide)")
            else:
                print(f"  Page {i + 1}: no slide available")
    unique_slides = len(set(page_to_slide.values()))
    print(f"Mapped {len(page_to_slide)} pages to {unique_slides} unique slides")
    return page_to_slide


# ═════════════════════════════════════════════════════════════════
# VISION (Claude by default; GPT optional via PipelineConfig.vision_model)
# ═════════════════════════════════════════════════════════════════

_vision_client = None
_openai_client = None


def _gpt_effort(cfg: dict) -> str:
    """vision_effort mapped onto OpenAI's reasoning levels (no xhigh/max there)."""
    e = cfg.get("vision_effort", "high")
    return e if e in ("low", "medium", "high") else "high"


def _vision_is_openai(pcfg: PipelineConfig) -> bool:
    """A gpt-* vision_model routes vision calls to OpenAI; anything else to Anthropic."""
    return pcfg.vision_model.lower().startswith("gpt")


def _get_vision_client(pcfg: PipelineConfig):
    global _vision_client
    if _vision_client is None:
        _vision_client = anthropic.Anthropic(api_key=pcfg.anthropic_api_key)
    return _vision_client


def _get_openai_client(pcfg: PipelineConfig):
    global _openai_client
    if _openai_client is None:
        if not pcfg.openai_api_key:
            raise RuntimeError("vision_model is a GPT model but openai_api_key is not set")
        from openai import OpenAI
        _openai_client = OpenAI(api_key=pcfg.openai_api_key)
    return _openai_client


def _data_url(image_path) -> str:
    img_bytes = Path(image_path).read_bytes()
    mime = "image/jpeg" if img_bytes[:2] == b"\xff\xd8" else "image/png"
    return f"data:{mime};base64,{base64.b64encode(img_bytes).decode('utf-8')}"


def _image_block(img_bytes: bytes) -> dict:
    """Build an Anthropic image content block, downscaling oversized images
    to stay under the API's 5MB per-image limit."""
    mime = "image/jpeg" if img_bytes[:2] == b"\xff\xd8" else "image/png"
    if len(img_bytes) > 4_500_000:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(img_bytes))
        img.thumbnail((4096, 4096))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=85)
        img_bytes = buf.getvalue()
        mime = "image/jpeg"
    return {"type": "image", "source": {
        "type": "base64", "media_type": mime,
        "data": base64.standard_b64encode(img_bytes).decode("utf-8"),
    }}


def _vision_text(response) -> str:
    return "".join(b.text for b in response.content if b.type == "text").strip()


def _is_degenerate(text: str) -> bool:
    """Empty, too short, or mostly non-ASCII (wrong script) output."""
    t = (text or "").strip()
    if len(t) < 20:
        return True
    return sum(1 for ch in t if ord(ch) > 127) / len(t) > 0.3


def _claude_vision(pcfg: PipelineConfig, cfg: dict, system: str, content, max_tokens: int) -> str:
    """Claude call for vision tasks. With adaptive thinking the reasoning can
    use up max_tokens before any text is written, or leave a truncated/odd
    fragment; if the answer is truncated or degenerate, retry once with
    thinking disabled."""
    client = _get_vision_client(pcfg)
    system = system + " Respond in English."
    text = ""
    # thinking-off responses on Opus 5 can leak role tags / ellipsis prefixes,
    # so retry with a fresh adaptive sample first and sanitize whatever we return
    def _sanitize(t):
        t = re.sub(r"^[\s.:,;\u2026]+", "", t or "")
        t = re.sub(r"^(assistant|Assistant)\b[\s.:,]*", "", t)
        return t.strip()
    effort = cfg.get("vision_effort", "high")
    for mode in (cfg.get("vision_thinking", "adaptive"), cfg.get("vision_thinking", "adaptive"), "disabled"):
        kw = {}
        if effort != "high" and mode != "disabled":
            kw["extra_body"] = {"output_config": {"effort": effort}}
        r = client.messages.create(
            model=pcfg.vision_model, max_tokens=max_tokens,
            thinking=_thinking_param(mode), system=system,
            messages=[{"role": "user", "content": content}], **kw,
        )
        text = _sanitize(_vision_text(r))
        stop = getattr(r, "stop_reason", "")
        if stop != "max_tokens" and not _is_degenerate(text):
            return text
        logger.warning("Vision response %s (stop_reason=%s, %d chars) - retrying",
                       "truncated" if stop == "max_tokens" else "degenerate", stop, len(text))
    return text


_DESCRIBE_SYS = (
    "You describe academic figures, charts, tables, and slides concisely (2-4 sentences). "
    "Focus on what the image shows, data trends, labels, and key takeaways. "
    "This description will be used for semantic search indexing."
)


def describe_image(image_path, context_text="", *, pcfg: PipelineConfig, cfg: dict):
    """Vision description of a figure/slide image (2-4 sentences, for search
    indexing). Uses Claude or GPT depending on PipelineConfig.vision_model."""
    prompt = f"Describe this image.\n\nContext from the document:\n{context_text}" if context_text else "Describe this image."
    mt = cfg.get("vision_max_tokens_describe", 4000)
    if _vision_is_openai(pcfg):
        response = _get_openai_client(pcfg).responses.create(
            model=pcfg.vision_model,
            reasoning={"effort": _gpt_effort(cfg)},
            instructions=_DESCRIBE_SYS,
            input=[{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": _data_url(image_path)},
            ]}],
            max_output_tokens=mt,
        )
        return response.output_text.strip()
    return _claude_vision(pcfg, cfg, _DESCRIBE_SYS, [
        _image_block(Path(image_path).read_bytes()),
        {"type": "text", "text": prompt},
    ], mt)


_TABLE_SYS = (
    "You convert tables from images into well-structured markdown tables. "
    "Rules:\n"
    "- Output ONLY the markdown table, no explanation or commentary\n"
    "- Preserve all data values exactly as shown\n"
    "- Use proper markdown table syntax with | and ---\n"
    "- For merged/spanning headers, repeat the header text in each column it spans\n"
    "- If the table is rotated/sideways, read it in the correct orientation\n"
    "- Use --- for empty cells\n"
    "- Preserve superscript markers (a, b, c, d) as-is"
)


def table_image_to_markdown(image_path, context_text="", html_fallback="", *, pcfg: PipelineConfig, cfg: dict):
    """Vision transcription of a table image into markdown; falls back to the
    parser's HTML-derived markdown when the model output is unusable."""
    prompt = "Convert this table to markdown format."
    if context_text:
        prompt += f" Context from the document: {context_text}"
    mt = cfg.get("vision_max_tokens_table", 8000)
    try:
        if _vision_is_openai(pcfg):
            response = _get_openai_client(pcfg).responses.create(
                model=pcfg.vision_model,
                reasoning={"effort": _gpt_effort(cfg)},
                instructions=_TABLE_SYS,
                input=[{"role": "user", "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": _data_url(image_path)},
                ]}],
                max_output_tokens=mt,
            )
            md = response.output_text.strip()
        else:
            md = _claude_vision(pcfg, cfg, _TABLE_SYS, [
                _image_block(Path(image_path).read_bytes()),
                {"type": "text", "text": prompt},
            ], mt)
        if md.startswith("```"):
            lines = md.split("\n")
            md = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        if "|" in md and "---" in md:
            return md
        print("  Vision table output didn't look like markdown, falling back to HTML")
    except Exception as e:
        print(f"  Vision table-to-markdown failed: {e}")
    if html_fallback:
        return _html_table_to_markdown(html_fallback)
    return ""


_CONSOLIDATE_SYS = (
    "You create concise, searchable descriptions of presentation slides. "
    "You are given two inputs:\n"
    "1. A visual description of what the slide shows (layout, diagrams, labels, charts)\n"
    "2. The speaker's transcript narration explaining the slide\n\n"
    "Produce a single consolidated description (3-5 sentences) that captures:\n"
    "- The slide title and key visual elements\n"
    "- The main concepts and data shown\n"
    "- The speaker's key points about this slide\n"
    "Write in third person, factual tone. This description will be used for semantic search indexing."
)


def consolidate_slide_description(vision_desc, transcript_text, *, pcfg: PipelineConfig, cfg: dict):
    """Merge a slide's visual description with its transcript text into one
    searchable description (slides+text content type)."""
    if not vision_desc:
        return transcript_text[:500] if transcript_text else ""
    if not transcript_text:
        return vision_desc
    prompt = f"SLIDE VISUAL DESCRIPTION:\n{vision_desc}\n\nSPEAKER TRANSCRIPT:\n{transcript_text[:1500]}"
    mt = cfg.get("vision_max_tokens_consolidate", 4000)
    try:
        if _vision_is_openai(pcfg):
            response = _get_openai_client(pcfg).responses.create(
                model=pcfg.vision_model,
                instructions=_CONSOLIDATE_SYS,
                input=[{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
                max_output_tokens=mt,
            )
            return response.output_text.strip()
        return _claude_vision(pcfg, cfg, _CONSOLIDATE_SYS, prompt, mt)
    except Exception as e:
        print(f"  Consolidation failed: {e}")
        return f"{vision_desc}\n\n{transcript_text[:500]}"


def describe_table_markdown(table_markdown, *, pcfg: PipelineConfig, cfg: dict):
    """Text-only description of an already-extracted markdown table."""
    system = "Describe this table concisely (2-3 sentences). Focus on what data it contains and key patterns."
    prompt = f"Describe this table:\n\n{table_markdown}"
    mt = cfg.get("vision_max_tokens_describe", 4000)
    if _vision_is_openai(pcfg):
        response = _get_openai_client(pcfg).responses.create(
            model=pcfg.vision_model,
            instructions=system,
            input=[{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            max_output_tokens=mt,
        )
        return response.output_text.strip()
    return _claude_vision(pcfg, cfg, system, prompt, mt)


_FORMULA_SYS = (
    "You transcribe mathematical equations from images into LaTeX. Output ONLY the LaTeX code for "
    "the equation(s): no $ delimiters, no equation numbers, no commentary, no code fences. "
    "Use \\\\ between lines of a multi-line display. Keep every symbol exactly as shown."
)


def formula_image_to_latex(png_bytes: bytes, ocr_text: str = "", *, pcfg: PipelineConfig, cfg: dict) -> str:
    """LaTeX transcription of an equation image (Claude or GPT per vision_model).
    Returns "" when the result is unusable."""
    prompt = "Transcribe this equation to LaTeX."
    if ocr_text:
        prompt += f"\nOCR text of the same equation (may be garbled, use only as a hint): {ocr_text[:300]}"
    mt = cfg.get("vision_max_tokens_describe", 4000)
    if _vision_is_openai(pcfg):
        b64 = base64.b64encode(png_bytes).decode("utf-8")
        response = _get_openai_client(pcfg).responses.create(
            model=pcfg.vision_model, instructions=_FORMULA_SYS,
            input=[{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": f"data:image/png;base64,{b64}"},
            ]}],
            max_output_tokens=mt,
        )
        out = response.output_text
    else:
        out = _claude_vision(pcfg, cfg, _FORMULA_SYS, [_image_block(png_bytes), {"type": "text", "text": prompt}], mt)
    out = (out or "").strip()
    if out.startswith("```"):
        lines = out.split("\n")
        out = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:]).strip()
    out = out.strip("$").strip()
    if len(out) < 3 or len(out) > 2000 or out.lower().startswith(("i cannot", "i can't", "sorry")):
        return ""
    return out


# ═════════════════════════════════════════════════════════════════
# POST-PROCESSING FUNCTIONS
# ═════════════════════════════════════════════════════════════════

def postprocess_presentation(result, pdf_path, doc_config, pcfg: PipelineConfig, cfg: dict):
    """For presentations: render slides as PNGs, upload to SFTP, set image_url."""
    print("\nPost-processing: Presentation slides...")
    slide_pngs = render_slides_to_png(
        pdf_path,
        f"{cfg.get('output_dir_slides', './content/slides')}/{doc_config.source_name}",
        "deck",
    )
    slide_urls = batch_upload_assets(slide_pngs, _remote_dir(doc_config.source_name), pcfg)
    matched = 0
    for child in result.child_chunks:
        for pn in child.page_numbers:
            if pn in slide_urls:
                child.image_url = slide_urls[pn]
                matched += 1; break
    for parent in result.parent_chunks:
        for pn in parent.page_numbers:
            if pn in slide_urls:
                parent.image_url = slide_urls[pn]; break
    print(f"  {matched}/{len(result.child_chunks)} children linked to slide images")
    return result


def postprocess_slides_text(result, pdf_path, doc_config, pcfg: PipelineConfig, cfg: dict):
    """For slides+text: extract slide images, Claude vision, consolidate with transcript."""
    print("\nPost-processing: Slides+text (image extraction + Claude vision + consolidation)...")
    page_to_slide = extract_slides_from_pages(
        pdf_path,
        f"{cfg.get('output_dir_slides', './content/slides')}/{doc_config.source_name}",
        "deck",
        zoom=cfg.get("slide_render_zoom", 2.0),
    )
    unique_paths = list(set(page_to_slide.values()))
    slide_urls = {}
    if unique_paths:
        remote_dir = _remote_dir(doc_config.source_name)
        uploaded = batch_upload_assets(unique_paths, remote_dir, pcfg)
        for p in unique_paths:
            fname = Path(p).name
            for pg, url in uploaded.items():
                if fname in url:
                    slide_urls[p] = url; break
            if p not in slide_urls:
                slide_urls[p] = f"{pcfg.public_base}/{remote_dir}/{fname}"

    print(f"  Getting Claude vision descriptions for {len(unique_paths)} slides...")
    slide_descriptions = {}
    for path in unique_paths:
        try:
            desc = describe_image(path, context_text=doc_config.source_description, pcfg=pcfg, cfg=cfg)
            slide_descriptions[path] = desc
            print(f"    {Path(path).stem}: {desc[:80]}...")
        except Exception as e:
            print(f"    {Path(path).name}: Claude vision failed ({e})")
            slide_descriptions[path] = ""

    page_urls = {pg: slide_urls.get(path, "") for pg, path in page_to_slide.items()}

    print("  Consolidating slide descriptions with transcript text...")
    slide_to_children = {}
    for child in result.child_chunks:
        for pn in child.page_numbers:
            path = page_to_slide.get(pn)
            if path:
                slide_to_children.setdefault(path, []).append(child); break

    slide_consolidated = {}
    for path in unique_paths:
        vision = slide_descriptions.get(path, "")
        children = slide_to_children.get(path, [])
        transcript = " ".join(c.content for c in children if c.content).strip()
        consolidated = consolidate_slide_description(vision, transcript, pcfg=pcfg, cfg=cfg)
        slide_consolidated[path] = consolidated
        print(f"    {Path(path).stem}: {consolidated[:80]}...")

    matched = 0
    for child in result.child_chunks:
        for pn in child.page_numbers:
            if pn in page_urls and page_urls[pn]:
                child.image_url = page_urls[pn]
                path = page_to_slide.get(pn)
                if path and slide_consolidated.get(path):
                    child.description = slide_consolidated[path]
                matched += 1; break
    for parent in result.parent_chunks:
        for pn in parent.page_numbers:
            if pn in page_urls and page_urls[pn]:
                parent.image_url = page_urls[pn]; break
    print(f"  {matched}/{len(result.child_chunks)} children linked to slides with consolidated descriptions")
    return result


def postprocess_figures(result, doc_config, pcfg: PipelineConfig, cfg: dict):
    """For research papers / text+figures: save images locally, upload to SFTP, add Claude descriptions."""
    print("\nPost-processing: Figures & tables...")
    from PIL import Image
    import io

    out_dir = Path(f"{cfg.get('output_dir_images', './content/images')}/{doc_config.source_name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"  Local image dir: {out_dir.resolve()}")

    fig_num, tbl_num, processed = 0, 0, 0

    for child in result.child_chunks:
        if child.chunk_type not in ("figure", "table", ChunkType.FIGURE, ChunkType.TABLE):
            continue

        parent = result.parent_lookup.get(child.parent_id)
        if parent and parent.figure_caption and not child.figure_caption:
            child.figure_caption = parent.figure_caption

        b64 = child.figure_base64
        if not b64 and parent:
            b64 = getattr(parent, "figure_base64", None)

        if b64 and not child.image_url:
            page = child.page_numbers[0] if child.page_numbers else 0
            if child.chunk_type in ("table", ChunkType.TABLE):
                tbl_num += 1
                fname = f"tbl-{tbl_num:02d}_p{page:03d}.png"
            else:
                fig_num += 1
                fname = f"fig-{fig_num:02d}_p{page:03d}.png"

            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes))
            local_path = out_dir / fname
            img.save(str(local_path), format="PNG")
            print(f"  Saved: {local_path}")

            try:
                url = upload_asset(str(local_path), _remote_dir(doc_config.source_name), pcfg)
                child.image_url = url
                if parent:
                    parent.image_url = url
                print(f"  Uploaded: {fname} -> {url}")
            except Exception as e:
                print(f"  SFTP upload failed for {fname}: {e}")
                child.image_url = str(local_path.resolve())

            context = child.figure_caption or child.context_breadcrumb or child.content[:200]
            try:
                child.description = describe_image(str(local_path), context_text=context, pcfg=pcfg, cfg=cfg)
                print(f"  Claude desc: {child.description[:80]}...")
            except Exception as e:
                print(f"  Claude vision failed for {fname}: {e}")
                child.description = child.figure_caption or child.content

            if child.chunk_type in ("table", ChunkType.TABLE):
                html_fallback = getattr(child, "table_html", "") or ""
                try:
                    md = table_image_to_markdown(str(local_path), context_text=context, html_fallback=html_fallback, pcfg=pcfg, cfg=cfg)
                    if md:
                        child.table_markdown = md
                        print(f"  Table markdown: {len(md)} chars")
                except Exception as e:
                    print(f"  Table markdown failed for {fname}: {e}")
                    if html_fallback:
                        child.table_markdown = _html_table_to_markdown(html_fallback)

            processed += 1
        elif not child.image_url and child.content:
            if not child.description:
                child.description = child.content
            processed += 1

    print(f"\n  Processed {processed} figures/tables ({fig_num} figures, {tbl_num} tables)")
    print(f"  Images saved in: {out_dir.resolve()}")
    return result


def postprocess_standalone_image(result, doc_config, pcfg: PipelineConfig, cfg: dict):
    """For standalone images: save as PNG, upload to SFTP, describe with Claude."""
    print("\nPost-processing: Standalone image...")
    from PIL import Image
    import io
    out_dir = Path(f"{cfg.get('output_dir_images', './content/images')}/{doc_config.source_name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    for child in result.child_chunks:
        b64 = child.figure_base64
        if not b64:
            parent = result.parent_lookup.get(child.parent_id)
            b64 = getattr(parent, "figure_base64", None)
        if b64 and not child.image_url:
            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes))
            fname = "image.png"
            local_path = out_dir / fname
            img.save(str(local_path), format="PNG")
            print(f"  Saved: {local_path}")
            try:
                url = upload_asset(str(local_path), _remote_dir(doc_config.source_name), pcfg)
                child.image_url = url
                print(f"  Uploaded: {fname} -> {url}")
            except Exception as e:
                print(f"  SFTP upload failed: {e}")
                child.image_url = str(local_path.resolve())
            try:
                desc = describe_image(str(local_path), context_text=doc_config.source_description, pcfg=pcfg, cfg=cfg)
                child.description = desc; child.content = desc
                print(f"  Claude: {desc[:80]}...")
            except Exception as e:
                print(f"  Claude vision failed: {e}")
                child.description = doc_config.source_description
                child.content = doc_config.source_description
            parent = result.parent_lookup.get(child.parent_id)
            if parent:
                parent.image_url = child.image_url
                parent.content = child.content
    print("  Standalone image processed")
    return result


def postprocess_standalone_table(result, doc_config, pcfg: PipelineConfig, cfg: dict):
    """For standalone tables: upload image if present, generate markdown + description."""
    print("\nPost-processing: Standalone table...")
    from PIL import Image
    import io
    out_dir = Path(f"{cfg.get('output_dir_images', './content/images')}/{doc_config.source_name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    for child in result.child_chunks:
        b64 = child.figure_base64
        if not b64:
            parent = result.parent_lookup.get(child.parent_id)
            b64 = getattr(parent, "figure_base64", None)
        if b64 and not child.image_url:
            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes))
            fname = "table.png"
            local_path = out_dir / fname
            img.save(str(local_path), format="PNG")
            print(f"  Saved: {local_path}")
            try:
                url = upload_asset(str(local_path), _remote_dir(doc_config.source_name), pcfg)
                child.image_url = url
                print(f"  Uploaded: {fname} -> {url}")
            except Exception as e:
                print(f"  SFTP upload failed: {e}")
                child.image_url = str(local_path.resolve())
            context = doc_config.source_description
            try:
                child.description = describe_image(str(local_path), context_text=context, pcfg=pcfg, cfg=cfg)
                print(f"  Claude desc: {child.description[:80]}...")
            except Exception as e:
                print(f"  Claude vision failed: {e}")
                child.description = context
            try:
                md = table_image_to_markdown(str(local_path), context_text=context, pcfg=pcfg, cfg=cfg)
                if md:
                    child.table_markdown = md; child.content = md
                    print(f"  Table markdown: {len(md)} chars")
            except Exception as e:
                print(f"  Table markdown failed: {e}")
        elif child.table_markdown and not child.description:
            try:
                child.description = describe_table_markdown(child.table_markdown, pcfg=pcfg, cfg=cfg)
                print(f"  Claude desc: {child.description[:80]}...")
            except Exception as e:
                print(f"  Claude description failed: {e}")
                child.description = child.content[:200]
        parent = result.parent_lookup.get(child.parent_id)
        if parent:
            if child.image_url:
                parent.image_url = child.image_url
            if child.table_markdown:
                parent.table_markdown = child.table_markdown
            if child.content and not parent.content:
                parent.content = child.content
    print("  Standalone table processed")
    return result


def postprocess_notebook(result, doc_config, pcfg: PipelineConfig, cfg: dict):
    """For notebooks: upload code_output images to SFTP, describe with Claude."""
    print("\nPost-processing: Notebook outputs...")
    from PIL import Image
    import io
    out_dir = Path(f"{cfg.get('output_dir_images', './content/images')}/{doc_config.source_name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    processed = 0
    for child in result.child_chunks:
        if child.chunk_type not in ("code_output", ChunkType.CODE_OUTPUT):
            continue
        b64 = child.figure_base64
        if not b64:
            parent = result.parent_lookup.get(child.parent_id)
            b64 = getattr(parent, "figure_base64", None)
        if b64 and not child.image_url:
            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes))
            fname = f"out-{processed + 1:02d}.png"
            local_path = out_dir / fname
            img.save(str(local_path), format="PNG")
            print(f"  Saved: {local_path}")
            try:
                url = upload_asset(str(local_path), _remote_dir(doc_config.source_name), pcfg)
                child.image_url = url
                print(f"  Uploaded: {fname} -> {url}")
            except Exception as e:
                print(f"  SFTP upload failed: {e}")
                child.image_url = str(local_path.resolve())
            context = child.content or child.context_breadcrumb or doc_config.source_description
            try:
                child.description = describe_image(str(local_path), context_text=context, pcfg=pcfg, cfg=cfg)
                print(f"  Claude: {child.description[:80]}...")
            except Exception as e:
                print(f"  Claude vision failed: {e}")
                child.description = child.content or "Code output visualization"
            parent = result.parent_lookup.get(child.parent_id)
            if parent:
                parent.image_url = child.image_url
            processed += 1
    print(f"  Processed {processed} code output images")
    return result


# ═════════════════════════════════════════════════════════════════
# PIPELINE ORCHESTRATOR
# ═════════════════════════════════════════════════════════════════

class SemanticChunkingPipeline:
    """Orchestrates one document: parse -> split -> enrich -> decompose.
    Post-processing and upserting happen in process_and_upsert()."""
    def __init__(self, pcfg: PipelineConfig):
        cfg = pcfg.cfg
        self.pcfg = pcfg
        self.cfg = cfg
        self.parser = StructuralParser(pcfg.unstructured_api_key, cfg, pcfg.unstructured_api_url, pcfg=pcfg)
        self.splitter = ParentChildSplitter(cfg)
        self.llm = AnthropicLLM(pcfg.anthropic_api_key, pcfg.llm_model, cfg)
        self.enricher = ChunkEnricher(self.llm, cfg)
        self.decomposer = PropositionDecomposer(self.llm, cfg)

    def process(self, source: str, *, source_url: Optional[str] = None,
                doc_config: Optional[DocumentConfig] = None,
                enrich=True, decompose=None) -> PipelineResult:
        start = time.time()
        do_dec = decompose if decompose is not None else self.cfg["enable_propositions"]
        doc = DocumentSource(source, source_url=source_url, timeout=self.cfg["api_timeout"])
        try:
            fp = doc.resolve(); url = doc.source_url; fn = doc.filename
            print(f"Source:     {source}")
            if url:
                print(f"Source URL: {url}")
            if doc._tmp:
                print(f"Downloaded: {fn} ({fp.stat().st_size / 1024:.0f} KB)")
            print()
            ct = doc_config.content_type if doc_config else "text_doc"
            parse_method = {
                "standalone_image": "direct image read",
                "standalone_table": "direct file parse",
                "notebook": "ipynb JSON parse",
            }.get(ct, "Unstructured SDK")
            print(f"Step 1/4: Structural parsing ({parse_method})...")
            st = self.parser.parse(fp, content_type=ct)
            print(f"   {len(st)} structural chunks")

            print("Step 2/4: Parent-child splitting...")
            parents, children = self.splitter.split(st, url)
            print(f"   {len(parents)} parents -> {len(children)} children")

            if doc_config:
                for i, p in enumerate(parents):
                    p.source_name = doc_config.source_name
                    p.source_description = doc_config.source_description
                    if not p.source_url:
                        p.source_url = doc_config.source_url
                for i, c in enumerate(children):
                    c.source_name = doc_config.source_name
                    c.source_description = doc_config.source_description
                    c.order = i
                    if not c.source_url:
                        c.source_url = doc_config.source_url

            # Figure/table children are enriched and decomposed after post-processing,
            # once their content is clean (table markdown / vision description) -
            # raw OCR text of charts and tables is noisy and wastes LLM calls.
            llm_targets = [c for c in children if c.chunk_type in ("text", "code")]
            deferred = len(children) - len(llm_targets)
            if enrich:
                print(f"Step 3/4: KeyBERT + LLM enrichment ({len(llm_targets)} text chunks"
                      + (f", {deferred} figure/table chunks deferred to post-processing" if deferred else "") + ")...")
                self.enricher.enrich(llm_targets)
                print("   Keywords, summaries, questions added")
            else:
                print("Step 3/4: KeyBERT keywords only")
                for c in children:
                    c.keywords = extract_keywords(c.content, self.cfg["keyword_top_n"], self.cfg)

            props = []
            if do_dec:
                print(f"Step 4/4: Propositions ({len(llm_targets)} text chunks)...")
                props = self.decomposer.decompose(llm_targets, url)
                print(f"   {len(props)} propositions")
                if doc_config:
                    for pr in props:
                        pr.source_name = doc_config.source_name
                        pr.source_description = doc_config.source_description
            else:
                print("Step 4/4: Skipping propositions")
        finally:
            doc.cleanup()

        elapsed = time.time() - start
        pn = set()
        for c in children:
            pn.update(c.page_numbers)
        r = PipelineResult(
            filename=fn, source_url=url,
            total_pages=max(pn) if pn else 0, raw_element_count=len(st),
            parent_chunks=parents, child_chunks=children, propositions=props,
            llm_calls_made=self.llm.total_calls, llm_tokens_used=self.llm.total_tokens,
            processing_time_seconds=round(elapsed, 2),
        )
        print(f"\n{'=' * 60}")
        print(f"  Done in {elapsed:.1f}s | {fn}" + (f" -> {url}" if url else ""))
        print(f"  {r.total_pages} pages | {len(parents)} parents -> {len(children)} children | {len(props)} propositions")
        print(f"  {self.llm.total_calls} LLM calls, ~{self.llm.total_tokens} tokens")
        print(f"{'=' * 60}")
        return r


# ═════════════════════════════════════════════════════════════════
# HIGH-LEVEL CONVENIENCE FUNCTION
# ═════════════════════════════════════════════════════════════════

def _maybe_upload_source(source: str, doc_config: DocumentConfig, pcfg: PipelineConfig):
    """source_url="upload" hosts the source document itself on the configured
    provider (Cloudinary/SFTP) and uses that URL as the document's source_url."""
    if doc_config.source_url != "upload":
        return
    if str(source).strip().startswith(("http://", "https://")):
        doc_config.source_url = source  # already hosted - just link it
        return
    print("Uploading source document to the configured host...")
    # upload under a clean fixed name: local filenames often contain spaces,
    # which make long %20-escaped URLs that LLMs mis-copy in citations
    with tempfile.TemporaryDirectory(prefix="srcdoc_") as td:
        clean = Path(td) / f"source{Path(source).suffix.lower()}"
        clean.write_bytes(Path(source).read_bytes())
        doc_config.source_url = upload_asset(str(clean), _remote_dir(doc_config.source_name), pcfg)
    print(f"   source_url = {doc_config.source_url}")
    if pcfg.upload_provider == "cloudinary" and str(source).lower().endswith((".pdf", ".zip")):
        print("   NOTE: free Cloudinary accounts must enable Settings -> Security -> "
              "'Allow delivery of PDF and ZIP files' or this link will show an error.")


def process_and_upsert(
    pcfg: PipelineConfig,
    source: str,
    doc_config: DocumentConfig,
    *,
    enrich: bool = True,
    decompose: bool = True,
) -> PipelineResult:
    """
    Process a document through the full pipeline and upsert to Pinecone in one call.

    Returns the PipelineResult for inspection.
    """
    cfg = pcfg.cfg
    _maybe_upload_source(source, doc_config, pcfg)
    pipeline = SemanticChunkingPipeline(pcfg)
    ct = doc_config.content_type

    # Slide-based content types need the PDF again during post-processing.
    # For URL sources, download once here and keep the temp file alive past
    # pipeline.process() (which otherwise cleans up its own download).
    local_source, dl = source, None
    if ct in ("presentation", "slides+text") and source.strip().startswith(("http://", "https://")):
        dl = DocumentSource(source, source_url=doc_config.source_url or source,
                            timeout=cfg["api_timeout"])
        local_source = str(dl.resolve())

    try:
        # 1. Process
        result = pipeline.process(
            local_source, source_url=(dl.source_url if dl else None),
            doc_config=doc_config, enrich=enrich, decompose=decompose,
        )

        # 2. Post-process by content type
        if ct == "presentation":
            result = postprocess_presentation(result, local_source, doc_config, pcfg, cfg)
        elif ct == "slides+text":
            result = postprocess_slides_text(result, local_source, doc_config, pcfg, cfg)
        elif ct in ("research_paper", "text_doc_with_figures"):
            result = postprocess_figures(result, doc_config, pcfg, cfg)
        elif ct == "standalone_image":
            result = postprocess_standalone_image(result, doc_config, pcfg, cfg)
        elif ct == "standalone_table":
            result = postprocess_standalone_table(result, doc_config, pcfg, cfg)
        elif ct == "notebook":
            result = postprocess_notebook(result, doc_config, pcfg, cfg)
    finally:
        if dl:
            dl.cleanup()

    # 3. Fix up parent content from post-processed children
    if ct in ("standalone_image", "standalone_table"):
        for c in result.child_chunks:
            if c.content and c.parent_id:
                for p in result.parent_chunks:
                    if p.parent_id == c.parent_id and not p.content:
                        p.content = c.content

    # 3b. Give figure/table children (and their parents) clean content: table
    #     markdown instead of raw OCR text, caption for figures. This is what
    #     gets embedded, decomposed and shown to the chatbot as context.
    for c in result.child_chunks:
        parent = result.parent_lookup.get(c.parent_id)
        if c.chunk_type == "table" and c.table_markdown:
            c.content = c.table_markdown
            if parent:
                parent.content = c.table_markdown
                parent.table_markdown = c.table_markdown
        elif c.chunk_type == "figure":
            caption = (c.figure_caption or "").strip()
            desc = (c.description or "").strip()
            if caption or desc:
                c.content = caption if caption else desc
                if parent:
                    parent.content = (caption + "\n\n" + desc).strip() if caption and desc else (caption or desc)

    # 4. Enrich children not yet enriched (figure/table chunks deferred from Step 3)
    if enrich:
        empty_children = [c for c in result.child_chunks if (not c.keywords or c.keywords == []) and c.content]
        if empty_children:
            print(f"\nEnriching {len(empty_children)} figure/table chunks (post-processed content)...")
            enriched = pipeline.enricher.enrich(empty_children)
            enriched_map = {c.child_id: c for c in enriched}
            for i, c in enumerate(result.child_chunks):
                if c.child_id in enriched_map:
                    result.child_chunks[i] = enriched_map[c.child_id]
            print(f"   Re-enriched {len(empty_children)} chunks")

    # 5. Fix char_count
    for c in result.child_chunks:
        if c.content:
            c.char_count = len(c.content)
    for p in result.parent_chunks:
        if p.content:
            p.char_count = len(p.content)

    if ct in ("standalone_image", "standalone_table"):
        for c in result.child_chunks:
            parent = next((p for p in result.parent_chunks if p.parent_id == c.parent_id), None)
            if parent and parent.content and len(parent.content) > len(c.content):
                c.content = parent.content
                c.char_count = len(c.content)

    # 6. Re-decompose propositions for post-processed chunks
    if decompose:
        existing_child_ids = {p.source_child_id for p in result.propositions}
        empty_children = [
            c for c in result.child_chunks
            if c.child_id not in existing_child_ids
            and (c.content or getattr(c, "description", "") or getattr(c, "table_markdown", ""))
        ]
        if empty_children:
            for c in empty_children:
                if not c.content:
                    c.content = getattr(c, "table_markdown", "") or getattr(c, "description", "") or ""
            print(f"\nPropositions for {len(empty_children)} figure/table chunks (post-processed content)...")
            new_props = pipeline.decomposer.decompose(empty_children, doc_config.source_url)
            result.propositions.extend(new_props)
            print(f"   {len(new_props)} additional propositions")

    # 7. Upsert to Pinecone
    print("\nUpserting to Pinecone...")
    indexer = PineconeIndexer(api_key=pcfg.pinecone_api_key, index_host=pcfg.pinecone_index_host, config=cfg)
    stats = indexer.upsert_result(result)
    print(f"Done: {stats['children']} children, {stats['parents']} parents, {stats['propositions']} propositions\n")

    return result


# ═════════════════════════════════════════════════════════════════
# UTILITIES
# ═════════════════════════════════════════════════════════════════

def index_stats(pcfg: PipelineConfig):
    """Print Pinecone index statistics."""
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    print(index.describe_index_stats())


def _fetch_meta(index, ns, ids):
    resp = index.fetch(ids=list(ids), namespace=ns)
    vectors = getattr(resp, "vectors", {}) or {}
    for vid, vec in vectors.items():
        yield vid, (getattr(vec, "metadata", None) or {})


def _iter_namespace(index, ns, max_url_chars=3000):
    """Yield (record_id, metadata) for EVERY record in a namespace.

    Pages through all ids with index.list() (exact on serverless indexes),
    then fetches metadata. fetch() is a GET with the ids in the URL, so batches
    are sized by total id length (prefixed ids are ~140 chars) to stay under
    the server's header limit (HTTP 431 otherwise)."""
    for page in index.list(namespace=ns):
        if not page:
            continue
        batch, size = [], 0
        for vid in page:
            cost = len(vid) + 16  # url-encoding of '::' plus '&ids=' overhead
            if batch and size + cost > max_url_chars:
                yield from _fetch_meta(index, ns, batch)
                batch, size = [], 0
            batch.append(vid)
            size += cost
        if batch:
            yield from _fetch_meta(index, ns, batch)


def _collect_source_ids(index, ns, source_name, extra_child_ids=None, deep=True):
    """All record ids in `ns` belonging to source_name.

    Always does the cheap id-prefix listing '<source_name>::' (records upserted
    by the current code; ids only, near-zero egress). With deep=True it adds a
    full metadata scan for legacy unprefixed records - that downloads every
    record in the namespace, which Pinecone bills as egress, so callers request
    it only when needed. extra_child_ids additionally matches propositions via
    their source_child_id."""
    ids = set()
    try:
        for page in index.list(prefix=f"{source_name}::", namespace=ns):
            ids.update(page)
    except Exception as e:
        logger.warning("Prefix listing failed in '%s': %s", ns, e)
    if not deep:
        return ids
    child_ids = extra_child_ids or set()
    for vid, md in _iter_namespace(index, ns):
        if md.get("source_name") == source_name:
            ids.add(vid)
        elif child_ids and _plain_id(md.get("source_child_id", "")) in child_ids:
            ids.add(vid)
    return ids


def list_sources(pcfg: PipelineConfig):
    """List all unique source_name values across all namespaces (exact counts).

    EGRESS WARNING: full index scan - downloads every record (roughly the size
    of the whole index per run), which counts toward Pinecone's egress quota.
    Run sparingly on the free tier."""
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    ns_children = cfg["pinecone_ns_children"]
    ns_parents = cfg["pinecone_ns_parents"]
    ns_props = cfg["pinecone_ns_propositions"]
    source_counts = defaultdict(lambda: defaultdict(int))
    for ns in [ns_children, ns_parents, ns_props]:
        try:
            for _vid, md in _iter_namespace(index, ns):
                sn = md.get("source_name") or "(empty)"
                source_counts[sn][ns] += 1
        except Exception as e:
            print(f"Error scanning '{ns}': {e}")

    print(f"{'Source Name':<70} {'children':>10} {'parents':>10} {'props':>10}")
    print("-" * 100)
    for sn in sorted(source_counts.keys()):
        counts = source_counts[sn]
        print(f"{sn:<70} {counts.get(ns_children, 0):>10} {counts.get(ns_parents, 0):>10} {counts.get(ns_props, 0):>10}")
    print(f"\n{len(source_counts)} unique source names found (exact counts)")
    return {sn: dict(counts) for sn, counts in source_counts.items()}


def delete_source(pcfg: PipelineConfig, source_name: str, deep="auto", verify: bool = True):
    """Delete ALL records for a source_name across all namespaces.

    Records upserted by the current code carry a '<source_name>::' id prefix and
    are found by cheap id listings (near-zero egress). Legacy unprefixed records
    need a full metadata scan of the whole index, which Pinecone bills as egress:
      deep="auto" (default) - scan only if the prefix listing finds nothing
      deep=True  - always scan (use for sources with both legacy and new records)
      deep=False - prefix-only
    With verify=True, re-checks afterwards in the same mode."""
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    ns_children = cfg["pinecone_ns_children"]
    ns_parents = cfg["pinecone_ns_parents"]
    ns_props = cfg["pinecone_ns_propositions"]

    prefix_hits = {ns: _collect_source_ids(index, ns, source_name, deep=False)
                   for ns in (ns_children, ns_parents, ns_props)}
    do_scan = deep is True or (deep == "auto" and not any(prefix_hits.values()))
    if do_scan:
        print("Full metadata scan for legacy records (downloads the whole index - counts toward Pinecone egress)...")
        child_ids = _collect_source_ids(index, ns_children, source_name)
        plain_child_ids = {_plain_id(i) for i in child_ids}
        parent_ids = _collect_source_ids(index, ns_parents, source_name)
        prop_ids = _collect_source_ids(index, ns_props, source_name, extra_child_ids=plain_child_ids)
    else:
        child_ids = prefix_hits[ns_children]
        parent_ids = prefix_hits[ns_parents]
        prop_ids = prefix_hits[ns_props]

    for ns, ids in [(ns_children, child_ids), (ns_parents, parent_ids), (ns_props, prop_ids)]:
        if not ids:
            print(f"No records found in '{ns}' for source_name='{source_name}'")
            continue
        ids = sorted(ids)
        for i in range(0, len(ids), 1000):
            index.delete(ids=ids[i:i + 1000], namespace=ns)
        print(f"Deleted {len(ids)} records from '{ns}'")

    if verify:
        print("\nVerifying (deletes can take a few seconds to become visible)...")
        time.sleep(5)
        verify_source_deleted(pcfg, source_name, deep=do_scan)


def verify_source_deleted(pcfg: PipelineConfig, source_name: str, deep: bool = False):
    """Re-check all namespaces for records still matching source_name.

    Default is the cheap prefix-only check, which covers everything upserted by
    the current code with near-zero egress. Pass deep=True to also scan every
    record's metadata for legacy unprefixed records - that downloads the whole
    index and counts toward Pinecone's egress quota.
    Returns {namespace: [remaining ids]}; all-empty means the source is gone."""
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    remaining = {}
    for ns in [cfg["pinecone_ns_children"], cfg["pinecone_ns_parents"], cfg["pinecone_ns_propositions"]]:
        ids = _collect_source_ids(index, ns, source_name, deep=deep)
        remaining[ns] = sorted(ids)
        status = "CLEAN" if not ids else f"{len(ids)} record(s) REMAINING"
        print(f"  {ns:<15} {status}")
    if not deep:
        print("  (prefix check only - pass deep=True to also scan for legacy unprefixed records)")
    return remaining


def audit_index(pcfg: PipelineConfig):
    """Full-index audit: exact per-source counts plus orphaned records.

    Orphans are propositions whose source child no longer exists and children
    whose parent no longer exists (leftovers of past partial deletes). Returns
    the findings; pass the orphan id lists to delete_ids() to remove them.

    EGRESS WARNING: downloads every record in the index (counts toward
    Pinecone's egress quota). Run sparingly on the free tier."""
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    ns_children = cfg["pinecone_ns_children"]
    ns_parents = cfg["pinecone_ns_parents"]
    ns_props = cfg["pinecone_ns_propositions"]

    children = list(_iter_namespace(index, ns_children))
    parents = list(_iter_namespace(index, ns_parents))
    props = list(_iter_namespace(index, ns_props))

    source_counts = defaultdict(lambda: defaultdict(int))
    for ns, records in [(ns_children, children), (ns_parents, parents), (ns_props, props)]:
        for _vid, md in records:
            source_counts[md.get("source_name") or "(empty)"][ns] += 1

    print(f"{'Source Name':<70} {'children':>10} {'parents':>10} {'props':>10}")
    print("-" * 100)
    for sn in sorted(source_counts.keys()):
        counts = source_counts[sn]
        print(f"{sn:<70} {counts.get(ns_children, 0):>10} {counts.get(ns_parents, 0):>10} {counts.get(ns_props, 0):>10}")

    child_id_set = {_plain_id(vid) for vid, _ in children}
    parent_id_set = {_plain_id(vid) for vid, _ in parents}
    orphan_children = [vid for vid, md in children
                       if md.get("parent_id") and _plain_id(md["parent_id"]) not in parent_id_set]
    orphan_props = [vid for vid, md in props
                    if md.get("source_child_id") and _plain_id(md["source_child_id"]) not in child_id_set]

    print(f"\nTotals: {len(children)} children | {len(parents)} parents | {len(props)} propositions")
    print(f"Orphaned children (parent record missing):     {len(orphan_children)}")
    print(f"Orphaned propositions (child record missing):  {len(orphan_props)}")
    if orphan_children or orphan_props:
        print("Remove them with delete_ids(cfg, namespace, ids), e.g.:")
        print('  audit = audit_index(cfg)')
        print('  delete_ids(cfg, "propositions", audit["orphaned_propositions"])')
    return {
        "sources": {sn: dict(counts) for sn, counts in source_counts.items()},
        "orphaned_children": orphan_children,
        "orphaned_propositions": orphan_props,
    }


def delete_ids(pcfg: PipelineConfig, namespace: str, ids):
    """Delete an explicit list of record ids from one namespace."""
    ids = list(ids)
    if not ids:
        print("Nothing to delete.")
        return
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    for i in range(0, len(ids), 1000):
        index.delete(ids=ids[i:i + 1000], namespace=namespace)
    print(f"Deleted {len(ids)} records from '{namespace}'")


# ═════════════════════════════════════════════════════════════════
# LEGACY ID MIGRATION
# ═════════════════════════════════════════════════════════════════

def migrate_legacy_ids(pcfg: PipelineConfig, source_name: str | None = None,
                       dry_run: bool = True, batch_size: int = 50):
    """Re-key legacy (unprefixed) records to '<source_name>::<id>' in place.

    Reads every legacy record's stored fields (text, summaries, keywords,
    propositions...), re-upserts it under the prefixed id with cross-references
    (parent_id, child_ids, source_child_id, source_parent_id) prefixed too, then
    deletes the old record. No Unstructured or LLM calls - just Pinecone
    read/write units. Scans each namespace once, so migrating all sources at
    once (source_name=None) costs the same as migrating one.

    dry_run=True only reports what would be migrated. Take a backup first
    (backup_index) before running with dry_run=False."""
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    ns_children = cfg["pinecone_ns_children"]
    ns_parents = cfg["pinecone_ns_parents"]
    ns_props = cfg["pinecone_ns_propositions"]

    def rekey(ns, md):
        sn = md.get("source_name", "")
        rec = dict(md)
        if ns == ns_children and rec.get("parent_id"):
            rec["parent_id"] = _rid(sn, _plain_id(rec["parent_id"]))
        elif ns == ns_parents and rec.get("child_ids"):
            try:
                cids = json.loads(rec["child_ids"])
                rec["child_ids"] = json.dumps([_rid(sn, _plain_id(c)) for c in cids])
            except Exception:
                pass
        elif ns == ns_props:
            for k in ("source_child_id", "source_parent_id"):
                if rec.get(k):
                    rec[k] = _rid(sn, _plain_id(rec[k]))
        return rec

    summary = defaultdict(lambda: defaultdict(int))
    skipped_no_source = defaultdict(int)
    total_migrated = 0
    for ns in (ns_children, ns_parents, ns_props):
        print(f"Scanning '{ns}'...")
        legacy = []
        for vid, md in _iter_namespace(index, ns):
            if "::" in vid:
                continue
            sn = md.get("source_name", "")
            if not sn:
                skipped_no_source[ns] += 1
                continue
            if source_name and sn != source_name:
                continue
            legacy.append((vid, md))
            summary[sn][ns] += 1
        if dry_run or not legacy:
            continue
        new_recs = [{"id": _rid(md["source_name"], vid), **rekey(ns, md)} for vid, md in legacy]
        for i in range(0, len(new_recs), batch_size):
            index.upsert_records(namespace=ns, records=new_recs[i:i + batch_size])
        old_ids = [vid for vid, _ in legacy]
        for i in range(0, len(old_ids), 1000):
            index.delete(ids=old_ids[i:i + 1000], namespace=ns)
        total_migrated += len(legacy)
        print(f"   migrated {len(legacy)} records in '{ns}'")

    print(f"\n{'Source Name':<70} {'children':>10} {'parents':>10} {'props':>10}")
    print("-" * 104)
    for sn in sorted(summary):
        c = summary[sn]
        print(f"{sn:<70} {c.get(ns_children, 0):>10} {c.get(ns_parents, 0):>10} {c.get(ns_props, 0):>10}")
    if skipped_no_source:
        print(f"\nSkipped (no source_name, cannot prefix): {dict(skipped_no_source)}")
    if dry_run:
        n = sum(sum(c.values()) for c in summary.values())
        print(f"\nDRY RUN: {n} legacy records across {len(summary)} source(s) would be migrated. "
              f"Re-run with dry_run=False to apply (take a backup first).")
    else:
        print(f"\nMigrated {total_migrated} records. Verify with list_sources(cfg) or a prefix check.")
    return {sn: dict(c) for sn, c in summary.items()}


# ═════════════════════════════════════════════════════════════════
# IMAGE URL SHORTENING (fix for already-indexed sources)
# ═════════════════════════════════════════════════════════════════

def shorten_image_urls(pcfg: PipelineConfig, source_name: str | None = None, dry_run: bool = True):
    """Move already-uploaded images from the long '<source>/<source>_<file>'
    layout to the short '<slug>-<hash>/<file>' layout and update image_url on
    the existing Pinecone records in place (metadata update only - no
    re-embedding, no LLM calls). Long URLs get mis-copied by the chatbot's LLM
    and render as 'Image not available'."""
    import paramiko, posixpath
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    ns = cfg["pinecone_ns_children"]
    base = pcfg.public_base.rstrip("/") + "/"

    # collect (record id, old url, new url) grouped by source
    plan = defaultdict(list)
    for vid, md in _iter_namespace(index, ns):
        sn = md.get("source_name", "")
        url = md.get("image_url", "") or ""
        if not sn or not url.startswith(base) or (source_name and sn != source_name):
            continue
        rel = url[len(base):]
        parts = rel.split("/")
        if len(parts) != 2 or parts[0] != sn:
            continue  # already short (or foreign layout)
        fname = parts[1]
        if fname.startswith(sn + "_"):
            fname = fname[len(sn) + 1:]
        new_url = f"{base}{_remote_dir(sn)}/{fname}"
        plan[sn].append((vid, rel, f"{_remote_dir(sn)}/{fname}", new_url))

    total = sum(len(v) for v in plan.values())
    print(f"{'Source':<70} {'records':>8}  example new url")
    print("-" * 110)
    for sn, items in sorted(plan.items()):
        print(f"{sn[:70]:<70} {len(items):>8}  {items[0][3][-60:]}")
    if dry_run:
        print(f"\nDRY RUN: {total} image urls across {len(plan)} source(s) would be shortened. "
              f"Re-run with dry_run=False to apply.")
        return {sn: len(v) for sn, v in plan.items()}
    if not total:
        print("Nothing to do."); return {}

    transport = paramiko.Transport((pcfg.sftp_host, pcfg.sftp_port))
    transport.connect(username=pcfg.sftp_user, password=pcfg.sftp_pass)
    sftp = paramiko.SFTPClient.from_transport(transport)
    moved = updated = 0
    try:
        for sn, items in plan.items():
            _sftp_mkdir_p(sftp, _remote_dir(sn))
            seen_files = set()
            for vid, old_rel, new_rel, new_url in items:
                if new_rel not in seen_files:  # several records can share one image
                    seen_files.add(new_rel)
                    try:
                        sftp.stat(new_rel)  # already moved
                    except FileNotFoundError:
                        try:
                            sftp.rename(old_rel, new_rel); moved += 1
                        except FileNotFoundError:
                            logger.warning("Remote file missing, url left unchanged: %s", old_rel)
                            continue
                index.update(id=vid, set_metadata={"image_url": new_url}, namespace=ns)
                updated += 1
            print(f"  {sn[:60]}: {len(items)} records updated")
    finally:
        sftp.close(); transport.close()
    print(f"\nMoved {moved} files, updated image_url on {updated} records.")
    return {sn: len(v) for sn, v in plan.items()}


# ═════════════════════════════════════════════════════════════════
# DESCRIPTION REPAIR (junk prefixes from thinking-off vision retries)
# ═════════════════════════════════════════════════════════════════

_JUNK_PREFIX = re.compile(r"^(?:[\s.:,;\u2026]+|(?:assistant|Assistant)\b[\s.:,]*)+")


def fix_degenerate_descriptions(pcfg: PipelineConfig, dry_run: bool = True):
    """Find children whose stored description starts with leaked junk
    ('::', '...', '\u2026\u2026assistant', ...), sanitize description and the embedded
    text composite, and re-upsert those records under the same id (re-embeds)."""
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    ns = cfg["pinecone_ns_children"]
    to_fix = []
    for vid, md in _iter_namespace(index, ns):
        desc = md.get("description", "") or ""
        if desc and _JUNK_PREFIX.match(desc) and _JUNK_PREFIX.match(desc).group(0):
            clean = _JUNK_PREFIX.sub("", desc).strip()
            if clean and clean != desc:
                to_fix.append((vid, md, desc, clean))
    print(f"{len(to_fix)} record(s) with junk-prefixed descriptions")
    for vid, md, desc, clean in to_fix:
        print(f"  {md.get('source_name','')[:45]}: {desc[:60]!r} -> {clean[:60]!r}")
    if dry_run:
        if to_fix:
            print("\nDRY RUN - re-run with dry_run=False to repair.")
        return len(to_fix)
    for vid, md, desc, clean in to_fix:
        rec = dict(md)
        rec["description"] = clean
        if desc in (rec.get("text") or ""):
            rec["text"] = rec["text"].replace(desc, clean)
        index.upsert_records(namespace=ns, records=[{"id": vid, **rec}])
    if to_fix:
        print(f"Repaired {len(to_fix)} record(s).")
    return len(to_fix)


def refresh_figure_descriptions(pcfg: PipelineConfig, source_names: list[str], dry_run: bool = True):
    """Regenerate vision descriptions for figure children whose stored
    description is a short enrichment one-liner (< 220 chars), using the local
    image files, and re-upsert those records (same id, re-embeds)."""
    cfg = pcfg.cfg
    index = Pinecone(api_key=pcfg.pinecone_api_key).Index(host=pcfg.pinecone_index_host)
    ns = cfg["pinecone_ns_children"]
    img_root = Path(cfg.get("output_dir_images", "./content/images"))
    todo = []
    for sn in source_names:
        ids = [i for page in index.list(prefix=sn + "::", namespace=ns) for i in page]
        for i in range(0, len(ids), 20):
            for vid, v in index.fetch(ids=ids[i:i + 20], namespace=ns).vectors.items():
                md = v.metadata or {}
                if md.get("chunk_type") != "figure" or not md.get("image_url"):
                    continue
                if len(md.get("description", "") or "") >= 220:
                    continue
                fname = md["image_url"].rsplit("/", 1)[-1]
                local = None
                for cand in (img_root / sn / fname, img_root / sn / f"{sn}_{fname}"):
                    if cand.exists():
                        local = cand; break
                if local:
                    todo.append((vid, md, local))
                else:
                    logger.warning("No local image for %s (%s) - skipped", vid, fname)
    print(f"{len(todo)} figure record(s) to refresh")
    if dry_run:
        for vid, md, local in todo:
            print(f"  {local.name}: current desc {len(md.get('description','') or '')} chars")
        if todo:
            print("DRY RUN - re-run with dry_run=False to apply.")
        return len(todo)
    for vid, md, local in todo:
        context = md.get("figure_caption") or md.get("context_breadcrumb") or md.get("text", "")[:200]
        try:
            desc = describe_image(str(local), context_text=context, pcfg=pcfg, cfg=cfg)
        except Exception as e:
            logger.warning("Vision failed for %s: %s", local.name, e)
            continue
        if not desc:
            continue
        rec = dict(md)
        old_desc = rec.get("description", "") or ""
        rec["description"] = desc
        if old_desc and old_desc in (rec.get("text") or ""):
            rec["text"] = rec["text"].replace(old_desc, desc)
        elif rec.get("text"):
            rec["text"] = rec["text"] + "\n" + desc
        index.upsert_records(namespace=ns, records=[{"id": vid, **rec}])
        print(f"  {local.name}: {desc[:80]}...")
    return len(todo)


# ═════════════════════════════════════════════════════════════════
# BACKUP / RESTORE (Pinecone serverless backups; Standard plan or above)
# ═════════════════════════════════════════════════════════════════

def backup_index(pcfg: PipelineConfig, label: str = "", description: str = ""):
    """Create a point-in-time backup of the whole index (all namespaces).

    The backup name is '<index>-<label>' or '<index>-<YYYYmmdd-HHMM>' if no
    label is given. Returns the backup model (use .backup_id to restore)."""
    pc = Pinecone(api_key=pcfg.pinecone_api_key)
    stamp = label or time.strftime("%Y%m%d-%H%M")
    name = re.sub(r"[^a-z0-9-]", "-", f"{pcfg.pinecone_index_name}-{stamp}".lower())
    backup = pc.create_backup(
        index_name=pcfg.pinecone_index_name, backup_name=name,
        description=description or f"myAI6 backup {stamp}",
    )
    print(f"Backup '{backup.name}' created | id={backup.backup_id} | status={backup.status}")
    return backup


def list_backups(pcfg: PipelineConfig):
    """List backups for the configured index."""
    pc = Pinecone(api_key=pcfg.pinecone_api_key)
    backups = list(pc.list_backups(index_name=pcfg.pinecone_index_name, limit=100))
    if not backups:
        print(f"No backups for index '{pcfg.pinecone_index_name}'")
        return backups
    print(f"{'Backup name':<40} {'Created':<22} {'Status':<10} {'Records':>8}  Backup id")
    print("-" * 120)
    for b in backups:
        print(f"{b.name:<40} {str(b.created_at)[:19]:<22} {b.status:<10} "
              f"{b.record_count or 0:>8}  {b.backup_id}")
    return backups


def restore_backup(pcfg: PipelineConfig, backup_id: str, new_index_name: str, wait: bool = True):
    """Create a NEW index from a backup (e.g. a replica for testing, or a
    rollback target). Does not touch the existing index. Returns the new
    index model; its .host is what you would put into PINECONE_INDEX_HOST."""
    pc = Pinecone(api_key=pcfg.pinecone_api_key)
    model = pc.create_index_from_backup(name=new_index_name, backup_id=backup_id,
                                        timeout=None if wait else -1)
    print(f"Index '{new_index_name}' created from backup {backup_id}")
    print(f"  host: {model.host}")
    return model


def delete_backup(pcfg: PipelineConfig, backup_id: str):
    """Permanently delete a backup."""
    Pinecone(api_key=pcfg.pinecone_api_key).delete_backup(backup_id=backup_id)
    print(f"Backup {backup_id} deleted")


# ═════════════════════════════════════════════════════════════════
# EXPORT HELPERS
# ═════════════════════════════════════════════════════════════════

def to_langchain_documents(result):
    """Export a PipelineResult as LangChain Document objects."""
    from langchain_core.documents import Document
    return {
        "child_documents": [Document(page_content=c.content, metadata={
            "chunk_id": c.child_id, "parent_id": c.parent_id, "chunk_type": c.chunk_type,
            "keywords": c.keywords, "summary": c.summary, "context": c.context_breadcrumb,
            "questions": c.hypothetical_questions, "pages": c.page_numbers, "source_url": c.source_url,
        }) for c in result.child_chunks],
        "parent_documents": [Document(page_content=p.content, metadata={
            "parent_id": p.parent_id, "child_ids": p.child_ids, "context": p.context_breadcrumb,
            "pages": p.page_numbers, "source_url": p.source_url,
        }) for p in result.parent_chunks],
        "proposition_documents": [Document(page_content=pr.proposition, metadata={
            "prop_id": pr.proposition_id, "child_id": pr.source_child_id,
            "parent_id": pr.source_parent_id, "source_url": pr.source_url,
        }) for pr in result.propositions],
    }


def to_llama_index_nodes(result):
    """Export a PipelineResult as LlamaIndex TextNode objects."""
    from llama_index.core.schema import TextNode
    return {
        "child_nodes": [TextNode(text=c.content, id_=c.child_id, metadata={
            "parent_id": c.parent_id, "keywords": c.keywords, "summary": c.summary,
            "context": c.context_breadcrumb, "source_url": c.source_url,
        }) for c in result.child_chunks],
        "parent_nodes": [TextNode(text=p.content, id_=p.parent_id, metadata={
            "child_ids": p.child_ids, "context": p.context_breadcrumb, "source_url": p.source_url,
        }) for p in result.parent_chunks],
        "proposition_nodes": [TextNode(text=pr.proposition, id_=pr.proposition_id, metadata={
            "child_id": pr.source_child_id, "parent_id": pr.source_parent_id, "source_url": pr.source_url,
        }) for pr in result.propositions],
    }
