import fitz  # PyMuPDF
import re
from pathlib import Path
from typing import List, Dict, Optional
from dataclasses import dataclass

@dataclass
class PageText:
    page_num: int  # 1-indexed
    text: str
    has_text: bool
    bbox: Optional[dict] = None

@dataclass
class ExtractedDoc:
    title: str
    pages: List[PageText]
    total_pages: int
    is_scanned: bool
    metadata: dict

class PDFExtractor:
    """Извлекает текст с координатами, определяет скан, сохраняет структуру"""

    # Regex для СНиП структуры
    CHAPTER_RE = re.compile(r'^\s*(Глава|Раздел|РАЗДЕЛ|ГЛАВА)\s+(\d+)[\.\s]+(.+)', re.IGNORECASE)
    PARAGRAPH_RE = re.compile(r'^\s*(\d+(?:\.\d+){1,4})[\.\)\s]+(.+)')
    TABLE_RE = re.compile(r'^\s*Таблица\s+(\d+)', re.IGNORECASE)

    def extract(self, pdf_path: Path) -> ExtractedDoc:
        doc = fitz.open(str(pdf_path))
        pages: List[PageText] = []
        total_text_len = 0
        for i, page in enumerate(doc):
            text = page.get_text("text", flags=fitz.TEXTFLAGS_TEXT)
            # Also try to preserve reading order
            if not text.strip():
                # try blocks
                blocks = page.get_text("blocks")
                text = "\n".join(b[4] for b in blocks if len(b) > 4 and b[4].strip())
            has_text = len(text.strip()) > 50
            total_text_len += len(text.strip())
            pages.append(PageText(page_num=i+1, text=text, has_text=has_text))
        doc.close()

        # heuristic: scanned if <30% pages have text or avg <100 chars
        scanned_ratio = sum(1 for p in pages if p.has_text) / max(1, len(pages))
        avg_len = total_text_len / max(1, len(pages))
        is_scanned = scanned_ratio < 0.3 or avg_len < 100

        # metadata
        try:
            doc2 = fitz.open(str(pdf_path))
            meta = doc2.metadata
            doc2.close()
        except:
            meta = {}

        title = meta.get("title") or pdf_path.stem.replace("_", " ")
        return ExtractedDoc(title=title, pages=pages, total_pages=len(pages), is_scanned=is_scanned, metadata=meta)

    def extract_with_ocr(self, pdf_path: Path, lang: str = "rus+eng") -> ExtractedDoc:
        """Fallback: если скан - используем OCR (требует tesseract)"""
        base = self.extract(pdf_path)
        if not base.is_scanned:
            return base
        # OCR path via pytesseract + pdf2image alternative using fitz pixmap
        try:
            import pytesseract
            from PIL import Image
            import io
            doc = fitz.open(str(pdf_path))
            new_pages = []
            for i, page in enumerate(doc):
                pix = page.get_pixmap(dpi=200)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                try:
                    ocr_text = pytesseract.image_to_string(img, lang=lang)
                except Exception as e:
                    ocr_text = ""
                has_text = len(ocr_text.strip()) > 20
                new_pages.append(PageText(page_num=i+1, text=ocr_text, has_text=has_text))
            doc.close()
            return ExtractedDoc(title=base.title, pages=new_pages, total_pages=len(new_pages), is_scanned=True, metadata=base.metadata)
        except ImportError:
            # tesseract not installed, return base
            return base

    def detect_structure(self, page_text: str) -> Dict[str, Optional[str]]:
        """Определяет chapter/section/paragraph для строки"""
        result = {}
        m = self.CHAPTER_RE.match(page_text.strip())
        if m:
            result["chapter"] = f"{m.group(1)} {m.group(2)} {m.group(3)}"
        m2 = self.PARAGRAPH_RE.match(page_text.strip())
        if m2:
            result["paragraph"] = m2.group(1)
            result["paragraph_text"] = m2.group(2)
        m3 = self.TABLE_RE.match(page_text.strip())
        if m3:
            result["type"] = "table"
            result["table_num"] = m3.group(1)
        return result
