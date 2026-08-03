let detectedBaseUrl = '';

/**
 * Set the auto-detected base URL captured from Express request middleware
 * @param {string} url 
 */
function setDetectedBaseUrl(url) {
  if (url && typeof url === 'string') {
    detectedBaseUrl = url.trim().replace(/\/+$/, '');
  }
}

/**
 * Automatically determine the server's public Base URL.
 * Priority:
 * 1. process.env.SERVER_URL (Testing override - misal ngrok untuk testing lokal)
 * 2. process.env.BASE_URL (Manual override jika ada)
 * 3. Dynamic Express request host/proto (jika req di-pass)
 * 4. Previously captured base URL dari incoming HTTP request
 * 5. Platform environment variables (Railway, Render, Vercel, Fly.io, etc.)
 * 6. Localhost fallback (http://localhost:3000)
 * 
 * @param {Object} [req] - Express request object
 * @returns {string} Fully qualified base URL (misal "https://my-app.up.railway.app")
 */
function getBaseUrl(req = null) {
  // 1. Dedicated testing override: SERVER_URL atau BASE_URL
  const envUrl = process.env.SERVER_URL || process.env.BASE_URL;
  if (envUrl && envUrl.trim() !== '') {
    let url = envUrl.trim().replace(/\/+$/, '');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }
    return url;
  }

  // 2. Extract dynamically from active Express request if provided
  if (req) {
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    if (host) {
      const url = `${proto}://${host}`.replace(/\/+$/, '');
      detectedBaseUrl = url;
      return url;
    }
  }

  // 3. Captured base URL from previous incoming HTTP requests
  if (detectedBaseUrl) {
    return detectedBaseUrl;
  }

  // 4. Auto-detect from cloud hosting environment variables
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN.trim().replace(/\/+$/, '');
    return domain.startsWith('http') ? domain : `https://${domain}`;
  }
  if (process.env.RAILWAY_STATIC_URL) {
    const domain = process.env.RAILWAY_STATIC_URL.trim().replace(/\/+$/, '');
    return domain.startsWith('http') ? domain : `https://${domain}`;
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    const domain = process.env.RENDER_EXTERNAL_URL.trim().replace(/\/+$/, '');
    return domain.startsWith('http') ? domain : `https://${domain}`;
  }
  if (process.env.VERCEL_URL) {
    const domain = process.env.VERCEL_URL.trim().replace(/\/+$/, '');
    return domain.startsWith('http') ? domain : `https://${domain}`;
  }
  if (process.env.FLY_APP_NAME) {
    return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  }

  // 5. Fallback for local development environment
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

module.exports = {
  getBaseUrl,
  setDetectedBaseUrl
};
