import { useMemo, useState } from 'react';
import type { ImagePromptTemplate } from '@shared/types';
import { IMAGE_TEMPLATE_VARIABLES } from '@shared/types';
import { api } from '../api';
import { errorText, formatDate } from '../utils';
import { Banner, Modal, Spinner } from './ui';

interface EditorState {
  template: ImagePromptTemplate | null;
  name: string;
  content: string;
  isDefault: boolean;
}

export function ImageTemplateManager({
  templates,
  projectId,
  onChanged,
}: {
  templates: ImagePromptTemplate[];
  projectId: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      projectId
        ? templates.filter(
            (template) => template.projectId === projectId || template.projectId === null,
          )
        : templates.filter((template) => template.projectId === null),
    [templates, projectId],
  );

  const openNew = () => {
    setEditor({ template: null, name: '', content: '', isDefault: false });
    setError(null);
  };

  const openEdit = (template: ImagePromptTemplate) => {
    setEditor({
      template,
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
        await api.updateImageTemplate(editor.template.id, {
          name: editor.name,
          content: editor.content,
          isDefault: editor.isDefault,
        });
        setNotice('Image prompt template saved.');
      } else {
        await api.createImageTemplate({
          projectId,
          name: editor.name,
          content: editor.content,
          isDefault: editor.isDefault,
        });
        setNotice('Image prompt template created.');
      }
      setEditor(null);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const makeDefault = async (template: ImagePromptTemplate) => {
    setError(null);
    try {
      await api.setDefaultImageTemplate(template.id);
      setNotice(`"${template.name}" is now the default image prompt template.`);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (template: ImagePromptTemplate) => {
    if (!window.confirm(`Delete the image prompt template "${template.name}"?`)) return;
    setError(null);
    try {
      await api.deleteImageTemplate(template.id);
      setNotice('Image prompt template deleted.');
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
          Image prompt templates are expanded by the image-prompt model before an image service is
          called. The character, scene, clothing, and visual style fill the placeholders.
        </p>
        <button className="button button-small" type="button" onClick={openNew}>
          New image template
        </button>
      </div>

      <div className="template-group">
        <h4>Character image prompts</h4>
        {visible.length === 0 ? (
          <p className="muted">No image prompt templates.</p>
        ) : (
          <div className="template-list">
            {visible.map((template) => (
              <div className="template-row" key={template.id}>
                <div className="template-copy">
                  <div className="template-title">
                    <strong>{template.name}</strong>
                    {template.isDefault ? <span className="badge badge-accent">Default</span> : null}
                    <span className="badge">{template.projectId ? 'Project' : 'Global'}</span>
                  </div>
                  <span className="muted">
                    Updated {formatDate(template.updatedAt)} ·{' '}
                    {template.content.length.toLocaleString()} characters
                  </span>
                </div>
                <div className="row-actions">
                  <button className="button button-ghost button-small" onClick={() => openEdit(template)}>
                    Edit
                  </button>
                  {!template.isDefault ? (
                    <button
                      className="button button-ghost button-small"
                      onClick={() => void makeDefault(template)}
                    >
                      Make default
                    </button>
                  ) : null}
                  <button
                    className="button button-danger-ghost button-small"
                    onClick={() => void remove(template)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={editor !== null}
        title={editor?.template ? 'Edit image prompt template' : 'New image prompt template'}
        subtitle={
          editor?.template
            ? `Editing "${editor.template.name}".`
            : 'Turn character details and a scene into one image prompt.'
        }
        onClose={() => setEditor(null)}
        width="wide"
        footer={
          <div className="modal-actions">
            <button className="button button-ghost" type="button" onClick={() => setEditor(null)}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" form="image-template-form" disabled={saving}>
              {saving ? <Spinner /> : null}
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </div>
        }
      >
        {editor ? (
          <form id="image-template-form" className="template-form" onSubmit={save}>
            <div className="field">
              <label htmlFor="image-template-name">Name</label>
              <input
                id="image-template-name"
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                placeholder="e.g. Painted book-cover portrait"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="image-template-content">Prompt template</label>
              <textarea
                id="image-template-content"
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
                Make this the default image prompt template {projectId ? 'for this project' : ''}
              </label>
            </div>
            <details className="placeholder-help">
              <summary>Available placeholders</summary>
              <p className="muted">
                Wrap these in double braces. Unknown placeholders become empty text.
              </p>
              <div className="placeholder-list">
                {IMAGE_TEMPLATE_VARIABLES.map((variable) => (
                  <code key={variable.name} title={variable.description}>{`{{${variable.name}}}`}</code>
                ))}
              </div>
            </details>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
