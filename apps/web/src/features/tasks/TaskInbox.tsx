import { useState } from 'react';
import { Alert, Badge, Button, EmptyState, Panel } from '@flowkit-demo/ui';
import { errorMessage, type TaskRecord } from '../../lib/api';
import { sentenceCase } from '../activity/ActivityTimeline';

export function TaskInbox({ tasks, currentUserId, onClaim }: { tasks: TaskRecord[]; currentUserId: string; onClaim(task: TaskRecord): Promise<void> }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function claim(task: TaskRecord) {
    setBusy(task.id);
    setError(undefined);
    try {
      await onClaim(task);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Panel title="Task inbox" meta={<Badge tone={tasks.length ? 'accent' : 'neutral'}>{tasks.length} assigned</Badge>}>
      {error ? <div className="inset-alert"><Alert tone="error" title="Task not claimed">{error} Refresh the inbox and try again.</Alert></div> : null}
      {!tasks.length ? <EmptyState title="No assigned tasks">Review work appears here when a request reaches your role.</EmptyState> : (
        <div className="task-list">
          {tasks.map((task) => (
            <article className="task-row" data-task-row key={task.id}>
              <div className="task-main">
                <Badge tone={task.status === 'claimed' ? 'success' : 'warning'}>{task.status}</Badge>
                <strong>{sentenceCase(task.stage)}</strong>
                <code>{task.subjectId}</code>
                <small>{task.assigneeId ? `Assigned to ${task.assigneeId}` : `Waiting for a ${task.role}`}</small>
              </div>
              <div className="row-actions">
                {task.status === 'open' ? <Button busy={busy === task.id} disabled={Boolean(busy)} onClick={() => claim(task)}>Claim task</Button> : null}
                {task.status === 'claimed' && task.assigneeId !== currentUserId ? <span className="muted-copy">Claimed by another reviewer</span> : null}
                <a className="text-link" href={`/requests/${task.subjectId}`}>Open {task.subjectId}</a>
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
