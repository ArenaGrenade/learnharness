# Coding questions

Teaching questions and repeated coding practice, with syntax highlighting,
committed model solutions and per-submission test observations. Only native
`conclude` assesses and closes practice; passing tests alone never concludes it.

## Core plugin and requirements

Enable Coding questions in Settings → Core plugins. This fork requires the
private Docker execution service configured by its host. Python, CUDA, C++, and
Rust are the enabled languages. Settings and each editor show actual compiler
versions and readiness; CUDA requires a successful GPU kernel self-test.
Unavailable capabilities prevent submission. Unsupported languages are refused
by the backend. Syntax highlighting for other saved languages does not enable
their execution. There is no local execution fallback.

The shared registry is [`runner/languages.json`](runner/languages.json).
Change it and the host's execution image together when changing languages.
The reserved Core ID must not be installed as a duplicate Community plugin.

## Question and test contract

The teacher receives `coding_question` with the host's question/type/nodeId and
payload `{language, starterCode?, modelSolution, tests}`. Practice receives
`coding_problem`, with its model solution in the native host's common fields.
Solutions are committed when posing and revealed after answering/concluding;
they never enter the execution request. Thinking remains separate from code.

New test recipes require `{program: "python3", args: ["-"], code: "..."}`.
The Python driver reads exact UTF-8 learner source from `answer.txt`. It can
compile C++, CUDA, or Rust using `g++`, `nvcc`, or `rustc` and run the resulting
binary. Exit zero for passed tests, nonzero for failed tests. For example:

```python
exec(open('answer.txt').read())
assert square(7) == 49
```

The backend sends only language, learner source and test recipe to its private
runner. Jobs use fresh bounded scratch storage, no network, no app/profile or
credential mounts, a read-only root, non-root identity, dropped capabilities,
and CPU/RAM/process limits. Runs have a 30-second deadline and capture at most
64 KiB per output stream. Runtimes/packages cannot be downloaded during a run.
The broker removes the job container afterward. The host's Docker engine and
GPU driver are trusted infrastructure.

## Tests and boundaries

`npm run typecheck`, `npm test`, and `npm run build` validate the public SDK,
contracts, remote dispatch/cancellation, syntax diagnostics and saved results.
Retained upstream local-runner tests exercise trusted native fixtures; that
runner is not imported by the deployed backend. The host's Docker smoke checks
exercise actual submissions in all four languages, isolation and real browser
question scrolling. Always use disposable state and fake providers for tests.

## API boundary

The plugin uses public question/problem registration, grading/processing,
renderer/settings, capability tool and backend call APIs. Answers remain strings;
execution observations are separate metadata. The native host owns submission
authority, saving, continuation and conclusion. Source entry points are
[`src/backend.ts`](src/backend.ts), [`src/remote-runner.ts`](src/remote-runner.ts),
[`src/main.ts`](src/main.ts), and [`src/editor.ts`](src/editor.ts).

See the [example map](../../docs/plugin-examples.md),
[authoring guide](../../docs/plugin-authoring.md) and
[API reference](../../docs/plugin-api/README.md).

## License

AGPL-3.0-only. Built packages include third-party license notices.
