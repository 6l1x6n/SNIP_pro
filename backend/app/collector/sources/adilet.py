"""
Collector source: adilet.zan.kz and related KZ normative sources.
MVP: fetch list from adilet search page for СН РК / СНиП.

This is a template that can be expanded to handle pagination, auth, etc.
"""
import httpx
import logging
from bs4 import BeautifulSoup
from typing import List, Dict
import re
from urllib.parse import urljoin

logger = logging.getLogger(__name__)

ADILET_SEARCH_URL = "https://adilet.zan.kz/rus/search/docs"
# Alternative: direct listing for СНиП: https://adilet.zan.kz/rus/docs/search?types=...

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SNIP_pro Collector/0.1",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8,kk;q=0.7",
}

class AdiletFetcher:
    def __init__(self, client: httpx.AsyncClient = None):
        self.client = client or httpx.AsyncClient(timeout=30, headers=HEADERS, follow_redirects=True)

    async def search_snip(self, query: str = "СН РК", page: int = 1) -> List[Dict]:
        """
        Search adilet for documents. Returns list of {title, url, number, date, status}
        """
        params = {
            "q": query,
            "page": page,
        }
        try:
            resp = await self.client.get(ADILET_SEARCH_URL, params=params)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "lxml")
            results = []
            # Heuristic: find links to /rus/docs/
            for a in soup.select("a[href*='/rus/docs/']"):
                href = a.get("href")
                title = a.get_text(strip=True)
                if not title or len(title) < 5:
                    continue
                # filter for building norms
                if any(kw in title.upper() for kw in ["СН РК", "СНИП", "СП РК", "ГОСТ", "СТ РК", "СНИП"]):
                    full_url = urljoin("https://adilet.zan.kz", href)
                    # try to extract number
                    m = re.search(r'(СН\s*РК|СП\s*РК|СНиП|ГОСТ)[\s\-]*([\d\.\-]+)', title, re.I)
                    number = m.group(0) if m else title[:50]
                    # check status near link (e.g., "Утратил силу")
                    parent = a.find_parent("div")
                    status_text = parent.get_text() if parent else ""
                    status = "expired" if "утратил" in status_text.lower() else "active"
                    if "заменен" in status_text.lower():
                        status = "replaced"
                    results.append({
                        "title": title,
                        "url": full_url,
                        "number": number,
                        "status": status,
                        "source": "adilet.zan.kz"
                    })
            # dedup by url
            seen = set()
            uniq = []
            for r in results:
                if r["url"] not in seen:
                    seen.add(r["url"])
                    uniq.append(r)
            return uniq[:20]
        except Exception as e:
            logger.warning("adilet fetch error: %s", e)
            return []

    async def download_pdf(self, doc_url: str) -> bytes:
        """
        Given document page URL, try to find PDF link.
        Adilet often has PDF via /rus/docs/pdf or link with .pdf
        """
        try:
            resp = await self.client.get(doc_url)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "lxml")
            # look for pdf links
            for a in soup.select("a[href$='.pdf'], a[href*='.pdf']"):
                pdf_href = a.get("href")
                pdf_url = urljoin("https://adilet.zan.kz", pdf_href)
                r = await self.client.get(pdf_url)
                if r.status_code == 200 and r.headers.get("content-type", "").lower().find("pdf") != -1 or pdf_href.lower().endswith(".pdf"):
                    return r.content
            # fallback: check for button "Скачать"
            for a in soup.select("a"):
                if "скачать" in a.get_text(strip=True).lower() and "pdf" in a.get("href", "").lower():
                    pdf_url = urljoin("https://adilet.zan.kz", a.get("href"))
                    r = await self.client.get(pdf_url)
                    if r.status_code == 200:
                        return r.content
            return None
        except Exception as e:
            logger.warning("adilet download error %s: %s", doc_url, e)
            return None

    async def check_updates(self, known_numbers: List[str]) -> Dict:
        """
        Compare remote list with known_numbers, return {new, updated}
        """
        remote = await self.search_snip("СН РК", page=1)
        remote_numbers = [r["number"] for r in remote]
        new = [r for r in remote if r["number"] not in known_numbers]
        return {"remote": remote, "new": new, "total_remote": len(remote)}
