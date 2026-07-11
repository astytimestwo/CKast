# GitHub Publishing Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare CKast for a standard public GitHub update with clean repository contents, Node 20/22 CI, security guidance, and contribution guidance.

**Architecture:** Keep publishing support declarative and isolated: repository-policy documents at the root, one GitHub Actions workflow under `.github/workflows`, and a static repository-readiness regression test. Do not add deployment or release automation.

**Tech Stack:** Node.js 20/22, Node test runner, npm, GitHub Actions YAML, Markdown.

## Global Constraints

- Do not push, deploy, publish packages, create releases, or contact GitHub.
- Support Node.js 20 and 22; remove the obsolete Node 16 promise.
- CI runs only `npm ci`, `npm test`, and `npm run check` from `pc-broadcaster`.
- Remove personal network defaults and unused tracked artifacts without changing the TV address persistence flow.
- Preserve all existing casting behavior and all 79 regression tests.

---

### Task 1: Repository cleanup, runtime floor, and CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `pc-broadcaster/test/repositoryPublishing.test.js`
- Modify: `pc-broadcaster/package.json`
- Modify: `README.md`
- Modify: `pc-broadcaster/README.md`
- Modify: `tv-app/js/main.js`
- Delete: `js/main.js`

**Interfaces:**
- Produces: a CI matrix for Node 20 and 22 and a static test enforcing the public-release contract.

- [x] **Step 1: Add a failing repository-readiness test**

Create assertions that require `engines.node` to be `>=20`, require CI matrix values 20 and 22 plus the three approved npm commands, reject `10.204.247.239`, require `192.168.1.10`, and require the root `js/main.js` path not to exist.

- [x] **Step 2: Run the focused test and verify failure**

Run: `node --test test/repositoryPublishing.test.js`

Expected: failure because the package still promises Node 16, the personal IP and empty file remain, and the workflow does not exist.

- [x] **Step 3: Apply the minimal publishing changes**

Set `engines.node` to `>=20`, update Node requirements in both READMEs, replace the TV fallback IP with `192.168.1.10`, delete the empty root file, and create `.github/workflows/ci.yml` with push/pull-request triggers and this job sequence:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: ${{ matrix.node-version }}
    cache: npm
    cache-dependency-path: pc-broadcaster/package-lock.json
- run: npm ci
- run: npm test
- run: npm run check
```

Set each run step's `working-directory` to `pc-broadcaster` and matrix versions to `[20, 22]`.

- [x] **Step 4: Run the focused and full tests**

Run: `node --test test/repositoryPublishing.test.js`

Expected: pass.

Run: `npm test`

Expected: all tests pass.

---

### Task 2: Public security and contribution guidance

**Files:**
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`
- Modify: `pc-broadcaster/test/repositoryPublishing.test.js`

**Interfaces:**
- Produces: public reporting and contribution policies linked to runnable project commands.

- [x] **Step 1: Extend the readiness test**

Assert that both root documents exist; `SECURITY.md` mentions trusted local networks, private reporting, and no public disclosure; `CONTRIBUTING.md` contains `npm ci`, `npm test`, and `npm run check`.

- [x] **Step 2: Run the test and verify failure**

Run: `node --test test/repositoryPublishing.test.js`

Expected: failure because the two policy documents do not exist.

- [x] **Step 3: Add concise policy documents**

Document CKast's unencrypted LAN trust boundary, private reporting through GitHub's vulnerability-reporting interface or repository-owner contact, supported-version policy, local setup, test commands, focused branches, and pull-request expectations.

- [x] **Step 4: Run the focused test**

Run: `node --test test/repositoryPublishing.test.js`

Expected: pass.

---

### Task 3: Final publication audit and local commit

**Files:**
- Verify: all changed files from Tasks 1-2

**Interfaces:**
- Produces: one clean local publishing-readiness commit; no remote changes.

- [x] **Step 1: Run verification**

Run `npm test`, `npm run check`, `npm audit --omit=dev`, `git diff --check`, and syntax-check every tracked JavaScript file.

- [x] **Step 2: Re-run public-content scans**

Verify no tracked private-key/token markers, environment files, personal fallback IP, generated `.wgt` package, archive, executable, or file over 1 MiB.

- [x] **Step 3: Review the exact diff**

Confirm changes are limited to the approved cleanup, CI, policies, tests, runtime requirement, design, and implementation plan.

- [x] **Step 4: Commit locally**

```powershell
git add -A
git commit -m "chore: prepare repository for public GitHub release"
```

Do not push.
