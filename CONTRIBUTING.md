# Contributing to StykAnimate

Thanks for helping make StykAnimate better. This guide covers how to report problems, suggest ideas and send changes.

## Ask, report or suggest

- **Questions and showing your work:** the [StykAnimate Discord](https://discord.gg/WTssQKBaJp).
- **Bugs:** open a [bug report](https://github.com/filippocalippo/StykAnimate-App/issues/new?template=bug_report.yml). Include your StykAnimate version, operating system (or browser), the steps to reproduce, and what you expected. A small `.styk` or `.piv` file that shows the problem helps a lot; only share files you are allowed to share.
- **Ideas:** open a [feature request](https://github.com/filippocalippo/StykAnimate-App/issues/new?template=feature_request.yml) describing the problem you want solved, not only the solution.
- **Security problems:** never in a public issue; see [SECURITY.md](SECURITY.md).

## Development setup

Follow [Build from source](README.md#build-from-source). Use the locked dependencies (`npm ci`) and avoid upgrading packages as part of an unrelated change. Run commands from the repository root.

Before writing code, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the document in `docs/` that covers the feature you are changing. Those documents are contracts: if your change alters a behavior they describe, update them in the same pull request.

## Pull requests

1. For anything bigger than a small fix, open an issue first so we can agree on the approach.
2. Keep each pull request focused on one problem. Unrelated clean-ups belong in their own pull request.
3. Add or update tests for the behavior you change. Prefer tests that check what a person sees or what is saved, and confirm the test fails without your fix when practical.
4. Run the checks:
   ```sh
   npm run check
   npm test
   ```
   Also run the browser tests (`tests/*.browser.mjs`) and the Python tests (`python -m unittest discover -s backend -p "test_*.py"`) that cover your change.
5. For visible changes, include before and after screenshots or a short clip.
6. For user-facing changes, add one short entry to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md), following the style guide in [docs/RELEASING.md](docs/RELEASING.md): the result first, in plain language, without internal details.

Only the maintainer can merge into `main`. Every pull request needs the maintainer's approval and a green **Tests passed** check; workflows from first-time contributors start after a maintainer approves them.

The Tests workflow runs only what a change can affect: the unit tests always, the Rust engine's tests when `engine/` or `tests/fixtures/` changed, and the Windows, browser and packaged-app checks unless only documentation changed. The engine is compiled once per run, and not at all when its sources are unchanged.

### What we look after in review

- **Your animations are safe.** Saving must stay atomic: a failed or cancelled save never damages the existing file or loses unsaved work. Old files must keep opening, and undo/redo must keep working.
- **The editor stays responsive.** Heavy work (parsing, rendering, encoding) belongs in the existing workers, not on the interface thread. Caches and queues need limits. If you touch a hot path, measure a dense scene before and after.
- **Changes fit the existing structure.** Fix the module that owns the behavior rather than adding a second copy of it, and keep new helpers and dependencies to what the change needs.
- **The desktop app stays locked down.** Keep Electron's context isolation and the narrow preload/IPC API. Projects are processed locally.

## Translations

Interface strings live in `src/locales/`. See [docs/TRANSLATING.md](docs/TRANSLATING.md) for how to add or correct a language.

## AI coding assistants

[AGENTS.md](AGENTS.md) holds the working rules for coding agents. They are the same expectations as above, written for tools. You are responsible for any pull request you open, including code an assistant wrote: review and test it yourself.

## License of contributions

StykAnimate is licensed under the [GNU GPL, version 3 or later](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms, and you confirm you have the right to submit it. Don't include code, artwork, figures, fonts or sounds you don't have the rights to share under the GPL.
