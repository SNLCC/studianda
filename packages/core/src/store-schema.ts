/**
 * SQLite schema DDL（从 store.ts 的 migrate() 抽出）。
 * 只包含 CREATE TABLE/INDEX/TRIGGER 的 IF NOT EXISTS 基线；列级增量仍在 store.ts 的 migrate()。
 */
export const SCHEMA_SQL = `      CREATE TABLE IF NOT EXISTS schema_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents(
        id TEXT PRIMARY KEY,
        name TEXT,
        pages INTEGER,
        current_page INTEGER DEFAULT 1,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted INTEGER DEFAULT 0,
        storage_kind TEXT DEFAULT 'copy',
        external_path TEXT DEFAULT '',
        external_key TEXT DEFAULT '',
        file_stamp TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        author TEXT DEFAULT '',
        publication TEXT DEFAULT '',
        doi TEXT DEFAULT '',
        title_key TEXT DEFAULT '',
        sha256 TEXT DEFAULT '',
        size_bytes INTEGER DEFAULT 0,
        path TEXT DEFAULT '',
        doc_type TEXT DEFAULT '',
        folder_id TEXT DEFAULT '',
        manual_order REAL DEFAULT 0
      );

      -- 单层文件夹：文献只归属一个文件夹；folder_id '' 表示「未分类」。
      CREATE TABLE IF NOT EXISTS folders(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- schema_version 10：笔记图片资源登记表 + 引用表（笔记/批注 → 资源）。
      CREATE TABLE IF NOT EXISTS note_assets(
        asset_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        mime TEXT DEFAULT '',
        size_bytes INTEGER DEFAULT 0,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        ref_count INTEGER DEFAULT 0,
        last_referenced TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS note_asset_refs(
        asset_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY(asset_id, source_kind, source_id)
      );

      CREATE INDEX IF NOT EXISTS note_asset_refs_source
        ON note_asset_refs(source_kind, source_id);
      CREATE INDEX IF NOT EXISTS note_asset_refs_asset
        ON note_asset_refs(asset_id);

      CREATE TABLE IF NOT EXISTS annotations(
        id TEXT PRIMARY KEY,
        document_id TEXT,
        page INTEGER,
        quote TEXT,
        content TEXT,
        rects TEXT,
        color TEXT,
        deleted INTEGER DEFAULT 0,
        style TEXT DEFAULT 'highlight',
        translation_excerpt TEXT DEFAULT '',
        external_key TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks(
        id TEXT PRIMARY KEY,
        document_id TEXT,
        page INTEGER,
        text TEXT,
        bbox TEXT,
        bbox_space TEXT DEFAULT 'pdf'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        tokenize = 'trigram'
      );

      CREATE TABLE IF NOT EXISTS vectors(
        chunk_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS embedding_cache(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_cache(
        key TEXT PRIMARY KEY,
        report TEXT NOT NULL,
        updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notes(
        id TEXT PRIMARY KEY,
        document_id TEXT,
        page INTEGER,
        quote TEXT,
        content TEXT,
        external_key TEXT DEFAULT '',
        folder_path TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted INTEGER DEFAULT 0,
        -- schema_version 19：手动排序位置（越小越靠前，只由拖拽排序改变）。
        manual_order REAL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS note_folders(
        path TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages(
        id INTEGER PRIMARY KEY,
        document_id TEXT,
        role TEXT,
        content TEXT,
        sources TEXT,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}',
        session_id TEXT DEFAULT 'legacy'
      );

      -- schema_version 15：阅读伙伴会话正式落表（原先的 settings JSON 清单迁移到这里）。
      -- messages.session_id 取代「从 metadata JSON 里取会话」；旧消息迁移为 legacy。
      CREATE TABLE IF NOT EXISTS document_chat_sessions(
        document_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        updated TEXT DEFAULT CURRENT_TIMESTAMP,
        context_summary TEXT DEFAULT '',
        summary_upto INTEGER DEFAULT 0,
        transcript_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(document_id, id)
      );
      CREATE INDEX IF NOT EXISTS document_chat_sessions_document
        ON document_chat_sessions(document_id, updated);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(document_id, session_id, id);

      -- schema_version 13：独立问答的会话与消息（不依附文献，阅读内 messages 表不变）。
      -- 会话保存完整历史；context_summary/summary_upto 记录「更早轮次压缩摘要」：
      -- summary_upto 及之前的消息不再以原文送进模型，只以摘要形式参与上下文。
      CREATE TABLE IF NOT EXISTS qa_sessions(
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        updated TEXT DEFAULT CURRENT_TIMESTAMP,
        context_summary TEXT DEFAULT '',
        summary_upto INTEGER DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS qa_messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT DEFAULT '',
        response TEXT,
        answered INTEGER DEFAULT 1,
        created TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS qa_messages_session ON qa_messages(session_id, id);
      CREATE INDEX IF NOT EXISTS qa_sessions_updated ON qa_sessions(updated);

      CREATE TABLE IF NOT EXISTS translation_pages(
        document_id TEXT,
        page INTEGER,
        source_hash TEXT,
        engine TEXT,
        status TEXT DEFAULT 'pending',
        error TEXT DEFAULT '',
        done INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        updated TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(document_id, page)
      );

      CREATE TABLE IF NOT EXISTS translation_segments(
        id TEXT PRIMARY KEY,
        document_id TEXT,
        page INTEGER,
        segment INTEGER,
        source TEXT,
        source_hash TEXT,
        text TEXT,
        engine TEXT,
        service TEXT,
        terms TEXT,
        unknown_terms TEXT,
        coverage REAL,
        edited INTEGER DEFAULT 0,
        origin TEXT DEFAULT 'machine',
        previous_text TEXT DEFAULT '',
        previous_origin TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- 同一页同一段只能有一行译文：历史版本按 id upsert + 重译换新 id，会累积重复行，
      -- 表现为界面重复段落、done/total 虚高。先按"人工改稿优先，其次更新时间新者"去重，
      -- 再建唯一索引；索引存在后 ON CONFLICT(document_id,page,segment) 才成立。
      DELETE FROM translation_segments WHERE rowid NOT IN (
        SELECT keep.rowid FROM translation_segments keep
        WHERE NOT EXISTS (
          SELECT 1 FROM translation_segments better
          WHERE better.document_id = keep.document_id
            AND better.page = keep.page
            AND better.segment = keep.segment
            AND better.rowid <> keep.rowid
            AND (
              (better.origin = 'user' AND keep.origin <> 'user')
              OR ((better.origin = 'user') = (keep.origin = 'user')
                  AND IFNULL(better.updated, '') > IFNULL(keep.updated, ''))
              OR ((better.origin = 'user') = (keep.origin = 'user')
                  AND IFNULL(better.updated, '') = IFNULL(keep.updated, '')
                  AND better.rowid > keep.rowid)
            )
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS translation_segments_doc_page_segment
        ON translation_segments(document_id, page, segment);

      CREATE TABLE IF NOT EXISTS page_edits(
        document_id TEXT,
        page INTEGER,
        version TEXT,
        text TEXT,
        origin TEXT,
        boxes TEXT DEFAULT '',
        PRIMARY KEY(document_id, page)
      );

      CREATE TABLE IF NOT EXISTS doc_navigation(
        document_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(document_id, page, kind)
      );

      CREATE TABLE IF NOT EXISTS doc_navigation_state(
        document_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        built_at TEXT,
        source_hash TEXT,
        node_count INTEGER DEFAULT 0,
        last_used TEXT,
        file_stamp TEXT DEFAULT '',
        mask_revision TEXT DEFAULT '',
        build_state TEXT DEFAULT '',
        error TEXT DEFAULT ''
      );

      -- 用户指定的「目录页」：按这些页上的印刷目录生成导航（空 = 按标题规则/PDF 书签）。
      CREATE TABLE IF NOT EXISTS doc_navigation_toc(
        document_id TEXT PRIMARY KEY,
        pages TEXT NOT NULL DEFAULT '[]',
        updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS page_masks(
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        page INTEGER NOT NULL DEFAULT 0,
        x0 REAL NOT NULL,
        y0 REAL NOT NULL,
        x1 REAL NOT NULL,
        y1 REAL NOT NULL,
        created TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reading_tasks(
        task TEXT PRIMARY KEY,
        payload TEXT,
        documents TEXT,
        updated REAL
      );

      CREATE TABLE IF NOT EXISTS checkpoints(
        task TEXT,
        stage TEXT,
        value TEXT,
        documents TEXT,
        updated REAL,
        PRIMARY KEY(task, stage)
      );

      CREATE TABLE IF NOT EXISTS structure_pages(
        path TEXT,
        page INTEGER,
        version TEXT,
        value TEXT,
        PRIMARY KEY(path, page)
      );

      CREATE TABLE IF NOT EXISTS structures(
        document TEXT PRIMARY KEY,
        path TEXT,
        version TEXT,
        value TEXT
      );

      -- 参考文献用户编辑（修改/删除/新增）：识别结果之上的覆盖层。
      -- value 为 JSON（stamp + patch/entry）；识别版本变化后旧编辑视为失效。
      CREATE TABLE IF NOT EXISTS reference_edits(
        document_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        updated TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(document_id, entry_id)
      );

      CREATE TABLE IF NOT EXISTS platform_connections(
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- 视觉读页缓存：按 (文献, 页, 模型, 文档版本) 命中；页面图像转录/解读是派生资料，
      -- 缓存只用于避免重复调用视觉模型，不能当作逐字原文证据。
      CREATE TABLE IF NOT EXISTS visual_cache(
        document_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        model TEXT NOT NULL,
        version TEXT NOT NULL,
        result TEXT NOT NULL,
        updated TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(document_id, page, model, version)
      );

      CREATE INDEX IF NOT EXISTS translation_page ON translation_segments(document_id, page);
      CREATE INDEX IF NOT EXISTS doc_navigation_document ON doc_navigation(document_id, page);
      CREATE INDEX IF NOT EXISTS page_mask_document ON page_masks(document_id, page);

      CREATE INDEX IF NOT EXISTS vectors_model ON vectors(model);
      CREATE INDEX IF NOT EXISTS chunk_document ON chunks(document_id, page);
      CREATE INDEX IF NOT EXISTS annotation_document ON annotations(document_id, page);
      CREATE INDEX IF NOT EXISTS document_deleted ON documents(deleted);
      CREATE INDEX IF NOT EXISTS document_sha256 ON documents(sha256);
      CREATE INDEX IF NOT EXISTS document_external_key ON documents(external_key);

      -- schema_version 14：检索索引版本号。
      -- 用一个单行版本表 + 触发器记录 chunks/派生数据（structures/translation_segments）
      -- 以及文献改名的变化；检索侧的内存倒排索引据此失效，避免返回旧词频/旧文献名。
      CREATE TABLE IF NOT EXISTS retrieval_revision(
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO retrieval_revision(id, value) VALUES (1, 0);

      -- schema_version 17：按文献的检索版本（阅读页索引缓存只受当前文献写入影响）。
      CREATE TABLE IF NOT EXISTS retrieval_document_revision(
        document_id TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );

      CREATE TRIGGER IF NOT EXISTS retrieval_revision_chunks_ai
        AFTER INSERT ON chunks BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_chunks_au
        AFTER UPDATE ON chunks BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_chunks_ad
        AFTER DELETE ON chunks BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_structures_ai
        AFTER INSERT ON structures BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_structures_au
        AFTER UPDATE ON structures BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_structures_ad
        AFTER DELETE ON structures BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_translations_ai
        AFTER INSERT ON translation_segments BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_translations_au
        AFTER UPDATE ON translation_segments BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_translations_ad
        AFTER DELETE ON translation_segments BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_revision_documents_au
        AFTER UPDATE OF name ON documents BEGIN
          UPDATE retrieval_revision SET value = value + 1 WHERE id = 1;
        END;
`;
