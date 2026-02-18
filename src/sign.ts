import { createHmac } from 'crypto'

/**
 * Computes the MergeMeter HMAC-SHA256 request signature.
 *
 * Why: the ingest API verifies every request with this signature to prevent
 * tampering and replay attacks. The same algorithm runs on the server in
 * lib/signature/verifySignature.ts — any change here must be mirrored there.
 *
 * Format: HMAC-SHA256(secret, timestamp + "." + rawBody)
 * Returns: "v1=<hex>"
 *
 * Inputs:
 * - secret: the HMAC secret from the MergeMeter dashboard
 * - timestamp: unix seconds as a string (from x-mm-timestamp header)
 * - rawBody: the exact JSON string that will be sent as the request body
 */
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const message = `${timestamp}.${rawBody}`
  const hex = createHmac('sha256', secret).update(message).digest('hex')
  return `v1=${hex}`
}

/**
 * Builds the idempotency key for a PR merge event.
 *
 * Why: the ingest API uses this key to detect duplicate submissions
 * (e.g. GitHub retrying a failed webhook). The server returns 200 on
 * a duplicate with an identical payload, and 409 if the payload differs.
 *
 * Format: "repo_id:pr_number:merge_commit_sha"
 */
export function buildIdempotencyKey(
  repoId: string,
  prNumber: number,
  mergeCommitSha: string,
): string {
  return `${repoId}:${prNumber}:${mergeCommitSha}`
}
