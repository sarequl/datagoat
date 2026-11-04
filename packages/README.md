# packages/

Separately published packages, owned by W8. They are npm workspaces of the root but not part of the
Worker bundle.

| Package                                 | What                                                                                          | Docs                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`sdk`](sdk) (`@datagoat/sdk`)          | Browser SDK: `init`, `track`, `identify`, `getVisitorId`; React and Next.js helpers; server helpers for checkout metadata | [docs/install/npm.md](../docs/install/npm.md)               |
| [`react-native`](react-native) (`@datagoat/react-native`) | React Native / Expo SDK: screens, goals, identify, offline queue                 | [docs/install/react-native.md](../docs/install/react-native.md) |
| [`wordpress`](wordpress)                | WordPress plugin (PHP): snippet, admin exclusion, WooCommerce order meta and goals            | [docs/install/wordpress.md](../docs/install/wordpress.md)   |

Tests: `npm run test:ecosystem` (Vitest projects in [`vitest.config.ts`](vitest.config.ts), plus
`php -l` and the plugin's PHP tests when `php` is installed). Types: `tsc -p packages/tsconfig.json`
(part of `npm run typecheck`). Build a package for npm with `npm run build -w @datagoat/sdk`.
