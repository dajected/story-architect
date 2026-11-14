import { useEffect, useState } from 'react';
import type { GenerationSettings } from '@shared/types';
import { CONTEXT_PRESETS } from '@shared/types';
import { errorText } from '../utils';
import { Banner, Spinner } from './ui';

export function GenerationSettingsForm({
  value,
  onSave,
  compact = false,
}: {
  value: GenerationSettings;
  onSave: (generation: Partial<GenerationSettings>) => Promise<void>;
  compact?: boolean;
}) {
  const [targetWords, setTargetWords] = useState(value.targetWords?.toString() ?? '');
  const [contextPreset, setContextPreset] = useState(value.contextPreset);
  const [temperature, setTemperature] = useState(value.temperature?.toString() ?? '');
  const [topP, setTopP] = useState(value.topP?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(value.maxTokens?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setTargetWords(value.targetWords?.toString() ?? '');
    setContextPreset(value.contextPreset);
    setTemperature(value.temperature?.toString() ?? '');
    setTopP(value.topP?.toString() ?? '');
    setMaxTokens(value.maxTokens?.toString() ?? '');
  }, [value]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSave({
        targetWords: targetWords ? Number(targetWords) : null,
        contextPreset,
        temperature: temperature ? Number(temperature) : null,
        topP: topP ? Number(topP) : null,
        maxTokens: maxTokens ? Number(maxTokens) : null,
      });
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={`settings-form ${compact ? 'compact' : ''}`} onSubmit={save}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {saved ? <Banner tone="success">Generation settings saved.</Banner> : null}
      <div className="form-row">
        <div className="field">
          <label htmlFor="target-words">Target words per chapter</label>
          <input
            id="target-words"
            type="number"
            min={100}
            max={20000}
            step={100}
            value={targetWords}
            onChange={(event) => {
              setTargetWords(event.target.value);
              setSaved(false);
            }}
            placeholder="Provider decides"
          />
        </div>
        <div className="field">
          <label htmlFor="context-preset">Context preset</label>
          <select
            id="context-preset"
            value={contextPreset}
            onChange={(event) => {
              setContextPreset(event.target.value as GenerationSettings['contextPreset']);
              setSaved(false);
            }}
          >
            {CONTEXT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — about {preset.budgetTokens.toLocaleString()} tokens
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="field-hint">
        {CONTEXT_PRESETS.find((preset) => preset.id === contextPreset)?.description}
      </p>
      <details><summary>Advanced model sampling</summary><div className="form-row three">
        <div className="field">
          <label htmlFor="temperature">Temperature</label>
          <input
            id="temperature"
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={temperature}
            onChange={(event) => {
              setTemperature(event.target.value);
              setSaved(false);
            }}
            placeholder="Provider default"
          />
        </div>
        <div className="field">
          <label htmlFor="top-p">Top P</label>
          <input
            id="top-p"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={topP}
            onChange={(event) => {
              setTopP(event.target.value);
              setSaved(false);
            }}
            placeholder="Provider default"
          />
        </div>
        <div className="field">
          <label htmlFor="max-tokens">Max output tokens</label>
          <input
            id="max-tokens"
            type="number"
            min={1}
            max={200000}
            step={100}
            value={maxTokens}
            onChange={(event) => {
              setMaxTokens(event.target.value);
              setSaved(false);
            }}
            placeholder="Provider default"
          />
        </div>
      </div>
      <p className="field-hint">
        Empty sampling fields are omitted from the provider request so the model's own defaults apply.
      </p>
      </details><div className="form-actions inline">
        <button type="submit" className="button button-primary button-small" disabled={saving}>
          {saving ? <Spinner /> : null}
          {saving ? 'Saving…' : 'Save generation settings'}
        </button>
      </div>
    </form>
  );
}
