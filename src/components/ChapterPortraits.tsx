import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChapterPortraitOverview,
  ChapterPortraitRequest,
  Character,
  ImageAsset,
} from '@shared/types';
import { api } from '../api';
import { errorText, formatDate } from '../utils';
import { Banner, Spinner } from './ui';

const ACTIVE_STATUS = new Set<ChapterPortraitRequest['status']>(['prompting', 'imaging']);

function statusLabel(status: ChapterPortraitRequest['status']): string {
  if (status === 'prompting') return 'Writing the portrait prompt…';
  if (status === 'imaging') return 'Drawing the portrait…';
  return status;
}

export function ChapterPortraits({
  chapterId,
  revisionKey,
}: {
  chapterId: string;
  revisionKey?: string | null;
}) {
  const [overview, setOverview] = useState<ChapterPortraitOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [otherId, setOtherId] = useState('');
  const previousActive = useRef(0);
  const previousRevision = useRef<string | null | undefined>(revisionKey);

  const load = useCallback(
    async (showSpinner = true) => {
      if (showSpinner) setLoading(true);
      try {
        const data = await api.getChapterPortraits(chapterId);
        setOverview(data);
        setConnectionId((current) =>
          current && data.connections.some((connection) => connection.id === current)
            ? current
            : data.connections[0]?.id ?? '',
        );
        setTemplateId((current) => {
          if (current && data.templates.some((template) => template.id === current)) return current;
          return (
            data.templates.find((template) => template.projectId && template.isDefault)?.id ??
            data.templates.find((template) => template.isDefault)?.id ??
            data.templates[0]?.id ??
            ''
          );
        });
        setError(null);
        return data;
      } catch (err) {
        setError(errorText(err));
        return null;
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [chapterId],
  );

  useEffect(() => {
    setOverview(null);
    setError(null);
    setNotice(null);
    setOtherId('');
    previousActive.current = 0;
    void load(true);
  }, [load]);

  useEffect(() => {
    if (previousRevision.current === revisionKey) return;
    previousRevision.current = revisionKey;
    void load(false);
  }, [revisionKey, load]);

  const activeKey = overview?.activeRequests.map((request) => request.id).join(',') ?? '';

  useEffect(() => {
    if (!activeKey) return;
    const timer = window.setInterval(() => {
      void load(false);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeKey, load]);

  useEffect(() => {
    if (!overview) return;
    const count = overview.activeRequests.length;
    if (previousActive.current > 0 && count === 0 && !error) {
      setNotice('Portrait generation finished. The new image is in the gallery below.');
    }
    previousActive.current = count;
  }, [overview, error]);

  const canGenerate = Boolean(
    overview?.imagePromptRole?.connectionId &&
      overview?.imagePromptRole.model &&
      overview.connections.length > 0,
  );

  const generate = async (characterId: string) => {
    setError(null);
    setNotice(null);
    setBusyKey(characterId);
    try {
      await api.startChapterPortrait(chapterId, {
        characterId,
        connectionId: connectionId || null,
        templateId: templateId || null,
      });
      setOtherId('');
      setNotice('Building the portrait prompt from the chapter’s closing state…');
      await load(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyKey(null);
    }
  };

  const cancel = async (request: ChapterPortraitRequest) => {
    setError(null);
    setBusyKey(request.id);
    try {
      await api.cancelChapterPortrait(request.id);
      setNotice('Portrait generation stopped.');
      await load(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyKey(null);
    }
  };

  const setPortrait = async (character: Character, asset: ImageAsset) => {
    setError(null);
    setBusyKey(asset.id);
    try {
      await api.setCharacterPortrait(character.id, asset.id);
      setNotice(`"${character.name}" now uses this image as the portrait.`);
      await load(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyKey(null);
    }
  };

  const removeAsset = async (asset: ImageAsset) => {
    if (!window.confirm('Delete this image? The saved file and its gallery entry are removed.')) {
      return;
    }
    setError(null);
    setBusyKey(asset.id);
    try {
      await api.deleteImageAsset(asset.id);
      setNotice('Image deleted.');
      await load(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyKey(null);
    }
  };

  const characterById = new Map<string, Character>();
  for (const candidate of overview?.named ?? []) {
    characterById.set(candidate.character.id, candidate.character);
  }
  for (const character of overview?.others ?? []) {
    characterById.set(character.id, character);
  }

  return (
    <section className="chapter-portraits">
      <div className="chapter-portraits-head">
        <div>
          <span className="eyebrow">Character portraits</span>
          <p className="muted small">
            Depict any named character as they look at the end of this chapter — clothing,
            injuries, weariness and all.
          </p>
        </div>
        <button
          className="button button-ghost button-small"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Spinner /> : null}
          Refresh
        </button>
      </div>

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

      {loading && !overview ? (
        <div className="centered-block compact">
          <Spinner label="Reading the chapter’s cast…" />
        </div>
      ) : !overview ? (
        <p className="muted small">Portraits could not be loaded. Refresh to try again.</p>
      ) : !overview.hasText ? (
        <p className="muted small">
          Draft this chapter first. Portraits need the chapter text to show how the cast looks by
          the end.
        </p>
      ) : (
        <>
          {overview.connections.length === 0 ? (
            <Banner tone="warning" title="No image connection">
              Add an image service under Settings → Image service before generating portraits.
            </Banner>
          ) : null}
          {!overview.imagePromptRole?.connectionId || !overview.imagePromptRole.model ? (
            <Banner tone="warning" title="No image-prompt model">
              Assign the image-prompt role, or a default model, in Settings so the portrait prompt
              can be built from the chapter.
            </Banner>
          ) : null}

          {overview.connections.length > 1 || overview.templates.length > 1 ? (
            <div className="portrait-controls">
              {overview.connections.length > 1 ? (
                <div className="field">
                  <label htmlFor="portrait-connection">Image service</label>
                  <select
                    id="portrait-connection"
                    value={connectionId}
                    onChange={(event) => setConnectionId(event.target.value)}
                  >
                    {overview.connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {overview.templates.length > 1 ? (
                <div className="field">
                  <label htmlFor="portrait-template">Prompt template</label>
                  <select
                    id="portrait-template"
                    value={templateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                  >
                    {overview.templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                        {template.isDefault ? ' · default' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}

          {overview.named.length === 0 ? (
            <p className="muted small">
              No cast member is named in this chapter yet. Add characters in the Cast tab, or pick
              one below.
            </p>
          ) : (
            <div className="portrait-cast">
              {overview.named.map(({ character, mentionCount, activeRequest, latestRequest }) => {
                const request =
                  activeRequest ??
                  (latestRequest && ACTIVE_STATUS.has(latestRequest.status) ? latestRequest : null);
                const failed =
                  !request && latestRequest && latestRequest.status !== 'completed'
                    ? latestRequest
                    : null;
                return (
                  <div className="portrait-cast-row" key={character.id}>
                    {character.portraitUrl ? (
                      <img
                        className="portrait-avatar"
                        src={character.portraitUrl}
                        alt={`${character.name} portrait`}
                        loading="lazy"
                      />
                    ) : (
                      <span className="portrait-avatar placeholder" aria-hidden="true">
                        {character.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="portrait-cast-copy">
                      <strong>{character.name}</strong>
                      <span className="muted small">
                        {character.role || (character.status === 'proposed' ? 'Proposed cast' : 'Cast')}
                        {' · '}
                        {mentionCount} mention{mentionCount === 1 ? '' : 's'} in this chapter
                      </span>
                      {request ? (
                        <span className="muted small">{statusLabel(request.status)}</span>
                      ) : failed ? (
                        <span className="error-text small">{failed.error ?? 'Portrait failed.'}</span>
                      ) : null}
                    </div>
                    <div className="portrait-cast-actions">
                      {request ? (
                        <button
                          className="button button-ghost button-small"
                          onClick={() => void cancel(request)}
                          disabled={busyKey === request.id}
                        >
                          {busyKey === request.id ? <Spinner /> : null}
                          Stop
                        </button>
                      ) : (
                        <button
                          className="button button-small"
                          onClick={() => void generate(character.id)}
                          disabled={!canGenerate || busyKey === character.id}
                          title={
                            canGenerate
                              ? undefined
                              : 'Add an image connection and assign the image-prompt role first.'
                          }
                        >
                          {busyKey === character.id ? <Spinner /> : null}
                          Generate portrait
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {overview.others.length > 0 ? (
            <div className="portrait-other">
              <label htmlFor="portrait-other">Generate for another cast member</label>
              <div className="row-actions">
                <select
                  id="portrait-other"
                  value={otherId}
                  onChange={(event) => setOtherId(event.target.value)}
                >
                  <option value="">Choose a character…</option>
                  {overview.others.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}
                      {character.status === 'proposed' ? ' (proposed)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="button button-small"
                  onClick={() => void generate(otherId)}
                  disabled={!otherId || !canGenerate || busyKey === otherId}
                >
                  {busyKey === otherId ? <Spinner /> : null}
                  Generate portrait
                </button>
              </div>
            </div>
          ) : null}

          {overview.assets.length > 0 ? (
            <div className="portrait-results">
              <div className="chapter-portraits-head compact">
                <h3>Images from this chapter</h3>
                <span className="muted small">
                  {overview.assets.length} image{overview.assets.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="image-gallery">
                {overview.assets.map((asset) => {
                  const character = characterById.get(asset.characterId);
                  return (
                    <figure className="image-card" key={asset.id}>
                      <a
                        href={asset.url}
                        target="_blank"
                        rel="noreferrer"
                        className="image-card-image"
                      >
                        <img
                          src={asset.url}
                          alt={`${character?.name ?? 'Character'} at the end of the chapter`}
                          loading="lazy"
                        />
                      </a>
                      <figcaption>
                        <div className="image-card-meta">
                          <strong>{character?.name ?? 'Character'}</strong>
                          <span className="muted small">{formatDate(asset.createdAt)}</span>
                        </div>
                        <details className="image-prompt-details">
                          <summary>Prompt</summary>
                          <p>{asset.prompt}</p>
                        </details>
                        <div className="row-actions">
                          {character ? (
                            <button
                              className="button button-small"
                              onClick={() => void setPortrait(character, asset)}
                              disabled={busyKey === asset.id || character.portraitAssetId === asset.id}
                            >
                              {busyKey === asset.id ? <Spinner /> : null}
                              {character.portraitAssetId === asset.id ? 'Portrait' : 'Set as portrait'}
                            </button>
                          ) : null}
                          <button
                            className="button button-danger-ghost button-small"
                            onClick={() => void removeAsset(asset)}
                            disabled={busyKey === asset.id}
                          >
                            Delete
                          </button>
                        </div>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
