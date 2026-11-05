# FlowKitForm infrastructure (Pulumi, AWS)

Standalone TypeScript Pulumi project for the serverless deployment described in
[`docs/serverless.md`](../docs/serverless.md).

```sh
bun install
bun run typecheck
bun test ./test
pulumi preview   # requires the Pulumi CLI, a backend, and AWS credentials
```

Fill every `REPLACE_ME` value in `Pulumi.dev.yaml` first. Never put secrets in stack config.
