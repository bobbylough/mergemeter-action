import * as core from '@actions/core'
import * as github from '@actions/github'
import { computeSignature, buildIdempotencyKey } from './sign'

const INGEST_URL = 'https://mergemeter-gateway.vercel.app/api/ingest/github'
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

// ── Types ─────────────────────────────────────────────────────────────────────

interface IngestPayload {
  repo_id: string
  repo_full_name: string
  pr_number: number
  merge_commit_sha: string
  merged_at: string
  author_login: string
  merged_by_login: string
  additions: number
  deletions: number
  changed_files: number
  reviewers: string[]
}

interface IngestResponse {
  status: 'ok'
  comment: { body_markdown: string }
  survey_links: { creator_url: string; reviewer_urls: string[] }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POSTs a JSON body to the ingest URL, retrying up to MAX_RETRIES times on
 * 5xx responses or network failures. 4xx responses are returned immediately
 * without retry — they indicate a client error that won't change.
 *
 * Why: GitHub Actions may occasionally hit transient 5xx errors. Retrying
 * gives the API a chance to recover without manual intervention.
 */
async function postWithRetry(
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  let lastResponse: Response | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2) // 1s, 2s
      core.info(`MergeMeter: retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
      await sleep(delay)
    }

    try {
      const response = await fetch(INGEST_URL, { method: 'POST', headers, body })

      // 4xx = client error, do not retry
      if (response.status < 500) return response

      lastResponse = response
      core.warning(
        `MergeMeter: server error ${response.status} on attempt ${attempt}/${MAX_RETRIES}`,
      )
    } catch (err) {
      core.warning(
        `MergeMeter: network error on attempt ${attempt}/${MAX_RETRIES}: ${err}`,
      )
    }
  }

  // Return the last known 5xx response rather than throwing, so callers can log it
  if (lastResponse) return lastResponse
  throw new Error('All retry attempts failed with network errors')
}

/**
 * Extracts and validates the ingest payload from the GitHub Actions event context.
 *
 * Why: the ingest API expects a specific set of fields. This function maps
 * the GitHub pull_request event fields to that schema.
 *
 * Throws if required event fields are missing — this should never happen
 * for a correctly configured trigger.
 */
function buildPayload(): IngestPayload {
  const { context } = github
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pr = context.payload.pull_request as Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = context.payload.repository as Record<string, any>

  if (!pr) throw new Error('pull_request is missing from the event payload')
  if (!repo) throw new Error('repository is missing from the event payload')

  const reviewers: string[] = (pr.requested_reviewers ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: Record<string, any>) => String(r.login))
    .filter(Boolean)

  return {
    repo_id: String(repo.id),
    repo_full_name: String(repo.full_name),
    pr_number: Number(pr.number),
    merge_commit_sha: String(pr.merge_commit_sha),
    merged_at: String(pr.merged_at),
    author_login: String(pr.user.login),
    merged_by_login: String(pr.merged_by?.login ?? pr.user.login),
    // additions/deletions/changed_files may be absent on very large PRs — default to 0
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    changed_files: Number(pr.changed_files ?? 0),
    reviewers,
  }
}

/**
 * Posts the Change Confidence survey comment to the PR using the GitHub API.
 *
 * Why: the ingest API returns the comment markdown — the action posts it so
 * that survey links are visible directly in the PR thread.
 *
 * Errors are logged as warnings. A comment failure must never fail CI.
 */
async function postPrComment(
  githubToken: string,
  prNumber: number,
  bodyMarkdown: string,
): Promise<void> {
  try {
    const octokit = github.getOctokit(githubToken)
    const { owner, repo } = github.context.repo
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: bodyMarkdown,
    })
    core.info('MergeMeter: survey comment posted to PR')
  } catch (err) {
    core.warning(`MergeMeter: failed to post PR comment — ${err}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Entry point for the MergeMeter GitHub Action.
 *
 * Pipeline:
 * 1. Guard: skip if PR was not merged
 * 2. Build payload from GitHub event context
 * 3. Sign payload with HMAC-SHA256
 * 4. POST to MergeMeter ingest API (with retry on 5xx)
 * 5. Post the returned survey comment to the PR
 *
 * Error philosophy: API and comment failures are logged as warnings, not errors.
 * The action must never cause a CI pipeline to fail — MergeMeter is advisory only.
 * Configuration errors (missing secret/org) also warn rather than fail, since a
 * missing secret on a fork PR should not block merges.
 */
async function run(): Promise<void> {
  const secret = core.getInput('secret', { required: true })
  const orgId = core.getInput('org', { required: true })
  const githubToken = core.getInput('github-token', { required: true })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pr = github.context.payload.pull_request as Record<string, any> | undefined

  // Guard: only fire on actual merges, not just closed PRs
  if (!pr?.merged) {
    core.info('MergeMeter: PR was closed without merging — skipping')
    return
  }

  let payload: IngestPayload
  try {
    payload = buildPayload()
  } catch (err) {
    core.warning(`MergeMeter: could not read PR data from event context — ${err}`)
    return
  }

  const rawBody = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const idempotencyKey = buildIdempotencyKey(
    payload.repo_id,
    payload.pr_number,
    payload.merge_commit_sha,
  )
  const signature = computeSignature(secret, timestamp, rawBody)

  core.info(
    `MergeMeter: sending ingest event for ${payload.repo_full_name} PR #${payload.pr_number}`,
  )

  let response: Response
  try {
    response = await postWithRetry(rawBody, {
      'content-type': 'application/json',
      'x-mm-org': orgId,
      'x-mm-timestamp': timestamp,
      'x-mm-idempotency-key': idempotencyKey,
      'x-mm-signature': signature,
    })
  } catch (err) {
    core.warning(`MergeMeter: ingest request failed after all retries — ${err}`)
    return
  }

  if (response.status === 200) {
    let result: IngestResponse
    try {
      result = (await response.json()) as IngestResponse
    } catch (err) {
      core.warning(`MergeMeter: could not parse API response — ${err}`)
      return
    }

    core.info('MergeMeter: ingest successful')

    if (result.comment?.body_markdown) {
      await postPrComment(githubToken, payload.pr_number, result.comment.body_markdown)
    }
    return
  }

  if (response.status === 409) {
    core.info('MergeMeter: duplicate event — this PR was already recorded')
    return
  }

  // All other status codes — log and continue, never fail CI
  let errorBody = ''
  try {
    errorBody = await response.text()
  } catch {
    // ignore parse errors on error body
  }
  core.warning(`MergeMeter: API returned ${response.status}: ${errorBody}`)
}

// Final safety net — any uncaught error becomes a warning, never a CI failure
run().catch((err) => {
  core.warning(`MergeMeter: unexpected error — ${err}`)
})
