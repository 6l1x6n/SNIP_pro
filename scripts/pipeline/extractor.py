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
    table: bool = False  # псевдо-страница: структурированный текст таблицы

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
        table_pages: List[PageText] = []  # таблицы в КОНЦЕ списка страниц — не сдвигают чанки прозы
        for i, page in enumerate(doc):
            # Try blocks sorted by reading order (y, x) for better paragraph preservation
            blocks = page.get_text("blocks")
            # sort blocks top-to-bottom, left-to-right
            try:
                blocks_sorted = sorted([b for b in blocks if len(b) > 4 and b[4].strip()], key=lambda b: (round(b[1]/20), b[0]))
                text_blocks = "\n".join(b[4] for b in blocks_sorted)
            except Exception:
                text_blocks = ""
            text = page.get_text("text", flags=fitz.TEXTFLAGS_TEXT)
            # prefer blocks if longer or text is empty
            if text_blocks and len(text_blocks.strip()) > len(text.strip()) * 0.9:
                text = text_blocks
            if not text.strip() and text_blocks:
                text = text_blocks
            # normalize line breaks, preserve paragraph markers
            # ensure each block on new line
            has_text = len(text.strip()) > 40
            total_text_len += len(text.strip())
            # extract bbox for future highlighting (store first block bbox)
            bbox = None
            if blocks_sorted:
                try:
                    bbox = {"x0": blocks_sorted[0][0], "y0": blocks_sorted[0][1], "x1": blocks_sorted[0][2], "y1": blocks_sorted[0][3]}
                except:
                    bbox = None
            pages.append(PageText(page_num=i+1, text=text, has_text=has_text, bbox=bbox))
            if has_text:
                table_pages.extend(self._page_tables(page, page_num=i + 1, page_text=text))
        doc.close()

        pages.extend(table_pages)

        # heuristic: scanned if <50% pages have text or avg <80 chars (more sensitive than 30%/100)
        scanned_ratio = sum(1 for p in pages if p.has_text) / max(1, len(pages))
        avg_len = total_text_len / max(1, len(pages))
        is_scanned = scanned_ratio < 0.5 or avg_len < 80

        # metadata
        try:
            doc2 = fitz.open(str(pdf_path))
            meta = doc2.metadata
            doc2.close()
        except:
            meta = {}

        title = meta.get("title") or pdf_path.stem.replace("_", " ")
        return ExtractedDoc(title=title, pages=pages, total_pages=len(pages), is_scanned=is_scanned, metadata=meta)

    CAPTION_RE = re.compile(r"(Таблица|Кесте)\s+(\d+(?:\.\d+)*)", re.IGNORECASE)

    def _page_tables(self, page, page_num: int, page_text: str) -> List[PageText]:
        """find_tables → псевдо-страницы со структурированным текстом таблиц.
        Проза страницы НЕ трогается (тексты чанков и кэш эмбеддингов стабильны),
        таблица дополнительно попадает в индекс строками «ячейка | ячейка»."""
        out: List[PageText] = []
        try:
            tabs = page.find_tables()
        except Exception:
            return out
        for ti, tab in enumerate(tabs.tables):
            try:
                rows = tab.extract()
            except Exception:
                continue
            if not rows or len(rows) < 2 or max(len(r) for r in rows) < 2:
                continue
            cells: List[List[str]] = []
            for r in rows:
                clean = [norm_cell(c) for c in r]
                if any(clean):
                    cells.append(clean)
            if len(cells) < 2:
                continue
            width = max(len(r) for r in cells)
            lines = [" | ".join((r + [""] * (width - len(r)))[:width]) for r in cells]
            body = "\n".join(lines)
            if len(body) < 30:
                continue
            m = self.CAPTION_RE.search(page_text)
            caption = f"Таблица {m.group(2)}. " if m else ""
            header = "[Таблица] " + caption + "\n"
            out.append(PageText(page_num=page_num, text=header + body, has_text=True, table=True))
        return out

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


def norm_cell(v) -> str:
    """Ячейка таблицы → однострочный текст без переносов и двойных пробелов."""
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()
