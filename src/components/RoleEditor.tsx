import { useEffect, useMemo, useState } from 'react';
import type {
  ConnectionPublic,
  ResolvedRole,
  RoleAssignment,
  TaskRole,
} from '@shared/types';
import { ROLE_HINTS, ROLE_LABELS, TASK_ROLES } from '@shared/types';
import { errorText } from '../utils';
import { Banner, Spinner } from './ui';

type EditRow = { connectionId: string; model: string };

export function RoleEditor({
  roles,
  connections,
  scope,
  onSave,
}: {
  roles: ResolvedRole[];
  connections: ConnectionPublic[];
  scope: 'global' | 'project';
  onSave: (
    assignments: Array<{ role: TaskRole; connectionId: string | null; model: string | null }>,
  ) => Promise<void>;
}) {
  const [rows, setRows] = useState<Record<string, EditRow>>(() => initialRows(roles, scope));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setRows(initialRows(roles, scope));
  }, [roles, scope]);

  const resolvedByRole = useMemo(() => {
    const map = new Map<TaskRole, ResolvedRole>();
    for (const role of roles) map.set(role.role, role);
    return map;
  }, [roles]);

  const update = (role: TaskRole, patch: Partial<EditRow>) => {
    setRows((current) => ({
      ...current,
      [role]: { ...(current[role] ?? { connectionId: '', model: '' }), ...patch },
    }));
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    for (const role of TASK_ROLES) {
      const row = rows[role];
      if (row?.connectionId && !row.model.trim()) {
        setError(`Choose a model for the ${ROLE_LABELS[role].toLowerCase()} role, or clear the connection.`);
        return;
      }
    }
    setSaving(true);
    try {
      await onSave(
        TASK_ROLES.map((role) => {
          const row = rows[role];
          return {
            role,
            connectionId: row?.connectionId || null,
            model: row?.connectionId ? row.model.trim() : null,
          };
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="role-editor">
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {saved ? <Banner tone="success">Model roles saved.</Banner> : null}
      {connections.length === 0 ? (
        <Banner tone="warning" title="No connections yet">
          Add an OpenRouter or OpenAI-compatible connection before assigning models.
        </Banner>
      ) : null}

      <div className="role-list">
        {TASK_ROLES.map((role) => {
          const row = rows[role] ?? { connectionId: '', model: '' };
          const connection = connections.find((entry) => entry.id === row.connectionId);
          const resolved = resolvedByRole.get(role);
          const inherited =
            scope === 'project' ? resolved?.source !== 'project' : resolved?.source === 'default';
          const datalistId = `models-${scope}-${role}`;

          return (
            <div className="role-row" key={role}>
              <div className="role-copy">
                <strong>{ROLE_LABELS[role]}</strong>
                <span className="muted">{ROLE_HINTS[role]}</span>
              </div>
              <div className="role-inputs">
                <select
                  aria-label={`${ROLE_LABELS[role]} connection`}
                  value={row.connectionId}
                  onChange={(event) => {
                    const next = connections.find((entry) => entry.id === event.target.value);
                    update(role, {
                      connectionId: event.target.value,
                      model: next?.models[0]?.id ?? '',
                    });
                  }}
                >
                  <option value="">
                    {scope === 'project'
                      ? role === 'default'
                        ? 'Use global default'
                        : 'Use global setting'
                      : role === 'default'
                        ? 'Not set'
                        : 'Use default model'}
                  </option>
                  {connections.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`${ROLE_LABELS[role]} model`}
                  list={datalistId}
                  value={row.model}
                  onChange={(event) => update(role, { model: event.target.value })}
                  placeholder={connection ? 'Model ID' : 'Select a connection first'}
                  disabled={!row.connectionId}
                  spellCheck={false}
                />
                <datalist id={datalistId}>
                  {(connection?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="role-status">
                {resolved?.model ? <span className="muted small">Effective: {resolved.connectionName} / {resolved.model} · {resolved.source === 'default' ? 'Default model' : resolved.source}</span> : null}
                {inherited ? (
                  resolved?.connectionId && resolved.model ? (
                    <span className="muted">
                      Inherited: {resolved.connectionName ?? 'connection'} / {resolved.model}
                    </span>
                  ) : (
                    <span className="muted">Inherited: not configured</span>
                  )
                ) : row.connectionId ? (
                  <span className="role-tag">{scope === 'project' ? 'Project override' : 'Assigned'}</span>
                ) : (
                  <span className="muted">Not configured</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="form-actions inline">
        <button type="button" className="button button-primary button-small" onClick={save} disabled={saving}>
          {saving ? <Spinner /> : null}
          {saving ? 'Saving…' : 'Save model roles'}
        </button>
      </div>
    </div>
  );
}

function initialRows(roles: ResolvedRole[], scope: 'global' | 'project'): Record<string, EditRow> {
  const rows: Record<string, EditRow> = {};
  for (const role of TASK_ROLES) {
    const resolved = roles.find((entry) => entry.role === role);
    const owned =
      scope === 'global' ? resolved?.source === 'global' : resolved?.source === 'project';
    rows[role] = owned
      ? { connectionId: resolved?.connectionId ?? '', model: resolved?.model ?? '' }
      : { connectionId: '', model: '' };
  }
  return rows;
}

export type { RoleAssignment };
