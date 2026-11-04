# DataGoat with Vue

## Vue with Vite

Add the tag to `index.html`:

```html
<head>
  <script
    defer
    data-website-id="dfid_XXXXXXXXXXXXXXXX"
    data-domain="example.com"
    src="https://a.example.com/js/script.js"
  ></script>
</head>
```

or initialise it from `main.ts` with the SDK:

```ts
import { init } from "@datagoat/sdk";
init({ websiteId: "dfid_XXXXXXXXXXXXXXXX", domain: "example.com", host: "https://a.example.com" });
```

Vue Router's history mode is tracked automatically. With `createWebHashHistory()`, use the hash
build (`script.hash.js`, or `variant: "hash"`).

## Nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [
        {
          src: "https://a.example.com/js/script.js",
          defer: true,
          "data-website-id": "dfid_XXXXXXXXXXXXXXXX",
          "data-domain": "example.com",
        },
      ],
    },
  },
});
```

## Goals

```vue
<script setup lang="ts">
import { track } from "@datagoat/sdk";
</script>

<template>
  <button @click="track('signup_click', { plan: 'pro' })">Sign up</button>
</template>
```

or `<button data-fast-goal="signup_click">` without code.

First-party proxy: [proxy-vue.md](proxy-vue.md).
