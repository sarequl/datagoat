# DataGoat with Google Tag Manager

1. In [Google Tag Manager](https://tagmanager.google.com/) open your container and go to
   **Tags > New**.
2. Name it "DataGoat", choose **Tag Configuration > Custom HTML** and paste this. It builds the
   tag in JavaScript, so its `data-*` attributes reach the page exactly as written whatever GTM does
   when it injects Custom HTML:

   ```html
   <script>
     (function () {
       window.datagoat = window.datagoat || function () {
         (window.datagoat.q = window.datagoat.q || []).push(arguments);
       };
       var s = document.createElement("script");
       s.defer = true;
       s.setAttribute("data-website-id", "dgid_XXXXXXXXXXXXXXXX");
       s.setAttribute("data-domain", "example.com");
       s.src = "https://a.example.com/js/script.js";
       document.head.appendChild(s);
     })();
   </script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)). Add more
   attributes with more `setAttribute` lines, e.g. `data-api-url` for a custom subdomain.
3. **Triggering**: choose **All Pages** (or **Initialization - All Pages** to load it earliest).
4. **Save**, then **Submit** and **Publish** the container.

## Goals from GTM

Create Custom HTML tags fired by your existing triggers:

```html
<script>window.datagoat("newsletter_signup", { form: "{{Form ID}}" });</script>
```

## Consent

If you load GTM through a consent manager, DataGoat's tag follows the same consent as other
tags. With the cookieless build (`script.cookieless.js`) you may not need to gate it at all; that
is a legal question for you, not a technical one.

## Verify

Use GTM's **Preview** to check the tag fires, then look at **Realtime** in DataGoat.
