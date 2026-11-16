import { confirmAction } from './ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  LoreEntry,
  LoreEntryInput,
  LoreOverview,
  Lorebook,
  Project,
  ProseInstruction,
} from '@shared/types';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, EmptyState, Modal, Spinner } from './ui';

interface BookDraft {
  id?: string;
  name: string;
  description: string;
}

interface EntryDraft {
  id?: string;
  bookId: string;
  title: string;
  content: string;
  triggers: string;
  enabled: boolean;
  alwaysInclude: boolean;
  priority: number;
}

interface InstructionDraft {
  id?: string;
  name: string;
  text: string;
}

export function LorePanel({ project }: { project: Project }) {
  const [overview, setOverview] = useState<LoreOverview | null>(null);
  const [instructions, setInstructions] = useState<ProseInstruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeBookId, setActiveBookId] = useState<string>('all');
  const [bookDraft, setBookDraft] = useState<BookDraft | null>(null);
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null);
  const [instructionDraft, setInstructionDraft] = useState<InstructionDraft | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [nextOverview, nextInstructions] = await Promise.all([
          api.getLore(project.id),
          api.listProseInstructions(project.id),
        ]);
        setOverview(nextOverview);
        setInstructions(nextInstructions);
        setError(null);
      } catch (err) {
        setError(errorText(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [project.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!overview) return;
    if (activeBookId !== 'all' && !overview.books.some((book) => book.id === activeBookId)) {
      setActiveBookId(overview.books[0]?.id ?? 'all');
    }
  }, [overview, activeBookId]);

  const activeBook = useMemo(
    () => overview?.books.find((book) => book.id === activeBookId) ?? null,
    [overview, activeBookId],
  );

  const visibleEntries = useMemo(() => {
    if (!overview) return [];
    return activeBookId === 'all'
      ? overview.entries
      : overview.entries.filter((entry) => entry.lorebookId === activeBookId);
  }, [overview, activeBookId]);

  const pinnedCount = overview?.pinnedEntryIds.length ?? 0;

  const saveBook = async () => {
    if (!bookDraft) return;
    setBusy(true);
    setError(null);
    try {
      if (bookDraft.id) {
        await api.updateLorebook(project.id, bookDraft.id, {
          name: bookDraft.name,
          description: bookDraft.description,
        });
        setNotice('Lorebook updated.');
      } else {
        const book = await api.createLorebook(project.id, {
          name: bookDraft.name,
          description: bookDraft.description,
        });
        setActiveBookId(book.id);
        setNotice('Lorebook created and attached to this novel.');
      }
      setBookDraft(null);
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const removeBook = async (book: Lorebook) => {
    const message = book.owned
      ? `Delete "${book.name}" and all of its entries? This cannot be undone.`
      : `Detach "${book.name}" from this novel? The shared book and its entries stay in the library.`;
    if (!await confirmAction(message)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteLorebook(project.id, book.id);
      setNotice(
        result.deleted
          ? 'Lorebook deleted.'
          : 'Shared lorebook detached. It can be linked again later.',
      );
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEntry = async () => {
    if (!entryDraft) return;
    setBusy(true);
    setError(null);
    try {
      const input: LoreEntryInput = {
        title: entryDraft.title,
        content: entryDraft.content,
        triggers: parseTriggers(entryDraft.triggers),
        enabled: entryDraft.enabled,
        alwaysInclude: entryDraft.alwaysInclude,
        priority: entryDraft.priority,
      };
      if (entryDraft.id) {
        await api.updateLoreEntry(project.id, entryDraft.id, input);
        setNotice('Lore entry updated.');
      } else {
        await api.createLoreEntry(project.id, entryDraft.bookId, input);
        setNotice('Lore entry added.');
      }
      setEntryDraft(null);
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async (entry: LoreEntry) => {
    if (!await confirmAction(`Delete the lore entry "${entry.title}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteLoreEntry(project.id, entry.id);
      setNotice('Lore entry deleted.');
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleEntry = async (
    entry: LoreEntry,
    patch: { enabled?: boolean; alwaysInclude?: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateLoreEntry(project.id, entry.id, patch);
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (entry: LoreEntry) => {
    if (!overview) return;
    setBusy(true);
    setError(null);
    try {
      const next = new Set(overview.pinnedEntryIds);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      await api.setLorePins(project.id, [...next]);
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const clearPins = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.clearLorePins(project.id);
      setNotice('Pinned entries cleared. Only keyword and always-include entries will activate.');
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const linkBook = async (book: Lorebook) => {
    setBusy(true);
    setError(null);
    try {
      await api.linkLorebook(project.id, book.id);
      setNotice(`"${book.name}" is now attached to this novel.`);
      setActiveBookId(book.id);
      setLinkOpen(false);
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const saveInstruction = async () => {
    if (!instructionDraft) return;
    setBusy(true);
    setError(null);
    try {
      if (instructionDraft.id) {
        await api.updateProseInstruction(project.id, instructionDraft.id, {
          name: instructionDraft.name,
          text: instructionDraft.text,
        });
        setNotice('Saved instruction updated.');
      } else {
        await api.createProseInstruction(project.id, {
          name: instructionDraft.name,
          text: instructionDraft.text,
        });
        setNotice('Instruction saved for reuse.');
      }
      setInstructionDraft(null);
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const removeInstruction = async (instruction: ProseInstruction) => {
    if (!await confirmAction(`Delete the saved instruction "${instruction.name}"?`)) return;
    setBusy(true);
    try {
      await api.deleteProseInstruction(project.id, instruction.id);
      setNotice('Instruction deleted.');
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="lore-panel centered-block">
        <Spinner label="Loading lore…" />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="lore-panel">
        <Banner
          tone="danger"
          actions={
            <button className="button button-small" onClick={() => void load()}>
              Retry
            </button>
          }
        >
          {error ?? 'Lore could not be loaded.'}
        </Banner>
      </div>
    );
  }

  return (
    <div className="lore-panel">
      <header className="panel-header lore-header">
        <div>
          <p className="eyebrow">Lore</p>
          <h1>World notes</h1>
          <p className="lede">
            Save places, rules, and background for your story. Matching entries guide generation; pin an entry to use it in the next draft.
          </p>
        </div>
        <div className="lore-header-actions">
          <button
            className="button button-primary"
            onClick={() => setBookDraft({ name: '', description: '' })}
          >
            New lorebook
          </button>
          {overview.unlinkedBooks.length > 0 ? <button
            className="button"
            onClick={() => setLinkOpen(true)}
            disabled={overview.unlinkedBooks.length === 0}
          >
            Link a book
          </button> : null}
          <button
            className="button button-ghost button-small"
            onClick={() => setInstructionDraft({ name: '', text: '' })}
          >
            New saved instruction
          </button>
        </div>
      </header>

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

      {pinnedCount > 0 ? (
        <Banner
          tone="info"
          title={`${pinnedCount} ${pinnedCount === 1 ? 'entry is' : 'entries are'} pinned for the next generation`}
          actions={
            <button className="button button-small" onClick={clearPins} disabled={busy}>
              Clear pins
            </button>
          }
        >
          Pins are consumed by one chapter generation. The context inspector lists every entry that
          activates, with the reason.
        </Banner>
      ) : null}

      {overview.books.length === 0 ? (
        <EmptyState
          title="No lorebooks yet"
        >
          Group world details, factions, places, and vocabulary into keyword-triggered entries.
          A book can also be shared with other novels.
        </EmptyState>
      ) : (
        <div className="lore-layout">
          <aside className="lore-books">
            <button
              className={`lore-book ${activeBookId === 'all' ? 'active' : ''}`}
              onClick={() => setActiveBookId('all')}
            >
              <span>All entries</span>
              <span className="badge">{overview.entries.length}</span>
            </button>
            {overview.books.map((book) => (
              <button
                key={book.id}
                className={`lore-book ${activeBookId === book.id ? 'active' : ''}`}
                onClick={() => setActiveBookId(book.id)}
              >
                <span>{book.name}</span>
                <span className="badge">{book.entryCount}</span>
              </button>
            ))}
          </aside>

          <section className="lore-entries">
            {activeBook ? (
              <div className="lore-book-head">
                <div>
                  <h2>{activeBook.name}</h2>
                  <p className="muted small">
                    {activeBook.description || 'No description.'}
                    {activeBook.owned ? '' : ' Shared from another novel.'}
                  </p>
                </div>
                <div className="row-actions">
                  <button
                    className="button button-small"
                    onClick={() =>
                      setEntryDraft({
                        bookId: activeBook.id,
                        title: '',
                        content: '',
                        triggers: '',
                        enabled: true,
                        alwaysInclude: false,
                        priority: 50,
                      })
                    }
                  >
                    Add entry
                  </button>
                  <button
                    className="button button-ghost button-small"
                    onClick={() =>
                      setBookDraft({
                        id: activeBook.id,
                        name: activeBook.name,
                        description: activeBook.description,
                      })
                    }
                  >
                    Edit book
                  </button>
                  <button
                    className="button button-danger-ghost button-small"
                    onClick={() => void removeBook(activeBook)}
                    disabled={busy}
                  >
                    {activeBook.owned ? 'Delete' : 'Detach'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="lore-book-head">
                <div>
                  <h2>All entries</h2>
                  <p className="muted small">Every entry attached to this novel.</p>
                </div>
                {overview.books[0] ? (
                  <button
                    className="button button-small"
                    onClick={() =>
                      setEntryDraft({
                        bookId: overview.books[0].id,
                        title: '',
                        content: '',
                        triggers: '',
                        enabled: true,
                        alwaysInclude: false,
                        priority: 50,
                      })
                    }
                  >
                    Add entry
                  </button>
                ) : null}
              </div>
            )}

            {visibleEntries.length === 0 ? (
              <p className="muted small">
                {activeBook
                  ? 'This book has no entries yet. Add one to make it available to generation.'
                  : 'No entries yet.'}
              </p>
            ) : (
              <div className="lore-entry-list">
                {visibleEntries.map((entry) => (
                  <article className={`lore-entry ${entry.enabled ? '' : 'disabled'}`} key={entry.id}>
                    <div className="lore-entry-head">
                      <div>
                        <h3>{entry.title}</h3>
                        <span className="muted small">{entry.lorebookName}</span>
                      </div>
                      <div className="lore-entry-badges">
                        {entry.pinned ? <span className="badge badge-accent">Pinned</span> : null}
                        {entry.alwaysInclude ? (
                          <span className="badge badge-success">Always</span>
                        ) : null}
                        {entry.enabled ? null : <span className="badge">Disabled</span>}
                        <span className="badge">Priority {entry.priority}</span>
                      </div>
                    </div>
                    <p className="lore-entry-copy">{entry.content}</p>
                    <div className="lore-triggers">
                      {entry.triggers.length === 0 ? (
                        <span className="muted small">No keyword triggers.</span>
                      ) : (
                        entry.triggers.map((trigger) => (
                          <span className="lore-trigger" key={trigger}>
                            {trigger}
                          </span>
                        ))
                      )}
                    </div>
                    <div className="row-actions">
                      <button
                        className="button button-small"
                        onClick={() => void togglePin(entry)}
                        disabled={busy || !entry.enabled}
                      >
                        {entry.pinned ? 'Unpin' : 'Pin for next generation'}
                      </button>
                      <button
                        className="button button-ghost button-small"
                        onClick={() =>
                          setEntryDraft({
                            id: entry.id,
                            bookId: entry.lorebookId,
                            title: entry.title,
                            content: entry.content,
                            triggers: entry.triggers.join(', '),
                            enabled: entry.enabled,
                            alwaysInclude: entry.alwaysInclude,
                            priority: entry.priority,
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        className="button button-ghost button-small"
                        onClick={() => void toggleEntry(entry, { alwaysInclude: !entry.alwaysInclude })}
                        disabled={busy}
                      >
                        {entry.alwaysInclude ? 'Stop always including' : 'Always include'}
                      </button>
                      <button
                        className="button button-ghost button-small"
                        onClick={() => void toggleEntry(entry, { enabled: !entry.enabled })}
                        disabled={busy}
                      >
                        {entry.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="button button-danger-ghost button-small"
                        onClick={() => void removeEntry(entry)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <section className="prose-instructions">
        <div className="lore-book-head">
          <div>
            <h2 id="saved-writing-instructions">Saved writing instructions</h2>
            <p className="muted small">
              Reusable notes you can drop into chapter generation or a style rewrite. They never
              change the manuscript by themselves.
            </p>
          </div>
          <button
            className="button button-small"
            onClick={() => setInstructionDraft({ name: '', text: '' })}
          >
            Add instruction
          </button>
        </div>
        {instructions.length === 0 ? (
          <p className="muted small">No saved instructions yet.</p>
        ) : (
          <div className="instruction-list">
            {instructions.map((instruction) => (
              <article className="instruction-card" key={instruction.id}>
                <div>
                  <h3>{instruction.name}</h3>
                  <p className="muted small">{instruction.text}</p>
                </div>
                <div className="row-actions">
                  <button
                    className="button button-ghost button-small"
                    onClick={() =>
                      setInstructionDraft({
                        id: instruction.id,
                        name: instruction.name,
                        text: instruction.text,
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    className="button button-danger-ghost button-small"
                    onClick={() => void removeInstruction(instruction)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={bookDraft !== null}
        onClose={() => setBookDraft(null)}
        title={bookDraft?.id ? 'Edit lorebook' : 'New lorebook'}
        subtitle="A book owns entries and can be linked to more than one novel."
        footer={
          bookDraft ? (
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setBookDraft(null)}>
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={saveBook}
                disabled={busy || !bookDraft.name.trim()}
              >
                {busy ? <Spinner /> : null}
                {bookDraft.id ? 'Save book' : 'Create book'}
              </button>
            </div>
          ) : null
        }
      >
        {bookDraft ? (
          <div className="fact-form">
            <div className="field">
              <label htmlFor="lorebook-name">Name</label>
              <input
                id="lorebook-name"
                value={bookDraft.name}
                onChange={(event) => setBookDraft({ ...bookDraft, name: event.target.value })}
                placeholder="The observatory and the hill"
              />
            </div>
            <div className="field">
              <label htmlFor="lorebook-description">Description</label>
              <textarea
                id="lorebook-description"
                rows={3}
                value={bookDraft.description}
                onChange={(event) =>
                  setBookDraft({ ...bookDraft, description: event.target.value })
                }
                placeholder="What this book covers, and which novels should use it."
              />
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={entryDraft !== null}
        onClose={() => setEntryDraft(null)}
        title={entryDraft?.id ? 'Edit lore entry' : 'New lore entry'}
        subtitle="Keywords match whole words in the brief, extra instructions, and recent prose."
        width="wide"
        footer={
          entryDraft ? (
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setEntryDraft(null)}>
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={saveEntry}
                disabled={
                  busy || !entryDraft.title.trim() || !entryDraft.content.trim()
                }
              >
                {busy ? <Spinner /> : null}
                {entryDraft.id ? 'Save entry' : 'Add entry'}
              </button>
            </div>
          ) : null
        }
      >
        {entryDraft ? (
          <div className="fact-form">
            <div className="field">
              <label htmlFor="lore-title">Title</label>
              <input
                id="lore-title"
                value={entryDraft.title}
                onChange={(event) => setEntryDraft({ ...entryDraft, title: event.target.value })}
                placeholder="The buried observatory"
              />
            </div>
            <div className="field">
              <label htmlFor="lore-content">Text sent to the model</label>
              <textarea
                id="lore-content"
                rows={7}
                value={entryDraft.content}
                onChange={(event) =>
                  setEntryDraft({ ...entryDraft, content: event.target.value })
                }
                placeholder="The observatory was sealed in 1904. Its brass door only opens for a key cut from the same alloy."
              />
            </div>
            <div className="field">
              <label htmlFor="lore-triggers">Keyword triggers</label>
              <input
                id="lore-triggers"
                value={entryDraft.triggers}
                onChange={(event) =>
                  setEntryDraft({ ...entryDraft, triggers: event.target.value })
                }
                placeholder="observatory, brass key, Iven"
              />
              <p className="field-hint">Separate with commas. One word or a phrase each.</p>
            </div>
            <div className="form-row three">
              <div className="field">
                <label htmlFor="lore-priority">Priority (0–100)</label>
                <input
                  id="lore-priority"
                  type="number"
                  min={0}
                  max={100}
                  value={entryDraft.priority}
                  onChange={(event) =>
                    setEntryDraft({
                      ...entryDraft,
                      priority: Number(event.target.value) || 0,
                    })
                  }
                />
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={entryDraft.enabled}
                  onChange={(event) =>
                    setEntryDraft({ ...entryDraft, enabled: event.target.checked })
                  }
                />
                Enabled
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={entryDraft.alwaysInclude}
                  onChange={(event) =>
                    setEntryDraft({ ...entryDraft, alwaysInclude: event.target.checked })
                  }
                />
                Always include
              </label>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Link an existing lorebook"
        subtitle="Shared books stay in their original novel and can be detached at any time."
        footer={
          <div className="modal-actions">
            <button className="button button-ghost" onClick={() => setLinkOpen(false)}>
              Close
            </button>
          </div>
        }
      >
        {overview.unlinkedBooks.length === 0 ? (
          <p className="muted small">Every existing lorebook is already attached to this novel.</p>
        ) : (
          <div className="link-list">
            {overview.unlinkedBooks.map((book) => (
              <div className="link-row" key={book.id}>
                <div>
                  <strong>{book.name}</strong>
                  <span className="muted small">
                    {book.entryCount} {book.entryCount === 1 ? 'entry' : 'entries'}
                  </span>
                </div>
                <button
                  className="button button-small"
                  onClick={() => void linkBook(book)}
                  disabled={busy}
                >
                  Link
                </button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={instructionDraft !== null}
        onClose={() => setInstructionDraft(null)}
        title={instructionDraft?.id ? 'Edit saved instruction' : 'New saved instruction'}
        subtitle="Useful for voice rules you apply repeatedly, such as sentence length or dialogue tags."
        width="wide"
        footer={
          instructionDraft ? (
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setInstructionDraft(null)}>
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={saveInstruction}
                disabled={
                  busy || !instructionDraft.name.trim() || !instructionDraft.text.trim()
                }
              >
                {busy ? <Spinner /> : null}
                {instructionDraft.id ? 'Save instruction' : 'Add instruction'}
              </button>
            </div>
          ) : null
        }
      >
        {instructionDraft ? (
          <div className="fact-form">
            <div className="field">
              <label htmlFor="instruction-name">Name</label>
              <input
                id="instruction-name"
                value={instructionDraft.name}
                onChange={(event) =>
                  setInstructionDraft({ ...instructionDraft, name: event.target.value })
                }
                placeholder="Terse dialogue, long silences"
              />
            </div>
            <div className="field">
              <label htmlFor="instruction-text">Instruction</label>
              <textarea
                id="instruction-text"
                rows={6}
                value={instructionDraft.text}
                onChange={(event) =>
                  setInstructionDraft({ ...instructionDraft, text: event.target.value })
                }
                placeholder="Keep paragraphs under five sentences. Use dialogue to carry exposition. Avoid weather openings."
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function parseTriggers(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}
