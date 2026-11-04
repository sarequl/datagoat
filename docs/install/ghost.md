# DataGoat on Ghost

1. In Ghost Admin go to **Settings > Code injection** (Advanced) and open **Site header**.
2. Paste:

   ```html
   <script
     defer
     data-website-id="dfid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)).
3. **Save**.

## Revenue from paid memberships

Ghost takes payments through Stripe. Connect the same Stripe account in DataGoat (Integrations >
Stripe). To link each new paid member to the visit that converted, identify members in the
**Site footer** code injection. Ghost's `@member` data is available to theme templates; in code
injection read it from the Portal-rendered page:

```html
<script>
  window.datafast = window.datafast || function () { (window.datafast.q = window.datafast.q || []).push(arguments); };
  // Remember the email a visitor signs up with...
  document.addEventListener("submit", function (e) {
    var input = e.target.querySelector && e.target.querySelector("[data-members-email], input[type=email]");
    if (input && input.value) localStorage.setItem("dg_member_email", input.value);
  }, true);
  // ...and report it when Ghost lands them back after Stripe checkout (?stripe=success).
  if (/[?&]stripe=success/.test(location.search)) {
    var email = localStorage.getItem("dg_member_email");
    if (email) window.datafast("payment", { email: email });
  }
</script>
```

DataGoat matches the email with the Stripe payment and attributes the revenue to the visit. In a
custom theme you can instead render `{{#if @member}}` and call
`window.datafast("identify", {user_id: "{{@member.uuid}}", name: "{{@member.name}}"})`.

## Verify

Open the site in a private window (Ghost Admin is on the same domain) and check **Realtime**.
