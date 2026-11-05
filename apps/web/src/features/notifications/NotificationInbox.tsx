import { Badge, EmptyState, Panel } from '@flowkit-demo/ui';
import type { NotificationPayload } from '../../lib/api';
import { sentenceCase } from '../activity/ActivityTimeline';

function deliveryTone(status: string): 'success' | 'warning' | 'error' {
  if (status === 'delivered') return 'success';
  if (status === 'failed' || status === 'reconciliation_required') return 'error';
  return 'warning';
}

export function NotificationInbox({ payload }: { payload: NotificationPayload }) {
  const count = payload.inbox.length + payload.deliveries.length;
  return (
    <Panel title="Notifications" meta={<Badge tone={count ? 'accent' : 'neutral'}>{count} records</Badge>}>
      <div className="notification-inbox">
        {!count ? <EmptyState title="No notifications">Request updates and delivery evidence will appear here.</EmptyState> : null}
        {payload.inbox.map((notice) => (
          <article className="notification-row" key={notice.id}>
            <div><strong>{notice.subject}</strong><p>{notice.body}</p><small>{formatDate(notice.deliveredAt)}</small></div>
            <Badge tone="success">Inbox</Badge>
          </article>
        ))}
        {payload.deliveries.map((delivery) => (
          <article className="notification-row" key={delivery.id}>
            <div><strong>{delivery.subject}</strong><p>Delivery evidence</p><code>{delivery.id}</code></div>
            <Badge tone={deliveryTone(delivery.status)}>{sentenceCase(delivery.status)}</Badge>
          </article>
        ))}
      </div>
    </Panel>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
