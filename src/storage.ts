import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Tigris (S3-compatible) object storage. Credentials + endpoint come from the
// AWS_* env vars that `fly storage create` sets on the app. The bucket is public
// so uploaded images are served directly from the Tigris CDN.
const endpoint = process.env.AWS_ENDPOINT_URL_S3 || "https://fly.storage.tigris.dev";
const bucket = process.env.BUCKET_NAME || "";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "auto",
  endpoint,
  // Tigris uses virtual-hosted-style; the SDK handles it via forcePathStyle=false.
  forcePathStyle: false,
});

export const storageEnabled = Boolean(
  bucket && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
);

/** Upload bytes and return the public URL. `key` should include any prefix. */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  // Public-bucket URL (virtual-hosted): https://<bucket>.fly.storage.tigris.dev/<key>
  const host = endpoint.replace(/^https?:\/\//, "");
  return `https://${bucket}.${host}/${key}`;
}
