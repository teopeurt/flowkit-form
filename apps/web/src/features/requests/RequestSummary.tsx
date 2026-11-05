import { useState } from 'react';

import { Alert, Badge, Button, Panel } from '@flowkit-demo/ui';
import { ActivityTimeline, sentenceCase } from '../activity/ActivityTimeline';
import { errorMessage, type ActiveMember, type FlowRecord, type TaskRecord } from '../../lib/api';

const approvalStages = ['employee_draft', 'policy_evaluation', 'manager_review', 'fulfillment', 'approved'] as const;
type ApplicationRole = ActiveMember['applicationRole'];

function stageTone(stage: string): 'neutral' | 'accent' | 'success' | 'warning' | 'error' {
  if (stage === 'approved') return 'success';
  if (stage === 'rejected' || stage === 'withdrawn') return 'error';
  if (stage === 'employee_draft') return 'neutral';
  return 'warning';
}

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    submit: 'Submit request',
    withdraw: 'Withdraw request',
    approve: 'Approve request',
    reject: 'Reject request',
    return: 'Return request',
  };
  return labels[action] ?? sentenceCase(action);
}

export function RequestSummary({
  flow,
  currentRole,
  currentUserId,
  reviewTask,
  onAction,
}: {
  flow: FlowRecord;
  currentRole: ApplicationRole;
  currentUserId: string;
  reviewTask?: TaskRecord;
  onAction(action: string, comment?: string): Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<string>();
  const [error, setError] = useState<string>();
  const stages = stagesFor(flow.state.stage);
  const activeIndex = stages.indexOf(flow.state.stage as typeof stages[number]);
  const ownsReview = currentRole === 'manager'
    && reviewTask?.status === 'claimed'
    && reviewTask.assigneeId === currentUserId;
  const availableActions = flow.nextActions.filter((action) => {
    if (['approve', 'reject', 'return'].includes(action)) return ownsReview;
    if (['submit', 'withdraw'].includes(action)) return currentRole === 'employee' && flow.employee_id === currentUserId;
    return false;
  });
  const reviewBlocked = flow.state.stage === 'manager_review'
    && currentRole === 'manager'
    && flow.nextActions.some((action) => ['approve', 'reject', 'return'].includes(action))
    && !ownsReview;

  async function act(action: string) {
    setBusyAction(action);
    setError(undefined);
    try {
      await onAction(action);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <div className="request-detail">
      <header className="request-heading">
        <div><p className="eyebrow">Request record</p><h1 data-testid="request-id">{flow.id}</h1></div>
        <Badge tone={stageTone(flow.state.stage)}><span data-testid="request-stage">{sentenceCase(flow.state.stage)}</span></Badge>
      </header>
      {error ? <Alert tone="error" title="Action not recorded">{error} Refresh the request and try again.</Alert> : null}
      <div className="request-grid">
        <Panel title="Workflow position" meta={<code>SEQ {String(flow.sequence).padStart(2, '0')}</code>}>
          <ol className="workflow-rail" aria-label="Workflow position">
            {stages.map((stage, index) => (
              <li key={stage} className={stage === flow.state.stage ? 'is-current' : index < activeIndex ? 'is-complete' : ''}>
                <span aria-hidden="true">{index < activeIndex ? '✓' : index + 1}</span>
                <div><strong>{sentenceCase(stage)}</strong><small>{stage === flow.state.stage ? 'Current stage' : index < activeIndex ? 'Recorded' : 'Pending'}</small></div>
              </li>
            ))}
          </ol>
          <div className="request-actions">
            {availableActions.map((action) => (
              <Button key={action} variant={action === 'submit' || action === 'approve' ? 'primary' : action === 'reject' ? 'danger' : 'secondary'} busy={busyAction === action} disabled={Boolean(busyAction)} onClick={() => act(action)}>
                {actionLabel(action)}
              </Button>
            ))}
            {reviewBlocked ? <p>Claim the review task before recording a decision.</p> : null}
            {!availableActions.length && !reviewBlocked ? <p>No actions are available in this state.</p> : null}
          </div>
        </Panel>
        <Panel title="Request details" meta={<Badge tone="neutral">Leave</Badge>}>
          <dl className="record-grid">
            <div><dt>Dates</dt><dd>{flow.start_date} → {flow.end_date}</dd></div>
            <div><dt>Business days</dt><dd>{flow.business_days}</dd></div>
            <div><dt>Available balance</dt><dd>{flow.balance_days}</dd></div>
            <div><dt>Manager</dt><dd>{flow.manager_id}</dd></div>
            <div className="record-grid__wide"><dt>Reason</dt><dd>{flow.reason}</dd></div>
            <div className="record-grid__wide"><dt>Definition</dt><dd><code>{flow.definitionHash}</code></dd></div>
          </dl>
        </Panel>
      </div>
      <Panel title="Activity history" meta={<Badge tone="neutral">{flow.activities.length} events</Badge>}>
        <ActivityTimeline activities={flow.activities} />
      </Panel>
    </div>
  );
}

function stagesFor(stage: string): readonly string[] {
  if (stage === 'withdrawn') return ['employee_draft', 'withdrawn'];
  if (stage === 'rejected') return ['employee_draft', 'policy_evaluation', 'manager_review', 'rejected'];
  return approvalStages;
}
