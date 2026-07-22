/**
 * get-maps-key.js
 * Serves the Google Maps API key from an environment variable so it doesn't
 * need to be hardcoded in index.html (which triggers Netlify secrets scanning).
 *
 * GET /.netlify/functions/get-maps-key
 * Returns: { key: "..." }
 *
 * Requires env var: GOOGLE_MAPS_API_KEY
 */

exports.handler = async () => {
  const key = process.env.GOOGLE_MAPS_API_KEY || "";
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  };
};
