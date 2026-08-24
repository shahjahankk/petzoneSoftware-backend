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
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * Thin bridge: mint LabelPress SSO URL via separate barcode-backend.
 * Does NOT proxy label CRUD — keeps load off this POS process.
 *
 * POST /api/barcode/sso
 * Auth: POS Bearer token (global middleware)
 * Roles: ADMIN, WAREHOUSE_KEEPER
 */
router.post('/sso', async (req, res) => {
  try {
    const role = String(req.user?.role || '').toUpperCase()
    if (role !== 'ADMIN' && role !== 'WAREHOUSE_KEEPER') {
      return res.status(403).json({
        success: false,
        message: 'Only Admin and Warehouse can open Barcode Labels',
      })
    }

    const barcodeApiUrl = (
      process.env.BARCODE_API_URL ||
      'https://barcode-printer.petzone.pk'
    ).replace(/\/$/, '')
    const ssoSecret =
      process.env.BARCODE_SSO_SECRET || 'petzone-barcode-sso-shared-secret'
    const appUrl = (
      process.env.BARCODE_APP_URL ||
      process.env.NEXT_PUBLIC_BARCODE_APP_URL ||
      'https://barcode-printer.petzone.pk'
    ).replace(/\/$/, '')

    if (!barcodeApiUrl || !ssoSecret) {
      return res.status(503).json({
        success: false,
        message: 'Barcode service not configured (BARCODE_API_URL / BARCODE_SSO_SECRET)',
      })
    }

    const posUsername =
      req.user?.username || req.user?.email || `pos-${req.user?.id || 'user'}`
    const posRole = req.user?.role || role

    const { status, data } = await postJson(
      `${barcodeApiUrl}/api/auth/sso/mint`,
      { 'x-barcode-sso-secret': ssoSecret },
      { posUsername, posRole }
    )

    if (status < 200 || status >= 300 || !data.success) {
      return res.status(status === 401 ? 502 : status || 502).json({
        success: false,
        message: data.message || 'Failed to mint barcode SSO token',
      })
    }

    const ssoUrl =
      data.ssoUrl ||
      (appUrl && data.ssoToken
        ? `${appUrl}/?sso=${encodeURIComponent(data.ssoToken)}`
        : null)

    if (!ssoUrl) {
      return res.status(502).json({
        success: false,
        message: 'Barcode SSO minted but BARCODE_APP_URL is not set',
      })
    }

    return res.json({
      success: true,
      ssoUrl,
      expiresAt: data.expiresAt,
      user: data.user,
    })
  } catch (err) {
    console.error('barcode SSO bridge error', err)
    return res.status(502).json({
      success: false,
      message: err.message || 'Barcode service unreachable',
    })
  }
})

module.exports = router
