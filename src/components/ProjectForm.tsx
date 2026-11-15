import { useState } from 'react';
import type { Project } from '@shared/types';
import { POV_OPTIONS, TENSE_OPTIONS } from '@shared/types';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, Spinner } from './ui';

type DraftKey =
  | 'title'
  | 'premise'
  | 'genre'
  | 'tone'
  | 'pov'
  | 'tense'
  | 'chapterCount'
  | 'targetChapterWords'
  | 'styleNotes'
  | 'contentPreferences'
  | 'instructions';

type Draft = Record<DraftKey, string>;

function draftFromProject(project?: Project | null): Draft {
  return {
    title: project?.title ?? '',
    premise: project?.premise ?? '',
    genre: project?.genre ?? '',
    tone: project?.tone ?? '',
    pov: project?.pov ?? '',
    tense: project?.tense ?? '',
    chapterCount: project?.chapterCount ? String(project.chapterCount) : '',
    targetChapterWords: project?.targetChapterWords ? String(project.targetChapterWords) : '',
    styleNotes: project?.styleNotes ?? '',
    contentPreferences: project?.contentPreferences ?? '',
    instructions: project?.instructions ?? '',
  };
}

const SUGGESTABLE: DraftKey[] = [
  'title',
  'premise',
  'genre',
  'tone',
  'pov',
  'tense',
  'chapterCount',
  'targetChapterWords',
  'styleNotes',
  'contentPreferences',
  'instructions',
];

export function ProjectForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Project | null;
  submitLabel: string;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFromProject(initial));
  const [suggesting, setSuggesting] = useState<DraftKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const update = (key: DraftKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const suggest = async (key: DraftKey) => {
    setSuggesting(key);
    setError(null);
    setNotice(null);
    try {
      const suggestionDraft: Record<string, string> = {};
      for (const [field, value] of Object.entries(draft)) {
        if (field !== key && value.trim()) suggestionDraft[field] = value.trim();
      }
      const value = await api.suggest(
        key,
        suggestionDraft,
        draft.chapterCount ? Number(draft.chapterCount) : undefined,
      );
      update(key, value);
      setNotice(`Suggested ${labelFor(key).toLowerCase()}. Edit it freely.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSuggesting(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (initial && !draft.title.trim()) {
      setError('Give the project a title first.');
      return;
    }
    if (!initial && (!draft.premise.trim() || !draft.chapterCount)) {
      setError('Enter a premise and number of chapters to get started.');
      return;
    }
    const chapterCount = draft.chapterCount ? Number(draft.chapterCount) : null;
    const targetChapterWords = draft.targetChapterWords ? Number(draft.targetChapterWords) : null;
    if (chapterCount !== null && (!Number.isFinite(chapterCount) || chapterCount < 1 || chapterCount > 200)) {
      setError('Chapter count must be between 1 and 200.');
      return;
    }
    if (
      targetChapterWords !== null &&
      (!Number.isFinite(targetChapterWords) || targetChapterWords < 100 || targetChapterWords > 20000)
    ) {
      setError('Target chapter length must be between 100 and 20,000 words.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const title = initial ? draft.title.trim() : (await api.suggest('title', { premise: draft.premise.trim(), chapterCount: draft.chapterCount }, chapterCount ?? undefined)).trim();
      if (!title) throw new Error('Could not generate a title. Please try again.');
      await onSubmit({
        title,
        premise: draft.premise,
        genre: draft.genre,
        tone: draft.tone,
        pov: draft.pov,
        tense: draft.tense,
        styleNotes: draft.styleNotes,
        contentPreferences: draft.contentPreferences,
        instructions: draft.instructions,
        chapterCount,
        targetChapterWords,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  if (!initial) return (
    <form className="project-form quick-create" onSubmit={submit}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <div className="quick-create-intro">
        <span className="quick-create-kicker">YOUR STORY STARTS HERE</span>
        <h3>Every great story starts with an idea.</h3>
        <p>Share the spark of your story and choose its length. We'll take care of the rest.</p>
      </div>
      <Field label="Story premise" htmlFor="quick-premise">
        <textarea id="quick-premise" rows={5} value={draft.premise} onChange={(event) => update('premise', event.target.value)} placeholder="A reluctant detective discovers that every missing person in her town has dreamed of the same house..." autoFocus required />
        <p className="quick-create-hint">A few sentences are plenty. What happens, and who is it about?</p>
      </Field>
      <Field label="Number of chapters" htmlFor="quick-chapters">
        <input id="quick-chapters" type="number" min={1} max={200} step={1} value={draft.chapterCount} onChange={(event) => update('chapterCount', event.target.value)} placeholder="e.g. 12" required />
      </Field>
      <div className="quick-create-note">? <span>We'll generate a title and use your premise to guide the outline. You can refine the details later.</span></div>
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="button button-primary" disabled={saving}>{saving ? <Spinner /> : null}{saving ? 'Creating?' : submitLabel}</button>
      </div>
    </form>
  );

  return (
    <form className="project-form" onSubmit={submit}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      <section className="form-section">
        <div className="form-section-heading">
          <h3>The story</h3>
          <p className="muted">Blank fields are left to the AI when the outline is generated.</p>
        </div>
        <Field label="Title" htmlFor="project-title">
          <div className="with-action">
            <input
              id="project-title"
              value={draft.title}
              onChange={(event) => update('title', event.target.value)}
              placeholder="A working title"
              autoFocus
            />
            <SuggestButton field="title" active={suggesting} onClick={suggest} />
          </div>
        </Field>
        <Field label="Premise" htmlFor="project-premise">
          <div className="with-action align-start">
            <textarea
              id="project-premise"
              rows={3}
              value={draft.premise}
              onChange={(event) => update('premise', event.target.value)}
              placeholder="Who wants what, what stands in the way, and why now?"
            />
            <SuggestButton field="premise" active={suggesting} onClick={suggest} />
          </div>
        </Field>
        <details className="optional-story"><summary>Genre and tone (optional)</summary><div className="form-row">
          <Field label="Genre" htmlFor="project-genre">
            <div className="with-action">
              <input
                id="project-genre"
                value={draft.genre}
                onChange={(event) => update('genre', event.target.value)}
                placeholder="e.g. Gothic fantasy"
              />
              <SuggestButton field="genre" active={suggesting} onClick={suggest} />
            </div>
          </Field>
          <Field label="Tone" htmlFor="project-tone">
            <div className="with-action">
              <input
                id="project-tone"
                value={draft.tone}
                onChange={(event) => update('tone', event.target.value)}
                placeholder="e.g. wry, intimate, quietly ominous"
              />
              <SuggestButton field="tone" active={suggesting} onClick={suggest} />
            </div>
          </Field>
        </div></details>
      </section>

      <details className="form-section"><summary>Shape and voice (optional)</summary>
        <div className="form-row">
          <Field label="Point of view" htmlFor="project-pov">
            <div className="with-action">
              <select
                id="project-pov"
                value={draft.pov}
                onChange={(event) => update('pov', event.target.value)}
              >
                <option value="">Let the AI suggest</option>
                {draft.pov && !POV_OPTIONS.includes(draft.pov) ? (
                  <option value={draft.pov}>{draft.pov}</option>
                ) : null}
                {POV_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <SuggestButton field="pov" active={suggesting} onClick={suggest} />
            </div>
          </Field>
          <Field label="Tense" htmlFor="project-tense">
            <div className="with-action">
              <select
                id="project-tense"
                value={draft.tense}
                onChange={(event) => update('tense', event.target.value)}
              >
                <option value="">Let the AI suggest</option>
                {draft.tense && !TENSE_OPTIONS.includes(draft.tense) ? (
                  <option value={draft.tense}>{draft.tense}</option>
                ) : null}
                {TENSE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <SuggestButton field="tense" active={suggesting} onClick={suggest} />
            </div>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Chapters" htmlFor="project-chapters">
            <div className="with-action">
              <input
                id="project-chapters"
                type="number"
                min={1}
                max={200}
                value={draft.chapterCount}
                onChange={(event) => update('chapterCount', event.target.value)}
                placeholder="AI decides"
              />
              <SuggestButton field="chapterCount" active={suggesting} onClick={suggest} />
            </div>
          </Field>
          <Field label="Target words per chapter" htmlFor="project-words">
            <div className="with-action">
              <input
                id="project-words"
                type="number"
                min={100}
                max={20000}
                step={100}
                value={draft.targetChapterWords}
                onChange={(event) => update('targetChapterWords', event.target.value)}
                placeholder="AI decides"
              />
              <SuggestButton field="targetChapterWords" active={suggesting} onClick={suggest} />
            </div>
          </Field>
        </div>
        <Field label="Writing style" htmlFor="project-style">
          <div className="with-action align-start">
            <textarea
              id="project-style"
              rows={2}
              value={draft.styleNotes}
              onChange={(event) => update('styleNotes', event.target.value)}
              placeholder="Sentence rhythm, influences, POV depth, things to avoid."
            />
            <SuggestButton field="styleNotes" active={suggesting} onClick={suggest} />
          </div>
        </Field>
        <Field label="Content preferences" htmlFor="project-content">
          <div className="with-action align-start">
            <textarea
              id="project-content"
              rows={2}
              value={draft.contentPreferences}
              onChange={(event) => update('contentPreferences', event.target.value)}
              placeholder="Violence, romance, language, excluding anything."
            />
            <SuggestButton field="contentPreferences" active={suggesting} onClick={suggest} />
          </div>
        </Field>
      </details>

      <details className="form-section"><summary>Standing instructions (optional)</summary>
        <p className="muted">
          Sent with outlining and prose generation. Use it for rules that should always apply.
        </p>
        <Field label="Project instructions" htmlFor="project-instructions">
          <div className="with-action align-start">
            <textarea
              id="project-instructions"
              rows={3}
              value={draft.instructions}
              onChange={(event) => update('instructions', event.target.value)}
              placeholder="e.g. Never kill the dog. Keep chapters under 2,000 words. No dream sequences."
            />
            <SuggestButton field="instructions" active={suggesting} onClick={suggest} />
          </div>
        </Field>
      </details>

      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving ? <Spinner /> : null}
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

function SuggestButton({
  field,
  active,
  onClick,
}: {
  field: DraftKey;
  active: DraftKey | null;
  onClick: (field: DraftKey) => void;
}) {
  return (
    <button
      type="button"
      className="suggest-button"
      onClick={() => onClick(field)}
      disabled={active !== null}
      title="Ask the outline model for a suggestion"
    >
      {active === field ? <Spinner /> : 'Suggest'}
    </button>
  );
}

function labelFor(key: DraftKey): string {
  const labels: Record<DraftKey, string> = {
    title: 'Title',
    premise: 'Premise',
    genre: 'Genre',
    tone: 'Tone',
    pov: 'Point of view',
    tense: 'Tense',
    chapterCount: 'Chapter count',
    targetChapterWords: 'Chapter length',
    styleNotes: 'Writing style',
    contentPreferences: 'Content preferences',
    instructions: 'Project instructions',
  };
  return labels[key];
}

