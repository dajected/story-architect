import { useMemo, useState } from 'react';
import type { PromptTemplate, PromptTemplateKind } from '@shared/types';
import { api } from '../api';
import { errorText, formatDate } from '../utils';
import { Banner, Modal, Spinner } from './ui';

const PLACEHOLDERS = [
  'project_title',
  'premise',
  'genre',
  'tone',
  'pov',
  'tense',
  'style_notes',
  'content_preferences',
  'instructions',
  'chapter_count',
  'target_chapter_words',
  'chapter_number',
  'chapter_title',
  'chapter_brief',
  'target_words',
  'story_memory',
  'recent_prose',
  'additional_instructions',
  'context_preset',
];

interface EditorState {
  template: PromptTemplate | null;
  kind: PromptTemplateKind;
  name: string;
  content: string;
  isDefault: boolean;
}

export function TemplateManager({
  templates,
  projectId,
  onChanged,
}: {
  templates: PromptTemplate[];
  projectId: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visible = useMemo(
    () => (projectId ? templates.filter((template) => template.projectId === projectId || template.projectId === null) : templates.filter((template) => template.projectId === null)),
    [templates, projectId],
  );

  const openNew = () => {
    setEditor({
      template: null,
      kind: 'prose',
      name: '',
      content: '',
      isDefault: false,
    });
    setError(null);
  };

  const openEdit = (template: PromptTemplate) => {
    setEditor({
      template,
      kind: template.kind,
      name: template.name,
      content: template.content,
      isDefault: template.isDefault,
    });
    setError(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      if (editor.template) {
        await api.updateTemplate(editor.template.id, {
          name: editor.name,
          content: editor.content,
          isDefault: editor.isDefault,
        });
        setNotice('Template saved.');
      } else {
        await api.createTemplate({
          projectId,
          kind: editor.kind,
          name: editor.name,
          content: editor.content,
          isDefault: editor.isDefault,
        });
        setNotice('Template created.');
      }
      setEditor(null);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const makeDefault = async (template: PromptTemplate) => {
    setError(null);
    try {
      await api.setDefaultTemplate(template.id);
      setNotice(`"${template.name}" is now the default ${template.kind} prompt.`);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (template: PromptTemplate) => {
    if (!window.confirm(`Delete the prompt template "${template.name}"?`)) return;
    setError(null);
    try {
      await api.deleteTemplate(template.id);
      setNotice('Template deleted.');
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="template-manager">
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}
      <div className="section-toolbar">
        <p className="muted">
          Prompt templates are editable. The default template for each task is used unless a
          project-level default overrides it.
        </p>
        <button className="button button-small" type="button" onClick={openNew}>
          New template
        </button>
      </div>

      {(['outline', 'prose'] as PromptTemplateKind[]).map((kind) => {
        const list = visible.filter((template) => template.kind === kind);
        return (
          <div className="template-group" key={kind}>
            <h4>{kind === 'outline' ? 'Outlining' : 'Prose generation'}</h4>
            {list.length === 0 ? (
              <p className="muted">No {kind} templates.</p>
            ) : (
              <div className="template-list">
                {list.map((template) => (
                  <div className="template-row" key={template.id}>
                    <div className="template-copy">
                      <div className="template-title">
                        <strong>{template.name}</strong>
                        {template.isDefault ? <span className="badge badge-accent">Default</span> : null}
                        <span className="badge">{template.projectId ? 'Project' : 'Global'}</span>
                      </div>
                      <span className="muted">
                        Updated {formatDate(template.updatedAt)} · {template.content.length.toLocaleString()} characters
                      </span>
                    </div>
                    <div className="row-actions">
                      <button className="button button-ghost button-small" onClick={() => openEdit(template)}>
                        Edit
                      </button>
                      {!template.isDefault ? (
                        <button className="button button-ghost button-small" onClick={() => makeDefault(template)}>
                          Make default
                        </button>
                      ) : null}
                      <button className="button button-danger-ghost button-small" onClick={() => remove(template)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <Modal
        open={editor !== null}
        title={editor?.template ? 'Edit prompt template' : 'New prompt template'}
        subtitle={
          editor?.template
            ? `Editing "${editor.template.name}".`
            : 'Create a reusable prompt preset for this task.'
        }
        onClose={() => setEditor(null)}
        width="wide"
        footer={
          <div className="modal-actions">
            <button className="button button-ghost" type="button" onClick={() => setEditor(null)}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" form="template-form" disabled={saving}>
              {saving ? <Spinner /> : null}
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </div>
        }
      >
        {editor ? (
          <form id="template-form" className="template-form" onSubmit={save}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="template-name">Name</label>
                <input
                  id="template-name"
                  value={editor.name}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  placeholder="e.g. Terse literary prose"
                  autoFocus
                />
              </div>
              <div className="field">
                <label htmlFor="template-kind">Task</label>
                <select
                  id="template-kind"
                  value={editor.kind}
                  disabled={Boolean(editor.template)}
                  onChange={(event) =>
                    setEditor({ ...editor, kind: event.target.value as PromptTemplateKind })
                  }
                >
                  <option value="outline">Outline</option>
                  <option value="prose">Prose</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="template-content">Prompt</label>
              <textarea
                id="template-content"
                rows={18}
                className="code-textarea"
                value={editor.content}
                onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={editor.isDefault}
                  onChange={(event) => setEditor({ ...editor, isDefault: event.target.checked })}
                />
                Make this the default {editor.kind} template {projectId ? 'for this project' : ''}
              </label>
            </div>
            <details className="placeholder-help">
              <summary>Available placeholders</summary>
              <p className="muted">
                Wrap these in double braces. Unknown placeholders become empty text.
              </p>
              <div className="placeholder-list">
                {PLACEHOLDERS.map((placeholder) => (
                  <code key={placeholder}>{`{{${placeholder}}}`}</code>
                ))}
              </div>
            </details>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
