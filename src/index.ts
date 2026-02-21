import * as core from '@actions/core'
import * as github from '@actions/github'
import { computeSignature, buildIdempotencyKey } from './sign'

const INGEST_URL = 'https://mergemeter-gateway.vercel.app/api/ingest/github'
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReviewEntry {
  reviewer_login: string
  reviewer_id: number
  state: string
  submitted_at: string
}

interface IngestPayload {
  // Core identity
  repo_id: string
  repo_full_name: string
  pr_number: number
  merge_commit_sha: string
  pr_url: string
  author_login: string
  author_id: number
  merged_by_login: string
  merged_by_id: number

  // Lifecycle timestamps
  merged_at: string
  created_at: string
  updated_at: string
  closed_at: string
  draft: boolean

  // PR text signals
  pr_title: string
  title_length: number
  has_body: boolean
  body_length: number

  // Change size metrics
  additions: number
  deletions: number
  changed_files: number
  commits_count: number

  // Review detail
  requested_reviewer_count: number
  requested_team_count: number
  reviews: ReviewEntry[]
  approvers: string[]
  approver_count: number
  changes_requested_count: number
  reviewer_count: number
  first_review_submitted_at: string | null
  last_review_submitted_at: string | null
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

  if (lastResponse) return lastResponse
  throw new Error('All retry attempts failed with network errors')
}

/**
 * Fetches all submitted reviews for a PR via the GitHub REST API.
 * Returns only identity, state, and timestamp — no review body text.
 */
async function fetchReviews(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewEntry[]> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  return reviews
    .filter((r) => r.user != null && r.submitted_at != null)
    .map((r) => ({
      reviewer_login: r.user!.login,
      reviewer_id: r.user!.id,
      state: r.state,
      submitted_at: r.submitted_at!,
    }))
}

/**
 * Derives approval summary fields from a raw review list.
 *
 * "Latest state per reviewer" is determined by sorting reviews by submitted_at
 * ascending and taking the last entry per reviewer_login. This correctly
 * handles reviewers who re-reviewed after an earlier CHANGES_REQUESTED.
 *
 * reviewer_count is the number of unique reviewers who submitted any review.
 */
function deriveReviewSummary(reviews: ReviewEntry[]): {
  approvers: string[]
  approver_count: number
  changes_requested_count: number
  reviewer_count: number
  first_review_submitted_at: string | null
  last_review_submitted_at: string | null
} {
  if (reviews.length === 0) {
    return {
      approvers: [],
      approver_count: 0,
      changes_requested_count: 0,
      reviewer_count: 0,
      first_review_submitted_at: null,
      last_review_submitted_at: null,
    }
  }

  const sorted = [...reviews].sort(
    (a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime(),
  )

  // Last review state per reviewer
  const latestByUser = new Map<string, string>()
  for (const review of sorted) {
    latestByUser.set(review.reviewer_login, review.state)
  }

  const approvers = [...latestByUser.entries()]
    .filter(([, state]) => state === 'APPROVED')
    .map(([login]) => login)

  const changes_requested_count = [...latestByUser.entries()].filter(
    ([, state]) => state === 'CHANGES_REQUESTED',
  ).length

  return {
    approvers,
    approver_count: approvers.length,
    changes_requested_count,
    reviewer_count: latestByUser.size,
    first_review_submitted_at: sorted[0].submitted_at,
    last_review_submitted_at: sorted[sorted.length - 1].submitted_at,
  }
}

/**
 * Builds the ingest payload from the GitHub event context and REST API.
 *
 * The PR title is included so the survey page can show respondents which PR
 * they are rating. The PR body is reduced to a length/presence signal only.
 * File paths and directory names are not included.
 * Reviewer/team lists are replaced with counts to avoid exposing org structure.
 */
async function buildPayload(
  octokit: ReturnType<typeof github.getOctokit>,
): Promise<IngestPayload> {
  const { context } = github
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pr = context.payload.pull_request as Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = context.payload.repository as Record<string, any>

  if (!pr) throw new Error('pull_request is missing from the event payload')
  if (!repo) throw new Error('repository is missing from the event payload')

  const { owner, repo: repoName } = context.repo
  const prNumber = Number(pr.number)

  const reviews = await fetchReviews(octokit, owner, repoName, prNumber)
  const reviewSummary = deriveReviewSummary(reviews)

  const title = pr.title != null ? String(pr.title) : ''
  const body = pr.body != null ? String(pr.body) : null

  return {
    // Core identity
    repo_id: String(repo.id),
    repo_full_name: String(repo.full_name),
    pr_number: prNumber,
    merge_commit_sha: String(pr.merge_commit_sha),
    pr_url: String(pr.html_url),
    author_login: String(pr.user.login),
    author_id: Number(pr.user.id),
    merged_by_login: String(pr.merged_by?.login ?? pr.user.login),
    merged_by_id: Number(pr.merged_by?.id ?? pr.user.id),

    // Lifecycle timestamps
    merged_at: String(pr.merged_at),
    created_at: String(pr.created_at),
    updated_at: String(pr.updated_at),
    closed_at: String(pr.closed_at),
    draft: Boolean(pr.draft),

    // PR text signals
    pr_title: title,
    title_length: title.length,
    has_body: body !== null && body.length > 0,
    body_length: body !== null ? body.length : 0,

    // Change size metrics
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    changed_files: Number(pr.changed_files ?? 0),
    commits_count: Number(pr.commits ?? 0),

    // Review detail
    requested_reviewer_count: (pr.requested_reviewers ?? []).length,
    requested_team_count: (pr.requested_teams ?? []).length,
    reviews,
    ...reviewSummary,
  }
}

/**
 * Posts the Change Confidence survey comment to the PR using the GitHub API.
 *
 * Errors are logged as warnings. A comment failure must never fail CI.
 */
async function postPrComment(
  octokit: ReturnType<typeof github.getOctokit>,
  prNumber: number,
  bodyMarkdown: string,
): Promise<void> {
  try {
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
 * 2. Build payload (event context + REST API call for reviews)
 * 3. Sign payload with HMAC-SHA256
 * 4. POST to MergeMeter ingest API (with retry on 5xx)
 * 5. Post the returned survey comment to the PR
 *
 * Error philosophy: API and comment failures are logged as warnings, not errors.
 * The action must never cause a CI pipeline to fail — MergeMeter is advisory only.
 */
async function run(): Promise<void> {
  const secret = core.getInput('secret', { required: true })
  const githubToken = core.getInput('github-token', { required: true })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pr = github.context.payload.pull_request as Record<string, any> | undefined

  // Guard: only fire on actual merges, not just closed PRs
  if (!pr?.merged) {
    core.info('MergeMeter: PR was closed without merging — skipping')
    return
  }

  const octokit = github.getOctokit(githubToken)

  let payload: IngestPayload
  try {
    payload = await buildPayload(octokit)
  } catch (err) {
    core.warning(`MergeMeter: could not build payload — ${err}`)
    return
  }

  // Use the GitHub org/account numeric ID from the event payload.
  const orgIdValue =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (github.context.payload as any).organization?.id ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (github.context.payload as any).repository?.owner?.id

  if (orgIdValue == null) {
    core.warning('MergeMeter: could not determine GitHub organization ID from event payload')
    return
  }
  const orgId = String(orgIdValue)

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
      await postPrComment(octokit, payload.pr_number, result.comment.body_markdown)
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
