import { useEffect, useRef, useState } from 'react';
import type { Character, CharacterInput, GenerationJob, Project } from '@shared/types';
import { api } from '../api';
import { useJobStream } from '../hooks';
import { errorText, formatDate } from '../utils';
import { ImageStudio } from './ImageStudio';
import { Banner, EmptyState, Modal, Spinner } from './ui';

const EMPTY_FORM: CharacterInput = {
  name: '',
  role: '',
  identity: '',
  appearance: '',
  personality: '',
  goals: '',
  relationships: '',
  notes: '',
};

export function CharactersPanel({
  project,
  onProjectChanged,
  onOpenSettings,
  onOpenImageSettings,
  onOpenTimeline,
}: {
  project: Project;
  onProjectChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenImageSettings: () => void;
  onOpenTimeline: (characterId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: CharacterInput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [studioCharacter, setStudioCharacter] = useState<Character | null>(null);
  const finishedRef = useRef<(job: GenerationJob) => void>(() => {});
  const stream = useJobStream((job) => finishedRef.current(job));
  const outputRef = useRef<HTMLDivElement | null>(null);

  const load = async () => {
    try {
      const data = await api.listCharacters(project.id);
      setCharacters(data.characters);
      setError(null);
      return data;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await api.listCharacters(project.id).catch((err) => {
        if (!cancelled) setError(errorText(err));
        return null;
      });
      if (cancelled) return;
      if (data) {
        setCharacters(data.characters);
        if (data.activeJob) stream.attach(data.activeJob);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    if (stream.output && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [stream.output]);

  useEffect(() => {
    finishedRef.current = (job: GenerationJob) => {
      void (async () => {
        await load();
        await onProjectChanged();
        if (job.status === 'completed') {
          setNotice(
            job.error ??
              'Proposed characters are ready for review. Accept the ones that belong in the cast.',
          );
        } else if (job.status === 'failed') {
          setError(job.error || 'Character casting failed.');
        } else if (job.status === 'cancelled') {
          setNotice('Casting stopped. Nothing was added to the cast.');
        }
      })();
    };
  });

  const propose = async () => {
    setError(null);
    setNotice(null);
    try {
      const job = await api.proposeCharacters(project.id);
      stream.attach(job);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = async () => {
    if (!editing) return;
    const name = (editing.form.name ?? '').trim();
    if (!name) {
      setError('A character name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing.id) await api.updateCharacter(editing.id, editing.form);
      else await api.createCharacter(project.id, editing.form);
      setEditing(null);
      setNotice('Character saved.');
      await load();
      await onProjectChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (id: string, action: 'accept' | 'archive') => {
    setBusyId(id);
    setError(null);
    try {
      if (action === 'accept') await api.acceptCharacter(id);
      else await api.archiveCharacter(id);
      await load();
      await onProjectChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleCharacterUpdated = (updated: Character) => {
    setCharacters((current) =>
      current.map((character) => (character.id === updated.id ? updated : character)),
    );
    setStudioCharacter((current) => (current?.id === updated.id ? updated : current));
  };

  const visible = characters.filter(c => `${c.name} ${c.role} ${c.identity}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'missing' ? !c.portraitUrl : c.status === filter)));
  const active = visible.filter((character) => character.status === 'active');
  const proposed = visible.filter((character) => character.status === 'proposed');
  const archived = visible.filter((character) => character.status === 'archived');

  if (loading) {
    return (
      <div className="cast-panel centered-block">
        <Spinner label="Loading the cast…" />
      </div>
    );
  }

  return (
    <div className="cast-panel">
      <header className="panel-header cast-header">
        <div>
          <p className="eyebrow">Cast</p>
          <h1>Characters</h1>
          <p className="lede">
            Relevant profiles are selected for each chapter. Proposed characters stay out of context
            until you accept them.
          </p>
        </div>
        <div className="cast-header-actions">
          <button
            className="button button-primary"
            onClick={propose}
            disabled={stream.running || project.outlineStatus !== 'approved'}
            title={
              project.outlineStatus === 'approved'
                ? undefined
                : 'Approve the outline before proposing characters.'
            }
          >
            {stream.running ? <Spinner /> : null}
            {stream.running ? 'Casting…' : 'Propose from outline'}
          </button>
          <button
            className="button"
            onClick={() => setEditing({ id: null, form: { ...EMPTY_FORM } })}
          >
            Add character
          </button>
          <button className="button button-ghost button-small" onClick={onOpenSettings}>
            Model settings
          </button>
        </div>
      </header>
        <div className="row-actions"><input type="search" aria-label="Search cast" placeholder="Find a character" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Filter cast" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All characters</option><option value="active">Accepted</option><option value="proposed">Proposed</option><option value="archived">Archived</option><option value="missing">Missing portrait</option></select></div>

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

      {stream.job ? (
        <div className={`stream-panel ${stream.running ? 'running' : ''}`}>
          <div className="stream-head">
            <span className="badge">{stream.job.model}</span>
            <span className="muted small">
              {stream.running ? 'Proposing the cast…' : `Casting ${stream.job.status}`}
            </span>
            {!stream.running ? (
              <button
                className="button button-ghost button-small stream-dismiss"
                onClick={() => stream.reset()}
              >
                Dismiss
              </button>
            ) : null}
          </div>
          {stream.job.error ? <Banner tone="danger">{stream.job.error}</Banner> : null}
          <div className="stream-output" ref={outputRef}>
            {stream.output || (stream.running ? 'Waiting for the model…' : 'No output.')}
          </div>
        </div>
      ) : null}

      {proposed.length > 0 ? (
      <section className="cast-section">
          <div className="cast-section-head">
            <h2>Proposed cast</h2>
            <span className="badge badge-warning">{proposed.length} awaiting review</span>
          </div>
          <div className="cast-grid">
            {proposed.map((character) => (
              <article className="cast-card proposed" key={character.id}>
                <div className="cast-card-head">
                  <div>
                    <h3>{character.name}</h3>
                    <span className="muted small">
                      {character.role || 'Unassigned role'} · proposed from outline
                    </span>
                  </div>
                  <span className="badge badge-warning">Proposal</span>
                </div>
                <p className="muted small character-short-description">{character.identity || character.appearance || 'Add a short identity or appearance in the profile.'}</p><details><summary>Full profile</summary><ProfileSummary character={character} /></details><button className="button button-ghost button-small" onClick={() => onOpenTimeline(character.id)}>Appearance timeline</button>
                <div className="row-actions">
                  <button
                    className="button button-primary button-small"
                    onClick={() => void updateStatus(character.id, 'accept')}
                    disabled={busyId === character.id}
                  >
                    {busyId === character.id ? <Spinner /> : null}
                    Accept into cast
                  </button>
                  <button
                    className="button button-ghost button-small"
                    onClick={() => setEditing({ id: character.id, form: toForm(character) })}
                  >
                    Edit
                  </button>
                  <button
                    className="button button-danger-ghost button-small"
                    onClick={() => void updateStatus(character.id, 'archive')}
                    disabled={busyId === character.id}
                  >
                    Discard
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="cast-section">
        <div className="cast-section-head">
          <h2>The cast</h2>
          <span className="muted small">
            {active.length} active {active.length === 1 ? 'character' : 'characters'}
          </span>
        </div>
        {active.length === 0 ? (
          <EmptyState
            title="No active characters yet"
            actions={
              <>
                <button
                  className="button button-primary"
                  onClick={propose}
                  disabled={stream.running || project.outlineStatus !== 'approved'}
                >
                  Propose from outline
                </button>
                <button
                  className="button"
                  onClick={() => setEditing({ id: null, form: { ...EMPTY_FORM } })}
                >
                  Add manually
                </button>
              </>
            }
          >
            Add the people the story needs. Relevant profiles are selected for chapter context and
            their facts appear in continuity review.
          </EmptyState>
        ) : (
          <div className="cast-grid">
            {active.map((character) => (
              <article className="cast-card" key={character.id}>
                <div className="cast-card-head">
                  <div className="cast-identity">
                    <CharacterPortrait character={character} />
                    <div>
                      <h3>{character.name}</h3>
                      <span className="muted small">
                        {character.role || 'Unassigned role'} · {character.factCount} linked{' '}
                        {character.factCount === 1 ? 'fact' : 'facts'}
                      </span>
                    </div>
                  </div>
                  <span className="badge badge-accent">Active</span>
                </div>
                <p className="muted small character-short-description">{character.identity || character.appearance || 'Add a short identity or appearance in the profile.'}</p><details><summary>Full profile</summary><ProfileSummary character={character} /></details><button className="button button-ghost button-small" onClick={() => onOpenTimeline(character.id)}>Appearance timeline</button>
                <div className="row-actions">
                  <button
                    className="button button-small"
                    onClick={() => setStudioCharacter(character)}
                  >
                    Portrait studio
                  </button>
                  <button
                    className="button button-ghost button-small"
                    onClick={() => setEditing({ id: character.id, form: toForm(character) })}
                  >
                    Edit profile
                  </button>
                  <button
                    className="button button-ghost button-small"
                    onClick={() => void updateStatus(character.id, 'archive')}
                    disabled={busyId === character.id}
                  >
                    Archive
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {archived.length > 0 ? (
      <section className="cast-section">
          <div className="cast-section-head">
            <h2>Archived</h2>
            <span className="muted small">{archived.length}</span>
          </div>
          <div className="archived-list">
            {archived.map((character) => (
              <div key={character.id} className="archived-row">
                <span>{character.name}</span>
                <span className="muted small">Archived {formatDate(character.updatedAt)}</span>
                <button
                  className="button button-ghost button-small"
                  onClick={() => void updateStatus(character.id, 'accept')}
                  disabled={busyId === character.id}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit character' : 'Add a character'}
        subtitle="Only accepted profiles enter chapter context."
        width="wide"
        footer={
          editing ? (
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="button button-primary" onClick={save} disabled={saving}>
                {saving ? <Spinner /> : null}
                {saving ? 'Saving…' : 'Save character'}
              </button>
            </div>
          ) : null
        }
      >
        {editing ? (
          <div className="character-form">
            <div className="form-row">
              <div className="field">
                <label htmlFor="character-name">Name</label>
                <input
                  id="character-name"
                  value={editing.form.name ?? ''}
                  onChange={(event) =>
                    setEditing({ ...editing, form: { ...editing.form, name: event.target.value } })
                  }
                  placeholder="Mara Voss"
                />
              </div>
              <div className="field">
                <label htmlFor="character-role">Role</label>
                <input
                  id="character-role"
                  value={editing.form.role ?? ''}
                  onChange={(event) =>
                    setEditing({ ...editing, form: { ...editing.form, role: event.target.value } })
                  }
                  placeholder="Protagonist, rival, mentor…"
                />
              </div>
            </div>
            <CharacterField
              id="character-identity"
              label="Identity"
              value={editing.form.identity}
              placeholder="Who they are: age, occupation, background."
              onChange={(identity) => setEditing({ ...editing, form: { ...editing.form, identity } })}
            />
            <CharacterField
              id="character-appearance"
              label="Appearance"
              value={editing.form.appearance}
              placeholder="Lasting physical details, clothing, distinguishing features."
              onChange={(appearance) =>
                setEditing({ ...editing, form: { ...editing.form, appearance } })
              }
            />
            <CharacterField
              id="character-personality"
              label="Personality"
              value={editing.form.personality}
              placeholder="Temperament, habits, contradictions, voice."
              onChange={(personality) =>
                setEditing({ ...editing, form: { ...editing.form, personality } })
              }
            />
            <CharacterField
              id="character-goals"
              label="Goals"
              value={editing.form.goals}
              placeholder="What they want, what they fear, what they hide."
              onChange={(goals) => setEditing({ ...editing, form: { ...editing.form, goals } })}
            />
            <CharacterField
              id="character-relationships"
              label="Relationships"
              value={editing.form.relationships}
              placeholder="Family, allies, rivals, debts, and how those change."
              onChange={(relationships) =>
                setEditing({ ...editing, form: { ...editing.form, relationships } })
              }
            />
            <CharacterField
              id="character-notes"
              label="Notes"
              value={editing.form.notes}
              placeholder="Anything else the prose model should keep in mind."
              onChange={(notes) => setEditing({ ...editing, form: { ...editing.form, notes } })}
            />
          </div>
        ) : null}
      </Modal>

      <ImageStudio
        open={studioCharacter !== null}
        project={project}
        character={studioCharacter}
        onClose={() => setStudioCharacter(null)}
        onCharacterUpdated={handleCharacterUpdated}
        onOpenSettings={() => {
          setStudioCharacter(null);
          onOpenSettings();
        }}
        onOpenImageSettings={() => {
          setStudioCharacter(null);
          onOpenImageSettings();
        }}
      />
    </div>
  );
}

function CharacterPortrait({ character }: { character: Character }) {
  if (character.portraitUrl) {
    return (
      <img
        className="cast-portrait-thumb"
        src={character.portraitUrl}
        alt={`${character.name} portrait`}
        loading="lazy"
      />
    );
  }
  return (
    <span className="cast-portrait-placeholder" aria-hidden="true">
      {character.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ProfileSummary({ character }: { character: Character }) {
  const lines = [
    ['Identity', character.identity],
    ['Appearance', character.appearance],
    ['Personality', character.personality],
    ['Goals', character.goals],
    ['Relationships', character.relationships],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;
  if (lines.length === 0) {
    return <p className="muted small">No profile details yet. Edit the character to add them.</p>;
  }
  return (
    <dl className="profile-summary">
      {lines.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CharacterField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string | undefined;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={2}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function toForm(character: Character): CharacterInput {
  return {
    name: character.name,
    role: character.role,
    identity: character.identity,
    appearance: character.appearance,
    personality: character.personality,
    goals: character.goals,
    relationships: character.relationships,
    notes: character.notes,
  };
}
