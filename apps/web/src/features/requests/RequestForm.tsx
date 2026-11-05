import { useState, type FormEvent } from 'react';

import { Alert, Button, Panel, TextareaField, TextField } from '@flowkit-demo/ui';
import { errorMessage, type CreateRequestInput } from '../../lib/api';

export function RequestForm({ onCreate, defaultManagerId }: { onCreate(input: CreateRequestInput): Promise<void>; defaultManagerId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({
        startDate: String(values.get('startDate') ?? ''),
        endDate: String(values.get('endDate') ?? ''),
        businessDays: Number(values.get('businessDays')),
        balanceDays: Number(values.get('balanceDays')),
        managerId: String(values.get('managerId') ?? ''),
        reason: String(values.get('reason') ?? ''),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="New leave request">
      <div className="form-panel">
        <p className="panel-lede">Record the dates, balance, and approver. You can review the draft before submitting it.</p>
        {error ? <Alert tone="error" title="Request not created">{error}</Alert> : null}
        <form onSubmit={submit} className="request-form">
          <TextField label="Start date" name="startDate" type="date" required />
          <TextField label="End date" name="endDate" type="date" required />
          <TextField label="Business days" name="businessDays" type="number" min="1" defaultValue="1" required />
          <TextField label="Available balance" name="balanceDays" type="number" min="0" defaultValue="20" required />
          <TextField label="Manager identifier" name="managerId" defaultValue={defaultManagerId} required />
          <TextareaField label="Reason" name="reason" minLength={3} required />
          <div className="form-submit"><Button type="submit" variant="primary" busy={busy}>Create request</Button></div>
        </form>
      </div>
    </Panel>
  );
}
