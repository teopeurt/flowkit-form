import { useState } from 'react';

import { Alert, Button, EmptyState } from '@flowkit-demo/ui';
import { errorMessage, type Organization } from '../../lib/api';

export function OrganizationSelectionPage({ organizations, onSelect }: { organizations: Organization[]; onSelect(id: string): Promise<void> }) {
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();

  async function choose(organization: Organization) {
    setSelected(organization.id);
    setError(undefined);
    try {
      await onSelect(organization.id);
    } catch (cause) {
      setError(errorMessage(cause));
      setSelected(undefined);
    }
  }

  return (
    <main className="selection-shell">
      <header>
        <div className="wordmark"><span>FK</span><strong>FlowKit</strong></div>
        <p className="eyebrow">Organization context</p>
        <h1>Choose where you’re working</h1>
        <p>Your access and workflow role come from the selected membership.</p>
      </header>
      {error ? <Alert tone="error" title="Organization not selected">{error}</Alert> : null}
      <section className="organization-list" aria-label="Available organizations">
        {organizations.length ? organizations.map((organization) => (
          <article className="organization-option" key={organization.id}>
            <div><strong>{organization.name}</strong><code>{organization.slug}</code></div>
            <Button variant="primary" busy={selected === organization.id} onClick={() => choose(organization)}>Use {organization.name}</Button>
          </article>
        )) : <EmptyState title="No organizations available">Ask an administrator to add an enabled membership.</EmptyState>}
      </section>
    </main>
  );
}
