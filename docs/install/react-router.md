# DataGoat with React Router (and Remix)

## React Router in framework mode / Remix

Add the tag to the `<head>` your root route renders:

```tsx
// app/root.tsx
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Meta />
        <Links />
        <script
          defer
          data-website-id="dgid_XXXXXXXXXXXXXXXX"
          data-domain="example.com"
          src="https://a.example.com/js/script.js"
        />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
```

## Single-page apps (Vite + React Router)

Put the tag in `index.html`, or let the SDK add it once:

```tsx
// main.tsx
import { DataGoatProvider } from "@datagoat/sdk/react";

createRoot(document.getElementById("root")!).render(
  <DataGoatProvider websiteId="dgid_XXXXXXXXXXXXXXXX" domain="example.com" host="https://a.example.com">
    <RouterProvider router={router} />
  </DataGoatProvider>,
);
```

The tracker records client-side navigations itself (History API). For hash routers
(`createHashRouter`) use the hash build: `variant="hash"` or `src=".../js/script.hash.js"`.

## Goals and identify

```tsx
import { useDataGoat, useIdentify } from "@datagoat/sdk/react";

function Pricing() {
  const { track } = useDataGoat();
  return <button onClick={() => track("checkout_click", { plan: "pro" })}>Buy</button>;
}

function App({ user }) {
  useIdentify(user?.id, { name: user?.name });
  // ...
}
```

Revenue attribution: read the visitor on your server when you create the checkout, see
[npm.md](npm.md#revenue-attribution-on-your-server).
