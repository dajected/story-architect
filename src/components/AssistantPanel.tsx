import { useEffect, useRef, useState } from 'react';
import type { ChapterDetail, ChatMessage, Conversation, GenerationJob, Project } from '@shared/types';
import { api } from '../api';
import { useJobStream } from '../hooks';
import { errorText, formatDate } from '../utils';
import { Markdown } from './Markdown';
import { Banner, Spinner } from './ui';

const PROMPTS = [
  'Brainstorm the next story beat',
  'What is this chapter missing?',
  'Suggest a sharper chapter title',
];

export function AssistantPanel({
  project,
  chapter,
  open,
  onClose,
  onChapterUpdated,
  modelLabel,
}: {
  project: Project;
  chapter: ChapterDetail | null;
  open: boolean;
  onClose: () => void;
  onChapterUpdated: (chapter: ChapterDetail) => void;
  modelLabel: string | null;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const currentConversationRef = useRef<string | null>(null);
  const finishedRef = useRef<(job: GenerationJob) => void>(() => {});
  const stream = useJobStream((job) => finishedRef.current(job));
  currentConversationRef.current = conversationId;

  const scrollToBottom = () => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  const refreshConversations = async () => {
    const list = await api.listConversations(project.id);
    setConversations(list);
    return list;
  };

  const loadMessages = async (id: string, attachJob = true) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getMessages(id);
      setMessages(data.messages);
      if (attachJob && data.activeJob) {
        stream.attach(data.activeJob);
        setSending(true);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  const selectConversation = async (id: string) => {
    stream.reset();
    setConversationId(id);
    setMessages([]);
    setNotice(null);
    setSending(false);
    await loadMessages(id);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listConversations(project.id);
        if (cancelled) return;
        setConversations(list);
        if (list[0]) {
          setConversationId(list[0].id);
          await loadMessages(list[0].id);
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, stream.output, sending]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => scrollToBottom(), 50);
    }
  }, [open]);

  useEffect(() => {
    finishedRef.current = (job: GenerationJob) => {
      setSending(false);
      void (async () => {
        setConversations(await api.listConversations(project.id).catch(() => conversations));
        if (job.conversationId && currentConversationRef.current === job.conversationId) {
          await loadMessages(job.conversationId, false);
          if (job.status === 'failed') {
            setError(job.error || 'The assistant reply failed.');
          }
        }
      })();
    };
  });

  const newConversation = async () => {
    try {
      stream.reset();
      const conversation = await api.createConversation(project.id);
      setConversations((current) => [conversation, ...current]);
      setConversationId(conversation.id);
      setMessages([]);
      setDraft('');
      setNotice(null);
      setError(null);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const removeConversation = async () => {
    if (!conversationId || !window.confirm('Delete this conversation? This cannot be undone.')) return;
    try {
      await api.deleteConversation(conversationId);
      const remaining = conversations.filter((conversation) => conversation.id !== conversationId);
      setConversations(remaining);
      setMessages([]);
      stream.reset();
      if (remaining[0]) {
        await selectConversation(remaining[0].id);
      } else {
        setConversationId(null);
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || stream.running) return;
    setError(null);
    setNotice(null);
    let activeId = conversationId;
    try {
      if (!activeId) {
        const conversation = await api.createConversation(project.id);
        activeId = conversation.id;
        setConversations((current) => [conversation, ...current]);
        setConversationId(conversation.id);
        setMessages([]);
      }
      const result = await api.sendMessage(activeId, text, chapter?.id ?? null);
      setDraft('');
      setSending(true);
      setMessages((current) => [
        ...current,
        {
          id: result.messageId,
          conversationId: activeId!,
          role: 'user',
          content: text,
          incomplete: false,
          jobId: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeId
            ? {
                ...conversation,
                title:
                  conversation.title === 'New conversation'
                    ? text.slice(0, 80)
                    : conversation.title,
                updatedAt: new Date().toISOString(),
              }
            : conversation,
        ),
      );
      stream.attach(result.job);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    } catch (err) {
      setError(errorText(err));
      setSending(false);
    }
  };

  const stop = async () => {
    if (!stream.job) return;
    try {
      await api.cancelJob(stream.job.id);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const applyToChapter = async (message: ChatMessage) => {
    if (!chapter) return;
    if (
      !window.confirm(
        `Append this message to the end of Chapter ${chapter.orderIndex + 1}, "${chapter.title}"?`,
      )
    ) {
      return;
    }
    setInsertingId(message.id);
    setError(null);
    try {
      const detail = await api.appendToChapter(chapter.id, message.content);
      onChapterUpdated(detail);
      setNotice(`Inserted into Chapter ${chapter.orderIndex + 1}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setInsertingId(null);
    }
  };

  return (
    <>
      {open ? <div className="assistant-scrim" onClick={onClose} /> : null}
      <aside className={`assistant-panel ${open ? 'open' : ''}`}>
        <header className="assistant-head">
          <div>
            <p className="eyebrow">Writing assistant</p>
            <h2>Workshop</h2>
          </div>
          <div className="assistant-head-actions">
            <button className="button button-ghost button-small" onClick={newConversation}>
              New chat
            </button>
            <button className="icon-button assistant-close" onClick={onClose} aria-label="Close assistant">
              ×
            </button>
          </div>
        </header>

        <div className="assistant-toolbar">
          <select
            value={conversationId ?? ''}
            onChange={(event) => {
              if (event.target.value) void selectConversation(event.target.value);
            }}
            aria-label="Conversation"
          >
            {conversations.length === 0 ? <option value="">No conversations</option> : null}
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title} ({conversation.messageCount})
              </option>
            ))}
          </select>
          {conversationId ? (
            <button
              className="button button-danger-ghost button-small"
              onClick={removeConversation}
              title="Delete conversation"
            >
              Delete
            </button>
          ) : null}
        </div>

        <div className="assistant-context">
          {chapter ? (
            <span>
              Seeing Chapter {chapter.orderIndex + 1}: <strong>{chapter.title}</strong>
            </span>
          ) : (
            <span>No chapter selected. The approved outline is in context.</span>
          )}
          <span className="muted small">{modelLabel ? `Prose model: ${modelLabel}` : 'Prose model'}</span>
        </div>

        {error ? <Banner tone="danger">{error}</Banner> : null}
        {notice ? <Banner tone="success">{notice}</Banner> : null}

        <div className="assistant-messages" ref={messagesRef}>
          {loading ? (
            <div className="centered-block">
              <Spinner label="Loading conversation…" />
            </div>
          ) : messages.length === 0 && !stream.running ? (
            <div className="assistant-empty">
              <h3>Think out loud</h3>
              <p className="muted">
                Brainstorm, interrogate the outline, or ask for a critique. Messages stay out of
                the manuscript until you explicitly insert them.
              </p>
              <div className="prompt-chips">
                {PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    className="prompt-chip"
                    onClick={() => {
                      setDraft(prompt);
                      window.setTimeout(() => inputRef.current?.focus(), 20);
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <article key={message.id} className={`chat-message chat-${message.role}`}>
                <div className="chat-meta">
                  <span>{message.role === 'assistant' ? 'Assistant' : 'You'}</span>
                  <span className="muted small">{formatDate(message.createdAt)}</span>
                  {message.incomplete ? <span className="badge badge-warning">Incomplete</span> : null}
                </div>
                {message.role === 'assistant' ? (
                  <Markdown text={message.content} />
                ) : (
                  <p className="chat-plain">{message.content}</p>
                )}
                {message.role === 'assistant' ? (
                  <div className="chat-actions">
                    <button
                      className="button button-ghost button-small"
                      onClick={() => applyToChapter(message)}
                      disabled={!chapter || insertingId === message.id}
                      title={chapter ? 'Append to the end of the selected chapter' : 'Select a chapter first'}
                    >
                      {insertingId === message.id ? <Spinner /> : null}
                      Insert into chapter
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          )}

          {sending || stream.running ? (
            <article className="chat-message chat-assistant streaming">
              <div className="chat-meta">
                <span>Assistant</span>
                <span className="muted small">{stream.running ? 'streaming' : 'thinking'}</span>
              </div>
              {stream.output ? (
                <Markdown text={stream.output} />
              ) : (
                <div className="thinking-dots" aria-label="Waiting for the model">
                  <span />
                  <span />
                  <span />
                </div>
              )}
              {stream.running ? (
                <div className="chat-actions">
                  <button className="button button-ghost button-small" onClick={stop}>
                    Stop
                  </button>
                </div>
              ) : null}
            </article>
          ) : null}
        </div>

        <div className="assistant-composer">
          <textarea
            ref={inputRef}
            value={draft}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Ask about the story, the outline, or this chapter…"
          />
          <div className="composer-actions">
            <span className="muted small">Ctrl+Enter to send</span>
            <button
              className="button button-primary button-small"
              onClick={() => void send()}
              disabled={!draft.trim() || sending || stream.running}
            >
              {sending || stream.running ? <Spinner /> : null}
              {sending || stream.running ? 'Working…' : 'Send'}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
