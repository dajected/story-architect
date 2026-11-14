import type { ContextInfo, LoreActivationReason } from '@shared/types';

function loreReasonLabel(reason: LoreActivationReason): string {
  if (reason === 'manual') return 'Pinned';
  if (reason === 'always') return 'Always';
  if (reason === 'budget') return 'Over budget';
  return 'Keyword';
}

function loreReasonClass(reason: LoreActivationReason): string {
  if (reason === 'budget') return 'badge-warning';
  if (reason === 'manual') return 'badge-accent';
  if (reason === 'always') return 'badge-success';
  return '';
}

export function ContextInspector({ info }: { info: ContextInfo }) {
  const inputPct = Math.min(
    100,
    Math.round((info.estimatedTokens / Math.max(1, info.availableInputTokens)) * 100),
  );
  return (
    <div className="context-inspector">
      <div className="context-inspector-head">
        <div>
          <span className="eyebrow">Context inspector</span>
          <strong>
            {info.model.model
              ? `${info.model.connectionName ?? 'connection'} / ${info.model.model}`
              : 'No prose model selected'}
          </strong>
          <span className="muted small">
            {info.model.contextLength
              ? `${info.model.contextLength.toLocaleString()}-token model window`
              : 'Model context window unknown'}
          </span>
        </div>
        <div className="context-estimate">
          <span>
            ≈ {info.estimatedTokens.toLocaleString()} /{' '}
            {info.availableInputTokens.toLocaleString()} input tokens
          </span>
          <span className="muted small">
            {info.tokenEstimate === 'approximate' ? 'estimated' : 'exact'} ·{' '}
            {info.reservedOutputTokens.toLocaleString()} reserved for the reply
          </span>
        </div>
      </div>

      <div className="context-bar" title="Estimated input token budget">
        <span className="context-bar-fill" style={{ width: `${inputPct}%` }} />
      </div>

      <div className="context-sections">
        {info.sections.map((section) => (
          <div className={`context-section ${section.included ? '' : 'is-empty'}`} key={section.id}>
            <span className={`context-dot ${section.included ? 'on' : ''}`} aria-hidden="true" />
            <div className="context-section-copy">
              <strong>{section.label}</strong>
              <span className="muted small">{section.detail}</span>
              {section.note ? <span className="context-note-text">{section.note}</span> : null}
            </div>
            <span className="context-tokens">
              {section.included ? `≈ ${section.tokens.toLocaleString()}` : 'omitted'}
            </span>
          </div>
        ))}
      </div>

      {info.lore.entries.length > 0 ? (
        <div className="lore-activation">
          <div className="lore-activation-head">
            <span className="eyebrow">Lore activation</span>
            <span className="muted small">
              ≈ {info.lore.usedTokens.toLocaleString()} /{' '}
              {info.lore.budgetTokens.toLocaleString()} lore tokens
            </span>
          </div>
          <ul className="lore-activation-list">
            {info.lore.entries.map((entry) => (
              <li
                key={entry.id}
                className={entry.reason === 'budget' ? 'is-budget' : undefined}
              >
                <span className={`badge ${loreReasonClass(entry.reason)}`}>
                  {loreReasonLabel(entry.reason)}
                </span>
                <strong>{entry.title}</strong>
                <span className="muted small">
                  {entry.lorebookName} · ≈ {entry.tokens.toLocaleString()} tokens
                </span>
                {entry.matched.length > 0 ? (
                  <span className="muted small">matched {entry.matched.join(', ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {info.staleSummaries > 0 || info.pendingFacts > 0 ? (
        <div className="context-memory-flags">
          {info.staleSummaries > 0 ? (
            <span className="badge badge-warning">
              {info.staleSummaries} stale {info.staleSummaries === 1 ? 'summary' : 'summaries'}
            </span>
          ) : null}
          {info.pendingFacts > 0 ? (
            <span className="badge badge-warning">
              {info.pendingFacts} proposed {info.pendingFacts === 1 ? 'fact' : 'facts'}
            </span>
          ) : null}
        </div>
      ) : null}

      {info.warnings.length > 0 ? (
        <ul className="context-warnings">
          {info.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
