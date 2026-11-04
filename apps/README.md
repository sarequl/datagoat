# apps/

Separately built applications, owned by W8.

`apps/mobile` is the iOS/Android companion app (Expo, React Native, TypeScript). It talks to the
Worker through `/api/v1` with a read-only mobile token. Architecture and the feature list against
DataFast's app: [docs/architecture/mobile.md](../docs/architecture/mobile.md).

It is **not** an npm workspace of the repository: it needs React 19 and React Native while the
dashboard uses React 18, and Metro must not see two copies of React. It has its own
`package-lock.json`:

```sh
cd apps/mobile
npm ci
npm run check     # tsc + expo export (bundles the iOS and Android JavaScript)
npx expo start
```

Its data layer (`apps/mobile/src/lib`, no React Native imports) is unit-tested and type-checked from
the repository root by `npm run test:ecosystem` and `npm run typecheck`.
