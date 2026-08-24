/**
 * QMS SSO mint bridge for PetZone POS.
 * POST /api/qms/sso
 * Roles: ADMIN, CASHIER
 */
const http = require('http')
const https = require('https')
const { URL } = require('url')
const express = require('express')

const router = express.Router()

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
 * Body: { screen: 'kiosk'|'counter', orgSlug, branchSlug }
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
    const orgSlug = String(req.body?.orgSlug || '').trim()
    const branchSlug = String(req.body?.branchSlug || '').trim()
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

    return res.json({
      success: true,
      unlockUrl: data.unlockUrl,
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
