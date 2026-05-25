// pages/api/health.js
// Simple health check to verify API routes work
export default function handler(req, res) {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
}
