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

      -- schema_version 22：逻辑项目（不绑目录，只给文献做逻辑分组）+ 文献链接表。
      -- 文献仍全局唯一（documents）；一个文献可属于多个项目；删项目只删链接、不删文献。
      -- 名称唯一性由 NOCASE 唯一索引保证（大小写不敏感；应用层先查一次给出中文错误，
      -- 唯一索引兜底并发写入，避免把裸 SQLite 约束错误抛给用户）。
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        archived_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS projects_name_unique
        ON projects(name COLLATE NOCASE);

      -- 项目 ↔ 文献链接。外键级联依赖连接上的 PRAGMA foreign_keys = ON（Store 已开启）：
      -- 删项目/删文献时链接自动清掉；应用层同时显式删除，双保险。
      CREATE TABLE IF NOT EXISTS project_documents(
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(project_id, document_id)
      );
      CREATE INDEX IF NOT EXISTS project_documents_document
        ON project_documents(document_id);

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
        -- schema_version 21：内容来源（'ai' = 系统代写的 AI 生成内容，'user' = 用户内容）。
        origin TEXT NOT NULL DEFAULT 'user',
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
        manual_order REAL DEFAULT 0,
        -- schema_version 21：内容来源（'ai' = 系统代写的 AI 生成内容，'user' = 用户内容）。
        origin TEXT NOT NULL DEFAULT 'user'
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

      -- schema_version 23：跨文献（语料）会话。**不改** document_chat_sessions 的主键，
      -- 也不把其 document_id 改成可空：跨篇会话是另一张表，范围冻结在建立时的文献快照
      -- （之后库里的新文献不自动加入）；消息复用 messages，document_id 用空串哨兵
      -- 表示「不属于任何单篇文献」，只靠 session_id 归属。
      CREATE TABLE IF NOT EXISTS corpus_sessions(
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        archived_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS corpus_sessions_updated
        ON corpus_sessions(updated_at);

      -- 会话 ↔ 文献快照。故意不建 documents 外键：文献被移入回收站/彻底删除后，
      -- 这里仍保留当初选择的范围，读取时会跳过该文献并在响应里如实报告（而不是静默缩范围）。
      CREATE TABLE IF NOT EXISTS corpus_session_documents(
        session_id TEXT NOT NULL REFERENCES corpus_sessions(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        PRIMARY KEY(session_id, document_id)
      );
      CREATE INDEX IF NOT EXISTS corpus_session_documents_document
        ON corpus_session_documents(document_id);

      -- schema_version 13：独立问答的会话与消息（不依附文献，阅读内 messages 表不变）。
      -- 会话保存完整历史；context_summary/summary_upto 记录「更早轮次压缩摘要」：
      -- summary_upto 及之前的消息不再以原文送进模型，只以摘要形式参与上下文。

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

      -- schema_version 20：全书摘要缓存（分层：章节块摘要 → 合并后的全书摘要）。
      -- 按内容版本 + 提示词版本复用：文档没变就不重算，旧版本记录直接视为过期。
      CREATE TABLE IF NOT EXISTS book_summaries(
        document_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        block_key TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        pages_from INTEGER NOT NULL DEFAULT 0,
        pages_to INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        content_version TEXT NOT NULL DEFAULT '',
        prompt_version INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        PRIMARY KEY(document_id, scope, block_key)
      );
      CREATE INDEX IF NOT EXISTS book_summaries_document ON book_summaries(document_id);

      -- schema_version 20：选区冻结快照（不可变）。
      -- 用户带选中原文提问时落一条 {text, text_hash, page, revision}；之后 OCR 重跑/页校订
      -- 改写导致旧回答对不上原文时，核验可以把“缺证”归因为「原文已变更」而不是模型编造。
      -- revision = 提问时该页文本的 sha256；原文变化会产生新 revision 的新快照，旧快照不更新。
      CREATE TABLE IF NOT EXISTS selection_snapshots(
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        page INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        revision TEXT NOT NULL DEFAULT '',
        question TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS selection_snapshots_unique
        ON selection_snapshots(document_id, text_hash, revision);
      CREATE INDEX IF NOT EXISTS selection_snapshots_document
        ON selection_snapshots(document_id, created);

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
