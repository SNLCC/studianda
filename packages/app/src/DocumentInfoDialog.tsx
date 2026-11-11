/**
 * 文献信息弹窗：阅读页直接改当前文献的标题、作者、标签、类型与文件夹。
 *
 * 与文献库里的「重命名 / 编辑作者 / 编辑标签 / 编辑分类」是同一批字段，
 * 只是合并到一处，避免只为改一个标签先退回文献库。字段的落库由调用方拆分调用
 * Core 接口（见 `StudiandaApp` 的 `documentInfoMutation`）。
 */
import {
  DOCUMENT_TYPE_OPTIONS,
  type DocumentSummary,
  type FolderSummary
} from '@studianda/shared';
import { useEffect, useState, type JSX } from 'react';

/** 弹窗提交的草稿：全部是清洗后的最终值，调用方不再二次加工。 */
export interface DocumentInfoDraft {
  name: string;
  author: string;
  tags: string[];
  docType: string;
  folderId: string;
}

export interface DocumentInfoDialogProps {
  document: DocumentSummary;
  folders: FolderSummary[];
  /** 调用方正在保存：按钮禁用，避免重复提交。 */
  saving: boolean;
  /** 调用方保存失败的原因；本地校验错误单独显示。 */
  error: string;
  onClose(): void;
  onSave(draft: DocumentInfoDraft): void;
}

/** 标签上限与 Core 的 setDocumentTags 校验保持一致：50 字、无控制字符。 */
const TAG_MAX_LENGTH = 50;
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

export function DocumentInfoDialog({
  document,
  folders,
  saving,
  error,
  onClose,
  onSave
}: DocumentInfoDialogProps): JSX.Element {
  const [name, setName] = useState(document.name);
  const [author, setAuthor] = useState(document.author);
  const [tags, setTags] = useState<string[]>(() => [...document.tags]);
  const [tagInput, setTagInput] = useState('');
  const [docType, setDocType] = useState(document.docType ?? '');
  const [folderId, setFolderId] = useState(document.folderId ?? '');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /** 校验并追加输入框里的标签；返回是否已加进草稿。 */
  const addTag = (): boolean => {
    const tag = tagInput.trim();
    if (!tag) return false;
    if (CONTROL_CHARACTERS.test(tag)) {
      setLocalError('标签不能包含控制字符。');
      return false;
    }
    if (tag.length > TAG_MAX_LENGTH) {
      setLocalError(`单个标签最多 ${TAG_MAX_LENGTH} 个字符。`);
      return false;
    }
    if (!tags.includes(tag)) setTags([...tags, tag]);
    setTagInput('');
    setLocalError('');
    return true;
  };

  const submit = (): void => {
    if (saving) return;
    const nextName = name.trim();
    if (!nextName) {
      setLocalError('标题不能为空。');
      return;
    }
    // 输入框里还没按 Enter 的标签也一起保存：避免用户以为填了就丢。
    const pendingTag = tagInput.trim();
    const nextTags = [...tags];
    if (pendingTag && !nextTags.includes(pendingTag)) {
      if (CONTROL_CHARACTERS.test(pendingTag) || pendingTag.length > TAG_MAX_LENGTH) {
        setLocalError(`单个标签最多 ${TAG_MAX_LENGTH} 个字符，且不能包含控制字符。`);
        return;
      }
      nextTags.push(pendingTag);
    }
    onSave({
      name: nextName,
      author: author.trim(),
      tags: nextTags,
      docType,
      folderId
    });
  };

  return (
    <div className="kr-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="kr-modal kr-modal--doc-info"
        role="dialog"
        aria-modal="true"
        aria-label="文献信息"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>文献信息</h2>
        <p className="kr-muted" title={document.name}>
          {document.name}
        </p>
        <div className="kr-doc-info">
          <label className="kr-modal__field">
            标题
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setLocalError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <label className="kr-modal__field">
            作者
            <input
              value={author}
              placeholder="多位作者可用分号或逗号分隔"
              onChange={(event) => setAuthor(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <div className="kr-doc-info__row">
            <label className="kr-modal__field">
              文献类型
              <select
                value={docType}
                onChange={(event) => setDocType(event.target.value)}
              >
                <option value="">未分类</option>
                {DOCUMENT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="kr-modal__field">
              所在文件夹
              <select
                value={folderId}
                onChange={(event) => setFolderId(event.target.value)}
              >
                <option value="">未分类</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="kr-modal__field">
            标签
            <div className="kr-tag-editor">
              <div className="kr-tag-editor__chips">
                {tags.length === 0 ? (
                  <span className="kr-doc-info__empty">还没有标签</span>
                ) : null}
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    title={`移除标签「${tag}」`}
                    aria-label={`移除标签 ${tag}`}
                    onClick={() =>
                      setTags((current) => current.filter((item) => item !== tag))
                    }
                  >
                    {tag} ×
                  </button>
                ))}
              </div>
              <div className="kr-tag-editor__input">
                <input
                  value={tagInput}
                  placeholder="输入标签，按 Enter 添加"
                  aria-label="添加标签"
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
                <button type="button" onClick={() => void addTag()}>
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
        <p className="kr-modal__hint">保存后会同步到文献库的分栏、文件夹计数与标签筛选。</p>
        {localError || error ? (
          <p className="kr-modal__error" role="alert">
            {localError || error}
          </p>
        ) : null}
        <div className="kr-modal__actions">
          <button
            type="button"
            className="kr-ghost"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="kr-primary"
            onClick={submit}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
