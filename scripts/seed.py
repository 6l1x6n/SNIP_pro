"""
Seed script: индексация PDF + синтетические документы
Запуск: /opt/homebrew/bin/python3 scripts/seed.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import asyncio
from app.pipeline.extractor import PDFExtractor
from app.pipeline.chunker import SNIPChunker
from app.embeddings.provider import get_embedding_provider
from app.pipeline.indexer import DocumentIndexer
from app.core.db import AsyncSessionLocal, async_engine, Base
from sqlalchemy import text

async def init_db():
    import os
    if os.getenv("SKIP_DDL", "0") == "1":
        print("SKIP_DDL=1 — пропускаю DDL (таблицы уже созданы)")
        return
    async with async_engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        # регистрируем ВСЕ модели в Base.metadata до create_all (FK documents.owner_id -> users)
        from app.models.user import User  # noqa: F401
        from app.models.pinned import PinnedDocument  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
        try:
            await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING gin (to_tsvector('russian', text))"))
            await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops)"))
        except Exception as e:
            print("index err", e)
    print("db ready")

async def index_pdf():
    pdf = Path(__file__).resolve().parents[1] / "СНиП_1.02.01-85_Инструкция_о_составе_порядке_разраб.pdf"
    if not pdf.exists():
        pdf = Path(__file__).resolve().parents[1] / "backend" / "storage" / "pdfs" / pdf.name
    dest = Path(__file__).resolve().parents[1] / "backend" / "storage" / "pdfs" / pdf.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    import shutil
    if pdf.exists() and pdf != dest:
        shutil.copy(pdf, dest)
        print(f"copied {pdf} -> {dest}")
    extractor = PDFExtractor()
    chunker = SNIPChunker()
    embedder = get_embedding_provider()
    indexer = DocumentIndexer(extractor, chunker, embedder)
    async with AsyncSessionLocal() as db:
        doc = await indexer.index_pdf(db, dest, source_url="file://local", status="active")
        print(f"indexed {doc.number} {doc.id}")

async def seed_demo():
    import uuid
    from datetime import datetime
    from sqlalchemy import select
    from app.models.document import Document, Chunk
    from app.core.db import AsyncSessionLocal
    docs = [
        {
            'number': 'СН РК 3.02-43-2011',
            'title': 'Жилые здания. Строительные нормы Республики Казахстан',
            'type': 'СН РК',
            'status': 'active',
            'source_url': 'https://adilet.zan.kz/rus/docs/V1100006951',
            'chunks': [
                ('5.8', 42, 'Ширина коридоров в жилых зданиях должна быть не менее 1,4 м при длине коридора до 10 м и не менее 1,6 м при большей длине. Ширина коридоров, ведущих к эвакуационным выходам, должна быть не менее 1,2 м.'),
                ('5.9', 42, 'Ширина эвакуационных путей и выходов должна обеспечивать беспрепятственное движение людей. Минимальная ширина эвакуационного выхода из помещения — 0,9 м, из здания — 1,2 м. Высота эвакуационных путей в свету — не менее 2,0 м.'),
                ('6.12', 55, 'Лестничные клетки в жилых зданиях должны иметь ширину марша не менее 1,05 м. Ширина лестничной площадки — не менее ширины марша. Уклон марша — не более 1:1,5.'),
                ('7.3', 60, 'Минимальная высота жилых помещений от пола до потолка — 2,5 м, в климатических районах с повышенной влажностью — 2,7 м. Высота коридоров и холлов — не менее 2,1 м.'),
            ]
        },
        {
            'number': 'СП РК 3.02-101-2012',
            'title': 'Общественные здания и сооружения. Свод правил Республики Казахстан',
            'type': 'СП РК',
            'status': 'active',
            'chunks': [
                ('4.15', 28, 'Ширина коридоров в общественных зданиях при двустороннем расположении помещений — не менее 1,5 м, при одностороннем — не менее 1,3 м. Ширина проходов, ведущих к эвакуационным выходам, — не менее 1,2 м.'),
                ('4.16', 28, 'Ширина эвакуационных коридоров, по которым могут эвакуироваться более 50 человек, должна быть не менее 1,2 м. Двери на путях эвакуации должны открываться по направлению выхода.'),
                ('5.22', 35, 'Минимальная ширина лестничного марша в общественных зданиях — 1,35 м для зданий с числом пребывающих более 200 человек, 1,2 м — для остальных. Ширина лестничной площадки — не менее ширины марша.'),
                ('6.4', 40, 'Расстояние между зданиями определяется в зависимости от степени огнестойкости и должно быть не менее 6 м для зданий I-II степени и не менее 8 м для III степени огнестойкости.'),
            ]
        },
        {
            'number': 'СН РК 2.02-01-2014',
            'title': 'Пожарная безопасность зданий и сооружений. Строительные нормы РК',
            'type': 'СН РК',
            'status': 'active',
            'chunks': [
                ('8.1.3', 15, 'Ширина эвакуационных путей должна быть не менее 1,0 м, дверей — не менее 0,8 м. При числе эвакуирующихся более 50 человек ширина прохода — не менее 1,2 м.'),
                ('8.2.1', 16, 'Эвакуационные лестничные клетки должны иметь ширину марша не менее 1,15 м. Двери выходов из лестничных клеток — не менее 0,9 м.'),
                ('9.4', 20, 'Минимальная ширина прохода (коридора) для маломобильных групп населения — 1,5 м, площадки для разворота кресла-коляски — 1,8×1,8 м.'),
            ]
        },
        {
            'number': 'СТ РК 21.01-2019',
            'title': 'Заменённый документ (для демо статуса)',
            'type': 'СТ РК',
            'status': 'replaced',
            'replaced_number': 'СН РК 2.02-01-2014',
            'chunks': [
                ('1.1', 1, 'Данный документ утратил силу и заменён на СН РК 2.02-01-2014 «Пожарная безопасность». Не подлежит применению с 01.01.2015.'),
            ]
        },
    ]
    from app.embeddings.provider import get_embedding_provider
    embedder = get_embedding_provider()
    async with AsyncSessionLocal() as db:
        for doc_data in docs:
            from sqlalchemy import select
            res = await db.execute(select(Document).where(Document.number == doc_data['number']))
            if res.scalar_one_or_none():
                print(f"skip {doc_data['number']}")
                continue
            from datetime import datetime
            doc = Document(number=doc_data['number'], title=doc_data['title'], type=doc_data['type'], status=doc_data['status'], pages=100, source_url=doc_data.get('source_url'), checksum=str(uuid.uuid4()), language='ru', last_checked_at=datetime.utcnow())
            db.add(doc)
            await db.flush()
            print(f"created {doc.number}")
            texts = [c[2] for c in doc_data['chunks']]
            embs = await embedder.embed(texts)
            for (para, page, txt), emb in zip(doc_data['chunks'], embs):
                ch = Chunk(document_id=doc.id, paragraph=para, page=page, text=txt, type='paragraph', embedding=emb, token_count=len(txt.split()))
                db.add(ch)
            await db.commit()
            await db.execute(text("UPDATE chunks SET text_tsv = to_tsvector('russian', coalesce(text,'')) WHERE document_id = :did"), {'did': str(doc.id)})
            await db.commit()
            print(f" -> {len(doc_data['chunks'])} chunks")
            if doc_data.get('replaced_number'):
                res2 = await db.execute(select(Document).where(Document.number == doc_data['replaced_number']))
                repl = res2.scalar_one_or_none()
                if repl:
                    doc.replaced_by_id = repl.id
                    await db.commit()
    print("demo seeding done")

async def main():
    await init_db()
    # only index pdf if not already
    from sqlalchemy import select
    from app.models.document import Document
    from app.core.db import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Document).where(Document.number == "СНИП 1.02.01-85"))
        if not res.scalar_one_or_none():
            await index_pdf()
        else:
            print("СНИП already indexed, skipping")
    await seed_demo()

if __name__ == "__main__":
    asyncio.run(main())
