/**
 * QMS SSO mint bridge for PetZone POS.
 * POST /api/qms/sso
 * Roles: ADMIN, CASHIER
 */
const http = require('http')
const https = require('https')
const { URL } = require('url')
const express = require('express')
const Branch = require('../models/Branch')
const { executeQuery } = require('../config/database')

const router = express.Router()

function resolvePosBranchId(user, req) {
  if (user?.role === 'CASHIER' && user.branchId) return user.branchId
  const simulated = req.headers['x-simulate-scope-type']
  const simulatedId = req.headers['x-simulate-scope-id']
  if (simulated === 'BRANCH' && simulatedId) return parseInt(simulatedId, 10)
  const requested = req.query?.posBranchId || req.body?.posBranchId
  if (requested) return parseInt(requested, 10)
  return user?.branchId || null
}

function appendUnlockParam(urlString, token) {
  try {
    const url = new URL(urlString)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (token) url.searchParams.set('posUnlock', token)
    return url.toString()
  } catch {
    return null
  }
}

async function findQmsBranch({ posBranchId, orgSlug, branchSlug }) {
  try {
    if (orgSlug && branchSlug) {
      const rows = await executeQuery(
        `SELECT b.id, b.name, b.slug, o.slug AS org_slug
         FROM qms_branches b
         JOIN qms_organizations o ON o.id = b.org_id
         WHERE o.slug = ? AND b.slug = ?
         LIMIT 1`,
        [orgSlug, branchSlug]
      )
      if (rows.length) return rows[0]
    }
    if (posBranchId) {
      const rows = await executeQuery(
        `SELECT b.id, b.name, b.slug, o.slug AS org_slug
         FROM qms_branches b
         JOIN qms_organizations o ON o.id = b.org_id
         WHERE b.pos_branch_id = ?
         LIMIT 1`,
        [posBranchId]
      )
      if (rows.length) return rows[0]
    }
  } catch {
    return null
  }
  return null
}

async function loadBranchQmsConfig(posBranchId) {
  if (!posBranchId) return null
  const branch = await Branch.findById(posBranchId)
  if (!branch) return null
  const qms = branch.settings?.qms && typeof branch.settings.qms === 'object'
    ? branch.settings.qms
    : {}
  const qmsBranch = await findQmsBranch({
    posBranchId,
    orgSlug: qms.orgSlug,
    branchSlug: qms.branchSlug,
  })
  return {
    branchName: branch.name,
    qmsBranchId: qmsBranch?.id || null,
    orgSlug: qms.orgSlug || qmsBranch?.org_slug || null,
    branchSlug: qms.branchSlug || qmsBranch?.slug || null,
    kioskUrl: qms.kioskUrl || null,
    opdUrl: qms.opdUrl || null,
    opdCounterCount: qms.opdCounterCount ?? null,
  }
}

function postJson(urlString, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const lib = url.protocol === 'https:' ? https : http
    const body = JSON.stringify(bodyObj)
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          let data = {}
          try {
            data = raw ? JSON.parse(raw) : {}
          } catch {
            data = { message: raw }
          }
          resolve({ status: res.statusCode || 500, data })
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * GET /api/qms/branch-config
 * Returns the queue config stored on the logged-in (or simulated) POS branch.
 */
router.get('/branch-config', async (req, res) => {
  try {
    const posBranchId = resolvePosBranchId(req.user, req)
    if (!posBranchId) {
      return res.status(404).json({ success: false, message: 'No POS branch selected' })
    }
    const config = await loadBranchQmsConfig(posBranchId)
    if (!config) {
      return res.status(404).json({ success: false, message: 'Branch not found' })
    }
    return res.json({ success: true, data: { posBranchId, ...config } })
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to load branch queue config',
    })
  }
})

router.post('/sso', async (req, res) => {
  try {
    const role = String(req.user?.role || '').toUpperCase()
    if (role !== 'ADMIN' && role !== 'CASHIER') {
      return res.status(403).json({
        success: false,
        message: 'Only Admin and Cashier can open Queue Management with SSO',
      })
    }

    const qmsApiUrl = (
      process.env.QMS_API_URL ||
      process.env.QUEUE_API_URL ||
      'https://queue-management.petzone.pk'
    ).replace(/\/$/, '')
    const ssoSecret =
      process.env.QMS_SSO_SECRET || 'petzone-qms-sso-shared-secret'
    const appUrl = (
      process.env.QMS_APP_URL ||
      process.env.NEXT_PUBLIC_QMS_APP_URL ||
      qmsApiUrl.replace(/\/api$/i, '') ||
      'https://queue-management.petzone.pk'
    ).replace(/\/$/, '')

    const posEmail =
      req.user?.email ||
      req.user?.username ||
      `pos-user-${req.user?.id || 'unknown'}@petzone.pk`
    const posName =
      req.user?.name ||
      req.user?.fullName ||
      req.user?.username ||
      String(posEmail).split('@')[0]
    const posRole = req.user?.role || role
    const redirectPath = String(req.body?.redirectPath || '/admin').trim() || '/admin'

    const mintBase = qmsApiUrl.endsWith('/api') ? qmsApiUrl : `${qmsApiUrl}/api`
    const { status, data } = await postJson(
      `${mintBase}/auth/sso/mint`,
      { 'x-qms-sso-secret': ssoSecret },
      { posEmail, posName, posRole, redirectPath },
    )

    if (status < 200 || status >= 300 || !data.success) {
      return res.status(status === 401 ? 502 : status || 502).json({
        success: false,
        message: data.message || 'Failed to mint Queue SSO token',
      })
    }

    const ssoUrl =
      data.ssoUrl ||
      (appUrl && data.ssoToken
        ? `${appUrl}${redirectPath.startsWith('/') ? redirectPath : `/${redirectPath}`}?sso=${encodeURIComponent(data.ssoToken)}`
        : null)

    if (!ssoUrl) {
      return res.status(502).json({
        success: false,
        message: 'Queue SSO minted but QMS_APP_URL is not set',
      })
    }

    return res.json({
      success: true,
      ssoUrl,
      ssoToken: data.ssoToken,
      expiresAt: data.expiresAt,
      user: data.user,
    })
  } catch (err) {
    console.error('QMS SSO bridge error', err)
    return res.status(502).json({
      success: false,
      message: err.message || 'Queue Management unreachable',
    })
  }
})

/**
 * Mint short-lived unlock for kiosk/OPD screen lock (branch PIN bypass from POS).
 * POST /api/qms/screen-sso
 * Body: { screen: 'kiosk'|'counter', posBranchId?, orgSlug?, branchSlug? }
 * Branch config (settings.qms) supplies slugs + custom kiosk/OPD URLs.
 */
router.post('/screen-sso', async (req, res) => {
  try {
    const role = String(req.user?.role || '').toUpperCase()
    if (role !== 'ADMIN' && role !== 'CASHIER') {
      return res.status(403).json({
        success: false,
        message: 'Only Admin and Cashier can unlock queue screens from POS',
      })
    }

    const screen = String(req.body?.screen || '').toLowerCase()
    const posBranchId = resolvePosBranchId(req.user, req)
    const branchConfig = await loadBranchQmsConfig(posBranchId).catch(() => null)
    const orgSlug = String(branchConfig?.orgSlug || req.body?.orgSlug || '').trim()
    const branchSlug = String(branchConfig?.branchSlug || req.body?.branchSlug || '').trim()
    if ((screen !== 'kiosk' && screen !== 'counter') || !orgSlug || !branchSlug) {
      return res.status(400).json({
        success: false,
        message: 'screen, orgSlug, and branchSlug required',
      })
    }

    const qmsApiUrl = (
      process.env.QMS_API_URL ||
      process.env.QUEUE_API_URL ||
      'https://queue-management.petzone.pk'
    ).replace(/\/$/, '')
    const ssoSecret =
      process.env.QMS_SSO_SECRET || 'petzone-qms-sso-shared-secret'
    const mintBase = qmsApiUrl.endsWith('/api') ? qmsApiUrl : `${qmsApiUrl}/api`

    const { status, data } = await postJson(
      `${mintBase}/auth/sso/mint-screen`,
      { 'x-qms-sso-secret': ssoSecret },
      { screen, orgSlug, branchSlug },
    )

    if (status < 200 || status >= 300 || !data.success || !data.unlockUrl) {
      return res.status(status === 401 ? 502 : status || 502).json({
        success: false,
        message: data.message || 'Failed to mint screen unlock',
      })
    }

    const customUrl = screen === 'kiosk' ? branchConfig?.kioskUrl : branchConfig?.opdUrl
    const unlockUrl = customUrl
      ? (appendUnlockParam(customUrl, data.unlockToken) || customUrl)
      : data.unlockUrl

    return res.json({
      success: true,
      unlockUrl,
      unlockToken: data.unlockToken,
      expiresAt: data.expiresAt,
    })
  } catch (err) {
    console.error('QMS screen SSO bridge error', err)
    return res.status(502).json({
      success: false,
      message: err.message || 'Queue Management unreachable',
    })
  }
})

module.exports = router
