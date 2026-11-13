/**
 * Ensure QMS link columns + backfill branches.settings.qms.
 *
 * Usage (set DB_* and optionally QMS_APP_URL first):
 *   node scripts/backfill-branch-qms.js
 *
 * Safe to re-run: existing settings.qms values and custom URLs are preserved.
 */
const { executeQuery, pool } = require('../config/database')

function parseSettings(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function buildScreenUrls(orgSlug, branchSlug) {
  const appUrl = (process.env.QMS_APP_URL || '').replace(/\/$/, '')
  if (!appUrl || !orgSlug || !branchSlug) {
    return { kioskUrl: null, opdUrl: null }
  }
  const org = encodeURIComponent(orgSlug)
  const branch = encodeURIComponent(branchSlug)
  return {
    kioskUrl: `${appUrl}/kiosk/${org}/${branch}`,
    opdUrl: `${appUrl}/opd/${org}/${branch}`,
  }
}

async function columnExists(table, column) {
  const rows = await executeQuery(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  )
  return Number(rows[0]?.c || 0) > 0
}

async function ensureSchema() {
  if (!(await columnExists('qms_branches', 'pos_branch_id'))) {
    await executeQuery('ALTER TABLE qms_branches ADD COLUMN pos_branch_id INT UNSIGNED DEFAULT NULL')
    console.log('Added qms_branches.pos_branch_id')
  }
  try {
    await executeQuery('ALTER TABLE qms_branches ADD KEY idx_pos_branch (pos_branch_id)')
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME') throw err
  }
  if (!(await columnExists('qms_branches', 'counter_pin'))) {
    await executeQuery('ALTER TABLE qms_branches ADD COLUMN counter_pin VARCHAR(32) DEFAULT NULL')
    console.log('Added qms_branches.counter_pin')
  }
  if (!(await columnExists('qms_branches', 'kiosk_pin'))) {
    await executeQuery('ALTER TABLE qms_branches ADD COLUMN kiosk_pin VARCHAR(32) DEFAULT NULL')
    console.log('Added qms_branches.kiosk_pin')
  }
}

function guessOrgSlug(branch, settings) {
  const brand = String(settings.brand || '').toLowerCase()
  if (brand === 'petzone' || brand === 'petfamily') return brand
  const name = String(branch.name || '').toLowerCase()
  if (name.includes('petfamily')) return 'petfamily'
  if (name.includes('petzone')) return 'petzone'
  return null
}

function guessBranchSlug(branch) {
  return String(branch.name || '').toLowerCase().includes('north') ? 'north' : 'main'
}

async function main() {
  await ensureSchema()

  const branches = await executeQuery('SELECT id, name, code, settings FROM branches ORDER BY id')
  const qmsBranches = await executeQuery(
    `SELECT b.id, b.name, b.slug, b.pos_branch_id, o.slug AS org_slug
     FROM qms_branches b
     JOIN qms_organizations o ON o.id = b.org_id`
  )

  const qmsByPosBranch = new Map()
  const claimed = new Set()
  for (const qms of qmsBranches) {
    if (qms.pos_branch_id) {
      qmsByPosBranch.set(Number(qms.pos_branch_id), qms)
      claimed.add(Number(qms.id))
    }
  }

  let updated = 0
  let linked = 0
  const unlinked = []

  for (const branch of branches) {
    const settings = parseSettings(branch.settings)
    const existingQms = settings.qms && typeof settings.qms === 'object' ? settings.qms : {}

    let qms = qmsByPosBranch.get(Number(branch.id))
    if (!qms) {
      const orgSlug = existingQms.orgSlug || guessOrgSlug(branch, settings)
      const branchSlug = existingQms.branchSlug || guessBranchSlug(branch)
      if (orgSlug) {
        const candidate = qmsBranches.find(
          (row) => row.org_slug === orgSlug && row.slug === branchSlug && !claimed.has(Number(row.id))
        )
        if (candidate) {
          qms = candidate
          claimed.add(Number(candidate.id))
        }
      }
    }

    if (!qms) {
      unlinked.push(`#${branch.id} ${branch.name} (${branch.code})`)
      continue
    }

    const urls = buildScreenUrls(qms.org_slug, qms.slug)
    const nextQms = {
      orgSlug: existingQms.orgSlug || qms.org_slug,
      branchSlug: existingQms.branchSlug || qms.slug,
      kioskUrl: existingQms.kioskUrl || urls.kioskUrl,
      opdUrl: existingQms.opdUrl || urls.opdUrl,
      opdCounterCount: existingQms.opdCounterCount ?? null,
    }

    await executeQuery('UPDATE branches SET settings = ? WHERE id = ?', [
      JSON.stringify({ ...settings, qms: nextQms }),
      branch.id,
    ])
    await executeQuery(
      'UPDATE qms_branches SET pos_branch_id = NULL WHERE pos_branch_id = ? AND id <> ?',
      [branch.id, qms.id]
    )
    await executeQuery('UPDATE qms_branches SET pos_branch_id = ? WHERE id = ?', [
      branch.id,
      qms.id,
    ])

    updated += 1
    linked += 1
    console.log(
      `branch #${branch.id} ${branch.name} -> qms#${qms.id} ${qms.org_slug}/${qms.slug}`
    )
  }

  console.log(`\nDone. qms settings written: ${updated}, links synced: ${linked}`)
  if (unlinked.length) {
    console.log('\nBranches with no matching QMS branch (configure them in the Branches form):')
    for (const line of unlinked) console.log(`- ${line}`)
  }
}

main()
  .then(async () => {
    await pool.end()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error(err)
    try {
      await pool.end()
    } catch (_) {
      /* ignore */
    }
    process.exit(1)
  })
