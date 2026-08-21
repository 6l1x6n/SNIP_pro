import asyncio
import logging
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.db import AsyncSessionLocal
from app.models.document import CollectorLog, Document
from app.collector.sources.adilet import AdiletFetcher
from apscheduler.schedulers.asyncio import AsyncIOScheduler

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()

async def run_collector_job():
    logger.info("collector run at %s", datetime.now(timezone.utc))
    fetcher = AdiletFetcher()
    try:
        async with AsyncSessionLocal() as db:
            # get known numbers
            res = await db.execute(select(Document.number))
            known = [r[0] for r in res.all()]
            result = await fetcher.check_updates(known)
            new = result.get("new", [])
            total = result.get("total_remote", 0)

            # try to download new docs (limit 3 per run to not overload)
            downloaded = 0
            for doc in new[:3]:
                pdf_bytes = await fetcher.download_pdf(doc["url"])
                if pdf_bytes and len(pdf_bytes) > 5000:
                    # save to storage
                    from pathlib import Path
                    from app.config import PDF_DIR
                    import hashlib
                    safe_name = "".join(c if c.isalnum() or c in ".-_" else "_" for c in doc["number"])[:50]
                    pdf_path = PDF_DIR / f"{safe_name}.pdf"
                    pdf_path.write_bytes(pdf_bytes)
                    # index it
                    try:
                        from app.pipeline.extractor import PDFExtractor
                        from app.pipeline.chunker import SNIPChunker
                        from app.embeddings.provider import get_embedding_provider
                        from app.pipeline.indexer import DocumentIndexer
                        extractor = PDFExtractor()
                        chunker = SNIPChunker()
                        embedder = get_embedding_provider()
                        indexer = DocumentIndexer(extractor, chunker, embedder)
                        await indexer.index_pdf(db, pdf_path, source_url=doc["url"], status=doc.get("status","active"))
                        downloaded += 1
                    except Exception as e:
                        logger.warning("index error for %s: %s", doc['number'], e)
                        await db.rollback()

            log = CollectorLog(
                source="adilet.zan.kz",
                status="success",
                details=f"checked {total} remote, new {len(new)}, downloaded {downloaded}",
                documents_found=total,
                documents_new=len(new),
                documents_updated=downloaded
            )
            db.add(log)
            await db.commit()
            logger.info("collector done: %s", log.details)
    except Exception as e:
        logger.error("collector error: %s", e)
        try:
            async with AsyncSessionLocal() as db:
                log = CollectorLog(source="adilet.zan.kz", status="error", details=str(e)[:1000])
                db.add(log)
                await db.commit()
        except Exception as e2:
            logger.error("collector log error: %s", e2)
    finally:
        await fetcher.client.aclose()

def start_scheduler():
    if not scheduler.running:
        scheduler.add_job(run_collector_job, "interval", hours=24, id="collector_daily", replace_existing=True)
        # also run once 30 sec after startup for demo
        scheduler.add_job(run_collector_job, "date", run_date=datetime.now(timezone.utc), id="collector_once")
        scheduler.start()
        logger.info("scheduler started")

def stop_scheduler():
    if scheduler.running:
        scheduler.shutdown()
        logger.info("scheduler stopped")
