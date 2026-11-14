import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  GenerationHistory,
  GenerationHistoryEntry,
  GenerationJobKind,
  GenerationJobStatus,
  Project,
} from '@shared/types';
import { api } from '../api';
import { errorText, formatDate } from '../utils';
import { Banner, EmptyState, Spinner } from './ui';

const KIND_LABELS: Record<GenerationJobKind, string> = {
  outline: 'Outline',
  chapter: 'Chapter draft',
  chat: 'Assistant',
  memory: 'Memory',
  characters: 'Casting',
  rewrite: 'Rewrite',
  review: 'Continuity review',
  image_prompt: 'Image prompt',
};

const STATUS_FILTERS: Array<{ value: 'all' | GenerationJobStatus; label: string }> = [
  { value: 'all', label: 'All states' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'interrupted', label: 'Interrupted' },
  { value: 'running', label: 'Running now' },
];

export function GenerationHistoryPanel({ project }: { project: Project }) {
  const [history, setHistory] = useState<GenerationHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | GenerationJobKind>('all');
  const [status, setStatus] = useState<'all' | GenerationJobStatus>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setHistory(await api.getGenerationHistory(project.id));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const entries = useMemo(() => {
    if (!history) return [];
    return history.entries.filter(
      (entry) =>
        (kind === 'all' || entry.kind === kind) && (status === 'all' || entry.status === status),
    );
  }, [history, kind, status]);

  if (loading) {
    return (
      <div className="centered-block fill">
        <Spinner label="Reading the generation log…" />
      </div>
    );
  }

  if (!history) {
    return (
      <Banner
        tone="danger"
        actions={
          <button className="button button-small" onClick={() => void load()}>
            Retry
          </button>
        }
      >
        {error ?? 'The generation log could not be loaded.'}
      </Banner>
    );
  }

  return (
    <section className="generation-history">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Project activity</p>
          <h2>Generation log</h2>
          <p className="muted">
            Model, sampling settings, token usage, and an estimated cost where the provider
            publishes pricing. Estimates use the price cached when each job started and are not a
            bill.
          </p>
        </div>
        <button className="button button-ghost button-small" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div className="history-summary">
        <SummaryCard label="Jobs" value={String(history.summary.total)} note={`${history.summary.completed} completed`} />
        <SummaryCard
          label="Prompt tokens"
          value={history.summary.promptTokens.toLocaleString()}
          note="reported by the provider"
        />
        <SummaryCard
          label="Completion tokens"
          value={history.summary.completionTokens.toLocaleString()}
          note="reported by the provider"
        />
        <SummaryCard
          label="Estimated cost"
          value={formatCost(history.summary.estimatedCost)}
          note={
            history.summary.pricedJobs > 0
              ? `${history.summary.pricedJobs} priced job${history.summary.pricedJobs === 1 ? '' : 's'}`
              : 'no cached pricing'
          }
        />
        <SummaryCard
          label="Needs attention"
          value={String(
            history.summary.failed + history.summary.cancelled + history.summary.interrupted,
          )}
          note={`${history.summary.active} running or queued`}
        />
      </div>

      {history.summary.unpricedJobs > 0 ? (
        <p className="field-hint">
          {history.summary.unpricedJobs} job
          {history.summary.unpricedJobs === 1 ? '' : 's'} reported usage without cached model
          pricing, so no cost is shown. Refresh the connection's model list or use OpenRouter to
          collect prices.
        </p>
      ) : null}

      <div className="history-toolbar">
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as 'all' | GenerationJobKind)}
          aria-label="Filter by task"
        >
          <option value="all">All tasks</option>
          {(Object.keys(KIND_LABELS) as GenerationJobKind[]).map((value) => (
            <option key={value} value={value}>
              {KIND_LABELS[value]}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as 'all' | GenerationJobStatus)}
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        <span className="muted small">
          {entries.length} of {history.entries.length} shown, newest first
        </span>
      </div>

      {history.entries.length === 0 ? (
        <EmptyState title="No generations yet">
          Outline, chapter, chat, memory, review, and image-prompt runs appear here once started.
        </EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState title="No jobs match those filters">
          Choose a different task or state.
        </EmptyState>
      ) : (
        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Task</th>
                <th>Model</th>
                <th>Settings</th>
                <th>Tokens</th>
                <th>Est. cost</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HistoryRow({ entry }: { entry: GenerationHistoryEntry }) {
  const tokens =
    entry.usage && (entry.usage.promptTokens !== undefined || entry.usage.completionTokens !== undefined)
      ? `${(entry.usage.promptTokens ?? 0).toLocaleString()} in / ${(
          entry.usage.completionTokens ?? 0
        ).toLocaleString()} out`
      : 'Not reported';
  return (
    <tr>
      <td>
        <div className="history-when">{formatDate(entry.createdAt)}</div>
        <div className="muted small">
          {entry.chapterTitle
            ? `Ch. ${(entry.chapterOrder ?? 0) + 1}: ${entry.chapterTitle}`
            : entry.durationMs !== null
              ? `${(entry.durationMs / 1000).toFixed(1)}s`
              : ''}
        </div>
      </td>
      <td>{KIND_LABELS[entry.kind]}</td>
      <td>
        <div className="history-model">{entry.model}</div>
        <div className="muted small">{entry.connectionName ?? 'removed connection'}</div>
      </td>
      <td>
        <div className="history-settings">{settingsText(entry)}</div>
      </td>
      <td className="history-tokens">
        {tokens}
        {entry.requestBudget ? (
          <details className="small">
            <summary>Context details</summary>
            <p>About {entry.requestBudget.estimatedInputTokens.toLocaleString()} input tokens;
              {' '}{entry.requestBudget.reservedOutputTokens.toLocaleString()} reserved for the reply.</p>
            {!entry.requestBudget.contextLengthKnown ? <p>Model window unknown; using a conservative 16,000-token budget.</p> : null}
            {entry.requestBudget.sections.map((section, index) => (
              <div key={index}>{section.label}: {section.included ? section.trimmed ? 'excerpt' : 'included' : 'omitted'}</div>
            ))}
          </details>
        ) : null}
      </td>
      <td className="history-cost">{formatCost(entry.estimatedCost)}</td>
      <td>
        <span className={`badge ${statusClass(entry.status)}`}>{statusLabel(entry.status)}</span>
        {entry.error ? (
          <div className="history-error" title={entry.error}>
            {entry.error}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function SummaryCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="history-summary-card">
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      <span className="muted small">{note}</span>
    </div>
  );
}

function settingsText(entry: GenerationHistoryEntry): string {
  const settings = entry.settings;
  if (!settings) return '—';
  const parts: string[] = [];
  if (settings.temperature !== null) parts.push(`temp ${settings.temperature}`);
  if (settings.topP !== null) parts.push(`top-p ${settings.topP}`);
  if (settings.maxTokens !== null) parts.push(`max ${settings.maxTokens} tokens`);
  if (settings.contextPreset) parts.push(`${settings.contextPreset} context`);
  if (settings.targetWords) parts.push(`target ${settings.targetWords} words`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function formatCost(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function statusLabel(status: GenerationJobStatus): string {
  if (status === 'queued' || status === 'running') return 'running';
  return status;
}

function statusClass(status: GenerationJobStatus): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed') return 'badge-danger';
  if (status === 'cancelled' || status === 'interrupted') return 'badge-warning';
  return 'badge-accent';
}
