import re
from typing import List, Dict, Optional
from dataclasses import dataclass
from pathlib import Path

@dataclass
class RawChunk:
    text: str
    page: int
    chapter: Optional[str] = None
    section: Optional[str] = None
    paragraph: Optional[str] = None
    subparagraph: Optional[str] = None
    type: str = "paragraph"  # paragraph|table
    token_count: Optional[int] = None

class SNIPChunker:
    """
    Разбивает по нормативным пунктам, не режет пункт пополам без overlap.
    Каждый пункт -> 1 chunk, длинные -> sliding window 500 токенов overlap 100.
    Сохраняет номер пункта и страницу.
    """

    PARAGRAPH_RE = re.compile(r'^\s*(\d+(?:\.\d+){1,4})(?:\.|\))?\s+')
    CHAPTER_RE = re.compile(r'^\s*(Глава|Раздел|РАЗДЕЛ|ГЛАВА|Приложение)\s+(\d+|[А-Я])[\.\s]*(.*)', re.IGNORECASE)
    SUBPARA_RE = re.compile(r'^\s*([а-я]\)|\d+\)|\-)\s+')

    # макс токенов на чанк ~ 500 ~ 350-400 слов
    MAX_CHARS = 2000  # примерно 500 токенов
    OVERLAP_CHARS = 400

    def chunk(self, pages_text: List[Dict], base_meta: Dict = None) -> List[RawChunk]:
        """
        pages_text: [{"page":1, "text": "..."}, ...]
        """
        base_meta = base_meta or {}
        # First, join pages and split by paragraph markers
        # Сохраняем актуальные chapter/section
        current_chapter = None
        current_section = None

        raw_blocks: List[RawChunk] = []

        for p in pages_text:
            page_num = p["page"]
            text = p["text"]
            # Split by lines, accumulate paragraph
            lines = text.split("\n")
            acc = ""
            acc_para = None
            acc_chapter = current_chapter
            acc_section = current_section

            for line in lines:
                stripped = line.strip()
                if not stripped:
                    continue
                # Detect chapter
                cm = self.CHAPTER_RE.match(stripped)
                if cm:
                    # flush acc
                    if acc.strip():
                        raw_blocks.extend(self._split_long(acc.strip(), page_num, acc_chapter, acc_section, acc_para))
                        acc = ""
                    current_chapter = stripped[:200]
                    acc_chapter = current_chapter
                    continue
                # Detect paragraph start
                pm = self.PARAGRAPH_RE.match(stripped)
                if pm:
                    # flush previous paragraph
                    if acc.strip():
                        raw_blocks.extend(self._split_long(acc.strip(), page_num, acc_chapter, acc_section, acc_para))
                    acc = stripped
                    acc_para = pm.group(1)
                    # try to extract section from first part?
                    # e.g., 1.2 -> section 1.2?
                    continue
                else:
                    # continuation
                    if acc:
                        acc += " " + stripped
                    else:
                        acc = stripped
                        acc_para = None
            # flush page remainder
            if acc.strip():
                raw_blocks.extend(self._split_long(acc.strip(), page_num, acc_chapter, acc_section, acc_para))

        # Post-process: merge very short chunks (<100 chars) with next if same paragraph
        merged: List[RawChunk] = []
        for c in raw_blocks:
            if c.text and len(c.text) < 80 and merged and merged[-1].paragraph == c.paragraph:
                merged[-1].text += " " + c.text
            else:
                if len(c.text.strip()) >= 30:  # filter noise
                    merged.append(c)

        # Calculate token_count approx
        for m in merged:
            m.token_count = len(m.text.split())

        return merged

    def _split_long(self, text: str, page: int, chapter, section, para) -> List[RawChunk]:
        if len(text) <= self.MAX_CHARS:
            return [RawChunk(text=text, page=page, chapter=chapter, section=section, paragraph=para)]
        # sliding window
        chunks = []
        start = 0
        while start < len(text):
            end = start + self.MAX_CHARS
            slice_text = text[start:end]
            # try to cut at sentence boundary
            if end < len(text):
                # find last period before end
                last_dot = slice_text.rfind(". ")
                if last_dot > self.MAX_CHARS * 0.6:
                    slice_text = slice_text[:last_dot+1]
                    end = start + len(slice_text)
            chunks.append(RawChunk(text=slice_text.strip(), page=page, chapter=chapter, section=section, paragraph=para))
            if end >= len(text):
                break
            start = end - self.OVERLAP_CHARS
        return chunks

    def chunk_extracted(self, extracted) -> List[RawChunk]:
        """Wrapper for ExtractedDoc"""
        pages = [{"page": p.page_num, "text": p.text} for p in extracted.pages]
        return self.chunk(pages, {"title": extracted.title})
