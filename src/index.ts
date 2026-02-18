import * as core from '@actions/core'
import * as github from '@actions/github'
import { computeSignature, buildIdempotencyKey } from './sign'

const INGEST_URL = 'https://mergemeter-gateway.vercel.app/api/ingest/github'
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReviewEntry {
  user_login: string
  state: string
  submitted_at: string
}

interface IngestPayload {
  // Core
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
  reviewers: string[] // requested reviewer logins — kept for backward compat

  // A) Semantic text fields
  title: string
  body: string | null
  comments_count: number
  review_comments_count: number

  // B) Lifecycle timestamps
  created_at: string
  updated_at: string
  closed_at: string
  draft: boolean
  ready_for_review_at?: string // only present when GitHub includes it

  // C) Commits
  commits_count: number

  // D) Review detail
  requested_reviewers: string[]
  requested_teams: string[]
  reviews: ReviewEntry[]
  approvers: string[]
  approver_count: number
  changes_requested_count: number
  first_review_submitted_at: string | null
  last_review_submitted_at: string | null

  // E) Change content signals
  file_extensions: Record<string, number>
  top_level_dirs: Record<string, number>

  // F) PR URL
  pr_url: string
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
 * Paginated to handle PRs with many reviews.
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
      user_login: r.user!.login,
      state: r.state,
      submitted_at: r.submitted_at!,
    }))
}

/**
 * Fetches all changed file paths for a PR via the GitHub REST API.
 * Paginated — GitHub caps at 300 files per PR but uses per_page pagination.
 */
async function fetchChangedFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })
  return files.map((f) => f.filename)
}

/**
 * Builds a map of file extension → count from a list of filenames.
 * Example: ["src/foo.ts", "docs/bar.md"] → { "ts": 1, "md": 1 }
 * Files without an extension are skipped.
 */
function computeFileExtensions(files: string[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const file of files) {
    const dotIndex = file.lastIndexOf('.')
    const slashIndex = file.lastIndexOf('/')
    // Extension must appear after the last slash (i.e. in the filename, not a dot-dir)
    if (dotIndex > slashIndex && dotIndex < file.length - 1) {
      const ext = file.slice(dotIndex + 1)
      result[ext] = (result[ext] ?? 0) + 1
    }
  }
  return result
}

/**
 * Builds a map of top-level directory → count from a list of filenames.
 * Example: ["src/foo.ts", "src/bar.ts", "docs/readme.md"] → { "src": 2, "docs": 1 }
 * Files at the repo root (no slash) are counted under "(root)".
 */
function computeTopLevelDirs(files: string[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const file of files) {
    const slashIndex = file.indexOf('/')
    const dir = slashIndex === -1 ? '(root)' : file.slice(0, slashIndex)
    result[dir] = (result[dir] ?? 0) + 1
  }
  return result
}

/**
 * Derives approval summary fields from a raw review list.
 *
 * "Latest state per reviewer" is computed by sorting reviews by submitted_at
 * ascending and taking the last entry per user.login. This correctly handles
 * reviewers who re-reviewed after an earlier CHANGES_REQUESTED.
 */
function deriveReviewSummary(reviews: ReviewEntry[]): {
  approvers: string[]
  approver_count: number
  changes_requested_count: number
  first_review_submitted_at: string | null
  last_review_submitted_at: string | null
} {
  if (reviews.length === 0) {
    return {
      approvers: [],
      approver_count: 0,
      changes_requested_count: 0,
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
    latestByUser.set(review.user_login, review.state)
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
    first_review_submitted_at: sorted[0].submitted_at,
    last_review_submitted_at: sorted[sorted.length - 1].submitted_at,
  }
}

/**
 * Builds the full ingest payload from the GitHub event context and REST API.
 *
 * Async because it fetches reviews and changed files in parallel via Octokit.
 * Both fetches are paginated so large PRs are handled correctly.
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

  // Fetch reviews and files in parallel — both are needed for the payload
  const [reviews, files] = await Promise.all([
    fetchReviews(octokit, owner, repoName, prNumber),
    fetchChangedFiles(octokit, owner, repoName, prNumber),
  ])

  const reviewSummary = deriveReviewSummary(reviews)

  const requestedReviewers: string[] = (pr.requested_reviewers ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: Record<string, any>) => String(r.login))
    .filter(Boolean)

  const requestedTeams: string[] = (pr.requested_teams ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: Record<string, any>) => String(t.slug))
    .filter(Boolean)

  const payload: IngestPayload = {
    // Core
    repo_id: String(repo.id),
    repo_full_name: String(repo.full_name),
    pr_number: prNumber,
    merge_commit_sha: String(pr.merge_commit_sha),
    merged_at: String(pr.merged_at),
    author_login: String(pr.user.login),
    merged_by_login: String(pr.merged_by?.login ?? pr.user.login),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    changed_files: Number(pr.changed_files ?? 0),
    reviewers: requestedReviewers, // kept for backward compat with existing API schema

    // A) Semantic text fields
    title: String(pr.title),
    body: pr.body != null ? String(pr.body) : null,
    comments_count: Number(pr.comments ?? 0),
    review_comments_count: Number(pr.review_comments ?? 0),

    // B) Lifecycle timestamps
    created_at: String(pr.created_at),
    updated_at: String(pr.updated_at),
    closed_at: String(pr.closed_at),
    draft: Boolean(pr.draft),

    // C) Commits
    commits_count: Number(pr.commits ?? 0),

    // D) Review detail
    requested_reviewers: requestedReviewers,
    requested_teams: requestedTeams,
    reviews,
    ...reviewSummary,

    // E) Change content signals
    file_extensions: computeFileExtensions(files),
    top_level_dirs: computeTopLevelDirs(files),

    // F) PR URL
    pr_url: String(pr.html_url),
  }

  // ready_for_review_at — only present when GitHub includes it in the event payload
  if (pr.ready_for_review_at != null) {
    payload.ready_for_review_at = String(pr.ready_for_review_at)
  }

  return payload
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
 * 2. Build payload (event context + REST API calls for reviews and files)
 * 3. Sign payload with HMAC-SHA256
 * 4. POST to MergeMeter ingest API (with retry on 5xx)
 * 5. Post the returned survey comment to the PR
 *
 * Error philosophy: API and comment failures are logged as warnings, not errors.
 * The action must never cause a CI pipeline to fail — MergeMeter is advisory only.
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

  const octokit = github.getOctokit(githubToken)

  let payload: IngestPayload
  try {
    payload = await buildPayload(octokit)
  } catch (err) {
    core.warning(`MergeMeter: could not build payload — ${err}`)
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
