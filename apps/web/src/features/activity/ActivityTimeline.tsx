import { EmptyState } from '@flowkit-demo/ui';
import type { FlowActivity } from '../../lib/api';

const actionLabels: Record<string, string> = {
  submit: 'Submitted',
  approve: 'Approved',
  reject: 'Rejected',
  return: 'Returned',
  withdraw: 'Withdrawn',
};

export function ActivityTimeline({ activities }: { activities: FlowActivity[] }) {
  if (!activities.length) return <EmptyState title="No activity yet">Submit this request to create its first activity entry.</EmptyState>;
  return (
    <ol className="activity-list" aria-label="Request activity">
      {activities.map((activity, index) => (
        <li key={activity.id ?? `${activity.action}-${index}`}>
          <span className="activity-marker" aria-hidden="true" />
          <div>
            <strong>{actionLabels[activity.action] ?? sentenceCase(activity.action)}</strong>
            <p>{sentenceCase(activity.fromStage)} → {sentenceCase(activity.toStage)}</p>
            <small>{activity.actorId} · <time dateTime={activity.occurredAt}>{formatTime(activity.occurredAt)}</time></small>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function sentenceCase(value: string) {
  const normalized = value.replaceAll('_', ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
