// api/transcript.js
// Vercel serverless function — fetches YouTube transcript server-side
// bypassing the CORS block that happens in the browser

export default async function handler(req, res) {
  const { videoId } = req.query

  if (!videoId) {
    return res.status(400).json({ error: 'videoId required' })
  }

  try {
    const response = await fetch(
      `https://youtubetranscript.com/?server_vid=${encodeURIComponent(videoId)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)',
          'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      }
    )

    if (!response.ok) {
      return res.status(response.status).json({ error: `Transcript fetch failed: ${response.status}` })
    }

    const text = await response.text()

    // Forward with CORS headers so the browser can read it
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'text/html')
    res.status(200).send(text)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
