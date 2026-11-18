# Upstream integration

Baseline: `amosblomqvist/learnharness` main, v0.6.1,
`cb25c8e49b85eed9e78315584731cad73a0118a6`.

This fork deploys a browser application built and run in Docker. Keep upstream
Electron sources: several are shared Node services, and deleting them makes
future upgrades unnecessarily difficult. Desktop packaging is not our deployment target.

Local boundaries:

- `deploy/docker/`: source-only builds, standalone runtime, Compose, Chromium
  sandbox policy, network guard and separate execution broker/job images.
- `src/self-host/`: authentication, remote-browser ChatGPT paste-back, subscription
  credential ownership, push scheduling and boot composition. The `src/server/`
  compatibility exports keep route imports stable. Root proxy/instrumentation
  are composition points. The streaming document route explicitly applies the
  same authentication policy without cloning the upload body.
- `plugins/coding-questions/src/remote-runner.ts` and `runner/languages.json`:
  private execution transport and the authoritative four-language registry.
  Backend schema, agent tool and browser readiness all derive from this registry.
  Late capability replies preserve the newest host-controlled code draft.
  Upstream's local runner is retained for reference/tests but the deployed
  backend never imports it or falls back to app-container execution.
- Topics/paper sessions, evidence and PWA notifications remain native adapters:
  current public plugin APIs cannot write native session/graph records with the
  required semantics. Prefer supported plugin APIs as those capabilities grow.

Shared patches to check at each merge: question prompt/options scrolling and
wheel containment; interrupted-call replay filtering; dynamic ChatGPT metadata
and usage holds; subscription host injection and second-owner refusal; setup draft preservation during
catalog refresh; SearXNG; Topic links/contracts; notification settings; Chromium
sandbox launch. Regression tests accompany these integrations. Keep upstream
interaction-layer, plugin-authority and session recovery rules intact.

## Next upgrade

Start with a clean tree. `python3 deploy/docker/upgrade.py --help` prepares an
isolated merge worktree from the requested upstream ref; it never deploys.
Resolve conflicts by reviewing upstream behavior, then run `npm ci`,
`npm run plugins:setup`, `npx tsc --noEmit`, `npm run lint`, `npm test`, and the
coding plugin's typecheck/test suite. Build using `deploy/docker/build.py`.
Validate disposable data and a credential-free copy of existing learning data,
core plugins, question scrolling/recovery, sign-in, and all four execution
languages. Back up the live profile and old images before switching Compose.
Record the new upstream revision here, retain merge history, and document any
new shared patches. Do not overwrite host-specific private configuration.
