import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Chapter,
  Character,
  CharacterImageOverview,
  GenerationJob,
  ImageAsset,
  ImageJob,
  Project,
} from '@shared/types';
import { api } from '../api';
import { useJobStream } from '../hooks';
import { clampText, errorText, formatDate } from '../utils';
import { Banner, EmptyState, Modal, Spinner } from './ui';
import { ImageGallery } from './ImageGallery';

const TERMINAL_IMAGE_STATUSES = new Set<ImageJob['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function cleanImagePrompt(raw: string): string {
  const cleaned = raw
    .replace(/```[a-z]*\s*/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*(image\s+prompt|prompt)\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  return cleaned || raw.trim();
}

export function ImageStudio({
  open,
  project,
  character,
  onClose,
  onCharacterUpdated,
  onOpenSettings,
  onOpenImageSettings,
  initialChapterId,
  initialAsset,
}: {
  open: boolean;
  initialChapterId?: string;
  initialAsset?: ImageAsset | null;
  project: Project;
  character: Character | null;
  onClose: () => void;
  onCharacterUpdated: (character: Character) => void;
  onOpenSettings: () => void;
  onOpenImageSettings: () => void;
}) {
  const [data, setData] = useState<CharacterImageOverview | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [moment, setMoment] = useState<'start' | 'end' | 'custom'>('end');
  const [referenceId, setReferenceId] = useState('');
  const [sourceRevisionId, setSourceRevisionId] = useState<string | null>(null);
  const [sourceTextHash, setSourceTextHash] = useState<string | undefined>();
  const [scene, setScene] = useState('');
  const [clothing, setClothing] = useState('');
  const [visualStyle, setVisualStyle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [imageJob, setImageJob] = useState<ImageJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const finishedRef = useRef<(job: GenerationJob) => void>(() => {});
  const promptStream = useJobStream((job) => finishedRef.current(job));

  const load = useCallback(
    async (showSpinner = true): Promise<CharacterImageOverview | null> => {
      if (!character) return null;
      if (showSpinner) setLoading(true);
      try {
        const [overview, chapterList] = await Promise.all([
          api.getCharacterImages(character.id),
          api.listChapters(project.id),
        ]);
        setData(overview);
        if (showSpinner) setVisualStyle(overview.visualStyle ?? '');
        setChapters(chapterList);
        setImageJob(overview.activeJob);
        setConnectionId((current) =>
          current && overview.connections.some((connection) => connection.id === current)
            ? current
            : overview.connections[0]?.id ?? '',
        );
        setTemplateId((current) => {
          if (current && overview.templates.some((template) => template.id === current)) {
            return current;
          }
          return (
            overview.templates.find(
              (template) => template.projectId === project.id && template.isDefault,
            )?.id ??
            overview.templates.find((template) => template.isDefault)?.id ??
            overview.templates[0]?.id ??
            ''
          );
        });
        setError(null);
        return overview;
      } catch (err) {
        setError(errorText(err));
        return null;
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [character, project.id],
  );

  useEffect(() => {
    if (!open || !character) {
      promptStream.reset();
      return;
    }
    setError(null);
    setNotice(null);
    setPrompt(initialAsset?.prompt ?? '');
    setChapterId(initialChapterId ?? initialAsset?.chapterId ?? '');
    setMoment(initialAsset?.settings.moment ?? 'end');
    setReferenceId('');
    setSourceRevisionId(initialAsset?.settings.sourceRevisionId ?? null);
    setSourceTextHash(initialAsset?.settings.sourceTextHash);
    setNegativePrompt('');
    setScene('');
    setClothing('');
    setVisualStyle(localStorage.getItem(`image-style-${project.id}`) ?? project.styleNotes);
    setInstructions('');
    setImageJob(null);
    setData(null);
    promptStream.reset();
    void load(true);
    // The form resets when a different character opens the studio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, character?.id]);

  useEffect(() => {
    finishedRef.current = (job: GenerationJob) => {
      if (job.status === 'completed') {
        setPrompt(cleanImagePrompt(job.output));
        setNotice('Image prompt ready. Edit it, then generate the image.');
      } else if (job.status === 'failed') {
        setError(job.error ?? 'Prompt expansion failed.');
      } else if (job.status === 'cancelled') {
        setNotice('Prompt expansion stopped.');
      } else if (job.status === 'interrupted') {
        setError(job.error ?? 'Prompt expansion was interrupted.');
      }
    };
  });

  useEffect(() => {
    if (!imageJob || TERMINAL_IMAGE_STATUSES.has(imageJob.status)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await api.getImageJob(imageJob.id);
          if (cancelled) return;
          setImageJob(next);
          if (TERMINAL_IMAGE_STATUSES.has(next.status)) {
            const overview = await load(false);
            if (overview) onCharacterUpdated(overview.character);
            if (next.status === 'completed') {
              setNotice('Image saved to the gallery.');
              setError(null);
            } else if (next.status === 'failed') {
              setError(next.error ?? 'Image generation failed.');
            } else if (next.status === 'cancelled') {
              setNotice('Image generation cancelled.');
            } else {
              setError(next.error ?? 'Image generation was interrupted.');
            }
          }
        } catch {
          // Transient polling failures keep the last known state.
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [imageJob?.id, imageJob?.status, load, onCharacterUpdated]);

  if (!character) return null;

  const activeJob = imageJob && !TERMINAL_IMAGE_STATUSES.has(imageJob.status) ? imageJob : null;

  const buildPrompt = async () => {
    setError(null);
    setNotice(null);
    setBuilding(true);
    try {
      const detail = chapterId ? await api.getChapter(chapterId) : null;
      setSourceRevisionId(detail?.currentRevisionId ?? null);
      if (detail) {const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(detail.content)); setSourceTextHash(Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join(''));}
      const job = await api.expandImagePrompt(character.id, {
        moment,
        chapterId: chapterId || null,
        templateId: templateId || null,
        scene,
        clothing,
        visualStyle,
        instructions,
      });
      promptStream.attach(job);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBuilding(false);
    }
  };

  const generate = async () => {
    setError(null);
    setNotice(null);
    if (!connectionId) {
      setError('Add an image connection in Settings before generating.');
      return;
    }
    if (!prompt.trim()) {
      setError('Build or write an image prompt first.');
      return;
    }
    const template = data?.templates.find((entry) => entry.id === templateId) ?? null;
    setStarting(true);
    try {
      const job = await api.generateCharacterImage(character.id, {
        connectionId,
        moment,
        sourceRevisionId,
        sourceTextHash,
        referenceAssetId: referenceId || null,
        prompt,
        negativePrompt,
        chapterId: chapterId || null,
        templateId: template?.id ?? null,
        templateName: template?.name ?? null,
        templateContent: template?.content ?? '',
      });
      setImageJob(job);
      setNotice('Image request queued.');
      await load(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (job: ImageJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      setImageJob(await api.cancelImageJob(job.id));
      await load(false);
      setNotice('Image generation cancelled locally.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  const retry = async (job: ImageJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      setImageJob(await api.retryImageJob(job.id));
      await load(false);
      setNotice('Image request retried.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Portrait studio — ${character.name}`}
      subtitle="Expand a saved image template, edit the prompt, then send it to an image service."
      width="wide"
      footer={
        <div className="modal-actions">
          <span className="muted small">
            {data?.character.portraitAssetId
              ? 'A portrait is set for this character.'
              : 'No portrait set yet.'}
          </span>
          <button className="button button-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      {error ? (
        <Banner
          tone="danger"
          actions={
            <button className="button button-small" onClick={() => setError(null)}>
              Dismiss
            </button>
          }
        >
          {error}
        </Banner>
      ) : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      {loading ? (
        <div className="centered-block">
          <Spinner label="Loading character images…" />
        </div>
      ) : !data ? (
        <EmptyState
          title="Could not load this character"
          actions={
            <button className="button" onClick={() => void load(true)}>
              Retry
            </button>
          }
        >
          Check the server connection and try again.
        </EmptyState>
      ) : (
        <div className="image-studio">
          <div className="image-studio-form">
            {data.connections.length === 0 ? (
              <Banner
                tone="warning"
                title="No image connection"
                actions={
                  <button className="button button-small" onClick={onOpenImageSettings}>
                    Open image settings
                  </button>
                }
              >
                Add an OpenAI Images-compatible endpoint or a ComfyUI server under Settings → Image
                service.
              </Banner>
            ) : null}
            {!data.imagePromptRole?.connectionId || !data.imagePromptRole.model ? (
              <Banner
                tone="warning"
                title="No image-prompt model"
                actions={
                  <button className="button button-small" onClick={onOpenSettings}>
                    Open Settings
                  </button>
                }
              >
                Assign the image-prompt role, or a default model, to expand templates with a model.
                You can still write the prompt by hand.
              </Banner>
            ) : (
              <p className="muted small">
                Prompt expansion uses {data.imagePromptRole.connectionName ?? 'connection'} /{' '}
                {data.imagePromptRole.model}.
              </p>
            )}

            <section className="image-studio-section">
              <div className="image-studio-section-head">
<h3>1. Review the appearance and prompt</h3>
                <span className="muted small">Template variables stay editable.</span>
              </div>

              <div className="field"><label htmlFor="studio-moment">Story moment</label><select id="studio-moment" value={moment} onChange={e => {setMoment(e.target.value as typeof moment);setPrompt('');setSourceRevisionId(null);setSourceTextHash(undefined);}}><option value="end">End of chapter</option><option value="start">Start of chapter</option><option value="custom">Custom scene</option></select></div>
              <div className="field"><label htmlFor="studio-reference">Visual identity reference</label><select id="studio-reference" value={referenceId} onChange={e => setReferenceId(e.target.value)} disabled={data.connections.find(c => c.id === connectionId)?.kind !== 'comfyui' || !data.connections.find(c => c.id === connectionId)?.settings.referenceNode}><option value="">Character profile only</option>{data.assets.map(a => <option key={a.id} value={a.id}>{a.id === data.character.portraitAssetId ? 'Main reference portrait' : `Image ${formatDate(a.createdAt)}`}</option>)}</select><p className="field-hint">Image references use a ComfyUI workflow with a configured reference image node. Other services use the written character profile.</p></div>
              <div className="field">
                <label htmlFor="image-studio-template">Image prompt template</label>
                <select
                  id="image-studio-template"
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                >
                  <option value="">Default template (project or global)</option>
                  {data.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                      {template.projectId ? ' (project)' : ' (global)'}
                      {template.isDefault ? ' · default' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <div className="field">
                  <label htmlFor="image-studio-chapter">Chapter state (optional)</label>
                  <select
                    id="image-studio-chapter"
                    value={chapterId}
                    onChange={(event) => {
                      const next = event.target.value;
                      setChapterId(next);
                      setPrompt(''); setSourceRevisionId(null); setSourceTextHash(undefined);
                      const chapter = chapters.find((entry) => entry.id === next);
                      if (chapter && !scene.trim()) setScene(chapter.brief);
                    }}
                  >
                    <option value="">No chapter</option>
                    {chapters.map((chapter, index) => (
                      <option key={chapter.id} value={chapter.id}>
                        {index + 1}. {chapter.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="image-studio-clothing">Clothing or outfit</label>
                  <input
                    id="image-studio-clothing"
                    value={clothing}
                    onChange={(event) => setClothing(event.target.value)}
                    placeholder="e.g. road-worn canvas coat and gloves"
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="image-studio-scene">Scene or moment</label>
                <textarea
                  id="image-studio-scene"
                  rows={3}
                  value={scene}
                  onChange={(event) => setScene(event.target.value)}
                  placeholder="What is happening around the character in this image?"
                />
              </div>

              <div className="field">
                <label htmlFor="image-studio-style">Visual style</label>
                <input
                  id="image-studio-style"
                  value={visualStyle}
                  onChange={(event) => setVisualStyle(event.target.value)}
                  placeholder="e.g. painterly book-cover illustration, warm chiaroscuro"
                />
              </div>

              <div className="field">
                <label htmlFor="image-studio-instructions">Additional instructions</label>
                <textarea
                  id="image-studio-instructions"
                  rows={2}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="Anything the prompt model should include or avoid."
                />
              </div>

              <div className="row-actions">
                <button
                  className="button"
                  onClick={() => void buildPrompt()}
                  disabled={building || promptStream.running}
                >
                  {building || promptStream.running ? <Spinner /> : null}
                  {building || promptStream.running ? 'Building…' : 'Build prompt with model'}
                </button>
              </div>

              {promptStream.job ? (
                <div className={`stream-panel ${promptStream.running ? 'running' : ''}`}>
                  <div className="stream-head">
                    <span className="badge">{promptStream.job.model}</span>
                    <span className="muted small">
                      {promptStream.running
                        ? 'Expanding the image prompt…'
                        : `Prompt expansion ${promptStream.job.status}`}
                    </span>
                    {promptStream.running && promptStream.job ? (
                      <button
                        className="button button-ghost button-small stream-dismiss"
                        onClick={async () => {
                          try {
                            await api.cancelJob(promptStream.job!.id);
                            promptStream.reset();
                            setNotice('Prompt expansion stopped.');
                          } catch (err) {
                            setError(errorText(err));
                          }
                        }}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        className="button button-ghost button-small stream-dismiss"
                        onClick={() => promptStream.reset()}
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                  {promptStream.job.error ? (
                    <Banner tone="danger">{promptStream.job.error}</Banner>
                  ) : null}
                  <div className="stream-output">
                    {promptStream.output || (promptStream.running ? 'Waiting for the model…' : 'No output.')}
                  </div>
                </div>
              ) : null}

              <div className="field">
                <label htmlFor="image-studio-prompt">Final image prompt</label>
                <textarea
                  id="image-studio-prompt"
                  rows={7}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Build a prompt with the model, or write one here."
                />
                <p className="field-hint">
                  This exact text is sent to the image service and saved with the image.
                </p>
              </div>

              <div className="field">
                <label htmlFor="image-studio-negative">Negative prompt (optional)</label>
                <textarea
                  id="image-studio-negative"
                  rows={2}
                  value={negativePrompt}
                  onChange={(event) => setNegativePrompt(event.target.value)}
                  placeholder="e.g. blurry, extra fingers, text, watermark"
                />
              </div>
            </section>

            <section className="image-studio-section">
              <div className="image-studio-section-head">
                <h3>2. Generate the image</h3>
                {activeJob ? <span className="badge badge-warning">{activeJob.status}</span> : null}
              </div>

              <div className="field">
                <label htmlFor="image-studio-connection">Image service</label>
                <select
                  id="image-studio-connection"
                  value={connectionId}
                  onChange={(event) => {setConnectionId(event.target.value);setReferenceId('');}}
                >
                  {data.connections.length === 0 ? <option value="">No connections</option> : null}
                  {data.connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name} ({connection.kind === 'comfyui' ? 'ComfyUI' : 'Images API'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="row-actions">
                <button
                  className="button button-primary"
                  onClick={() => void generate()}
                  disabled={starting || Boolean(activeJob) || !connectionId || !prompt.trim()}
                >
                  {starting || activeJob ? <Spinner /> : null}
                  {starting ? 'Submitting…' : activeJob ? 'Generating…' : 'Generate image'}
                </button>
                {activeJob ? (
                  <button
                    className="button button-ghost"
                    onClick={() => void cancel(activeJob)}
                    disabled={busyId === activeJob.id}
                  >
                    {busyId === activeJob.id ? <Spinner /> : null}
                    Cancel
                  </button>
                ) : null}
              </div>

              {activeJob ? (
                <div className="image-job-status">
                  <span className="badge">{activeJob.status}</span>
                  <span className="muted small">
                    {activeJob.providerKind === 'comfyui'
                      ? `ComfyUI${activeJob.remoteId ? ` · prompt ${activeJob.remoteId}` : ' · submitting workflow'}`
                      : 'Images API'}
                  </span>
                  <p className="muted small">
                    The request is saved on the server. Reopening this studio or refreshing the
                    browser reattaches to it.
                  </p>
                </div>
              ) : null}
            </section>
          </div>

          <div className="image-studio-gallery">
            <div className="image-studio-section-head">
              <h3>Gallery</h3>
              <span className="muted small">
                {data.assets.length} image{data.assets.length === 1 ? '' : 's'}
              </span>
            </div>

            {data.assets.length === 0 ? (
              <EmptyState title="No images yet">
                Build a prompt and generate the first portrait for {character.name}.
              </EmptyState>
            ) : (
              <ImageGallery assets={data.assets} characters={[data.character]} chapters={chapters} onChanged={async () => {const overview=await load(false);if(overview)onCharacterUpdated(overview.character);}} onRegenerate={asset => {setPrompt(asset.prompt); setChapterId(asset.chapterId ?? ''); setSourceRevisionId(asset.settings.sourceRevisionId ?? null); setSourceTextHash(asset.settings.sourceTextHash); setNotice('Prompt loaded. Review it above, then generate an alternative.');}} />
            )}

            {data.jobs.length > 0 ? (
              <section className="image-job-list">
                <h3>Recent generations</h3>
                {data.jobs.map((job) => {
                  const terminal = TERMINAL_IMAGE_STATUSES.has(job.status);
                  return (
                    <div className={`image-job-row ${job.status}`} key={job.id}>
                      <div className="image-job-copy">
                        <div className="image-job-head">
                          <span className={`badge ${job.status === 'completed' ? 'badge-success' : job.status === 'failed' ? 'badge-danger' : 'badge-warning'}`}>
                            {job.status}
                          </span>
                          <span className="muted small">{formatDate(job.createdAt)}</span>
                          {job.remoteId ? (
                            <span className="muted small">remote {job.remoteId}</span>
                          ) : null}
                        </div>
                        <p className="image-job-prompt">{clampText(job.prompt, 220)}</p>
                        {job.error ? <p className="muted small">{job.error}</p> : null}
                      </div>
                      <div className="row-actions">
                        {!terminal ? (
                          <button
                            className="button button-ghost button-small"
                            onClick={() => void cancel(job)}
                            disabled={busyId === job.id}
                          >
                            {busyId === job.id ? <Spinner /> : null}
                            Cancel
                          </button>
                        ) : job.status !== 'completed' ? (
                          <button
                            className="button button-small"
                            onClick={() => void retry(job)}
                            disabled={busyId === job.id || Boolean(activeJob)}
                          >
                            {busyId === job.id ? <Spinner /> : null}
                            Retry
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
