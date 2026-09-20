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

    # Улучшенные regex — поддерживают 5.8, 5.8.1., 6.12), Приложение А, Таблица 3
    PARAGRAPH_RE = re.compile(r'^\s*(\d+(?:\.\d+){1,4})(?:[\.\)])?\s+')
    CHAPTER_RE = re.compile(r'^\s*(Глава|Раздел|РАЗДЕЛ|ГЛАВА|Приложение|ПРИЛОЖЕНИЕ)\s+(\d+|[А-ЯA-Z])(?:[\.\s]+(.*))?', re.IGNORECASE)
    SUBPARA_RE = re.compile(r'^\s*([а-яa-z]\)|\d+\)|\-)\s+')
    TABLE_RE = re.compile(r'^\s*Таблица\s+(\d+)', re.IGNORECASE)

    # макс токенов на чанк ~ 650 (длиннее для таблиц/больших пунктов)
    MAX_CHARS = 2800
    OVERLAP_CHARS = 600

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
                # Detect table — отдельный чанк тип table (не склеиваем с предыдущим)
                tm = self.TABLE_RE.match(stripped)
                if tm:
                    if acc.strip():
                        raw_blocks.extend(self._split_long(acc.strip(), page_num, acc_chapter, acc_section, acc_para, type_hint="paragraph"))
                        acc = ""
                    # таблица — собираем до следующей главы/параграфа
                    raw_blocks.append(RawChunk(text=stripped, page=page_num, chapter=acc_chapter, section=acc_section, paragraph=acc_para or f"Таблица {tm.group(1)}", type="table"))
                    continue
                # Detect chapter
                cm = self.CHAPTER_RE.match(stripped)
                if cm:
                    # flush acc
                    if acc.strip():
                        raw_blocks.extend(self._split_long(acc.strip(), page_num, acc_chapter, acc_section, acc_para))
                        acc = ""
                    current_chapter = stripped[:250]
                    acc_chapter = current_chapter
                    continue
                # Detect paragraph start
                pm = self.PARAGRAPH_RE.match(stripped)
                if pm:
                    # flush previous paragraph
                    if acc.strip():
                        raw_blocks.extend(self._split_long(acc.strip(), page_num, acc_chapter, acc_section, acc_para))
                    acc = stripped
                    acc_para = pm.group(1).rstrip('.')
                    continue
                else:
                    # continuation — также ловим внутристрочные номера пунктов типа "5.8 Ширина..."
                    # если acc пустой и внутри строки есть паттерн пункта, выделяем его
                    inline_pm = re.match(r'^.*?(\d+\.\d+(?:\.\d+)*)\s+[А-ЯA-Z]', stripped)
                    if not acc and inline_pm:
                        acc = stripped
                        acc_para = inline_pm.group(1)
                    else:
                        if acc:
                            acc += " " + stripped
                        else:
                            acc = stripped
                            acc_para = None
            # flush page remainder
            if acc.strip():
                raw_blocks.extend(self._split_long(acc.strip(), page_num, acc_chapter, acc_section, acc_para))

        # Post-process: merge very short chunks (<100 chars) only if same paragraph
        merged: List[RawChunk] = []
        for c in raw_blocks:
            if c.text and len(c.text) < 100 and merged and merged[-1].paragraph == c.paragraph:
                # не мёржим таблицы и не мёржим разные параграфы
                if c.type != "table" and merged[-1].type != "table" and c.paragraph is not None:
                    merged[-1].text += " " + c.text
                    continue
            # filter noise: tables kept even if short, paragraph headers kept if >=15, others need >=25
            if c.type == "table":
                merged.append(c)
            elif c.paragraph is not None and len(c.text.strip()) >= 15:
                merged.append(c)
            elif len(c.text.strip()) >= 25:
                merged.append(c)

        # Calculate token_count approx
        for m in merged:
            m.token_count = len(m.text.split())

        return merged

    def _split_long(self, text: str, page: int, chapter, section, para, type_hint: str = "paragraph") -> List[RawChunk]:
        if len(text) <= self.MAX_CHARS:
            return [RawChunk(text=text, page=page, chapter=chapter, section=section, paragraph=para, type=type_hint)]
        # sliding window with smart cut at sentence / semicolon
        chunks = []
        start = 0
        while start < len(text):
            end = start + self.MAX_CHARS
            slice_text = text[start:end]
            # try to cut at sentence boundary (. ! ? ; )
            if end < len(text):
                # find last sentence end before limit
                last_dot = max(slice_text.rfind(". "), slice_text.rfind("! "), slice_text.rfind("? "), slice_text.rfind("; "))
                if last_dot > self.MAX_CHARS * 0.55:
                    slice_text = slice_text[:last_dot+1]
                    end = start + len(slice_text)
                else:
                    # fallback: cut at last space to avoid breaking word
                    last_sp = slice_text.rfind(" ")
                    if last_sp > self.MAX_CHARS * 0.8:
                        slice_text = slice_text[:last_sp]
                        end = start + len(slice_text)
            chunks.append(RawChunk(text=slice_text.strip(), page=page, chapter=chapter, section=section, paragraph=para, type=type_hint))
            if end >= len(text):
                break
            start = max(0, end - self.OVERLAP_CHARS)
        return chunks

    def chunk_extracted(self, extracted) -> List[RawChunk]:
        """Wrapper for ExtractedDoc"""
        pages = [{"page": p.page_num, "text": p.text} for p in extracted.pages]
        return self.chunk(pages, {"title": extracted.title})
