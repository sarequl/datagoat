# DataGoat on Framer

1. Open your project and go to **Site Settings > General > Custom Code**.
2. In **Start of `<head>` tag**, paste:

   ```html
   <script
     defer
     data-website-id="dfid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)).
3. **Save** and **Publish**. Custom code runs on the published site only.

Framer sites are single-page apps; the tracker records page changes on its own.

## Goals

Framer links and buttons cannot take arbitrary attributes everywhere, so track goals from a code
override or an Embed:

```html
<script>
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("a[href*='signup']");
    if (el && window.datafast) window.datafast("signup_click");
  });
</script>
```

## Verify

Open the published site and check the dashboard's **Realtime** view.
