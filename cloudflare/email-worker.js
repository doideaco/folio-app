// Cloudflare Email Worker for Folio's email-to-save.
//
// Cloudflare Email Routing delivers inbound mail to this Worker. It parses the
// MIME with postal-mime and POSTs a clean JSON payload to the Folio backend's
// /inbound/email webhook, authenticated with a shared secret.
//
// Setup (see cloudflare/README.md):
//   1. `npm i` in cloudflare/  (installs postal-mime + wrangler)
//   2. Set secrets:  wrangler secret put FOLIO_INBOUND_SECRET
//   3. Deploy:       wrangler deploy
//   4. In the Cloudflare dashboard → Email Routing, add a catch-all rule that
//      sends mail for your domain to this Worker.

import PostalMime from "postal-mime";

export default {
  /** @param {ForwardableEmailMessage} message */
  async email(message, env) {
    try {
      const parsed = await PostalMime.parse(message.raw);

      const attachments = (parsed.attachments ?? [])
        .filter((a) => a.content)
        .slice(0, 5) // cap payload size
        .map((a) => ({
          filename: a.filename ?? undefined,
          mimeType: a.mimeType ?? undefined,
          contentBase64: bytesToBase64(a.content),
        }));

      const payload = {
        to: message.to,                       // the address the mail was sent to
        from: parsed.from?.address ?? message.from,
        subject: parsed.subject ?? "",
        html: parsed.html ?? undefined,
        text: parsed.text ?? undefined,
        attachments,
      };

      const res = await fetch(`${env.FOLIO_BACKEND_URL}/inbound/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.FOLIO_INBOUND_SECRET}`,
        },
        body: JSON.stringify(payload),
      });

      // Accept the mail regardless so senders never get a bounce; log failures.
      if (!res.ok) console.log("folio inbound POST failed", res.status, await res.text());
    } catch (err) {
      console.log("folio email worker error", String(err));
    }
  },
};

/** Base64-encode an ArrayBuffer/Uint8Array (Workers have btoa, not Buffer). */
function bytesToBase64(content) {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
