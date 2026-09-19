/**
 * lib/geocode-one.js — new 2026-09-21
 *
 * Single-address geocoding call, extracted from geocode-addresses.js so
 * placeholder-sites.js can reuse the exact same logic instead of writing a
 * second, potentially-drifting copy. geocode-addresses.js now imports this
 * too rather than keeping its own inline version.
 *
 * Trigger: OHTMP001 (a real site-survey placeholder, Pataskala Kroger #591,
 * created 2026-09-18) sat with lat/lng permanently null -- createPlaceholderSite
 * saved the address text but never geocoded it, so every mileage
 * calculation touching that stop showed NaN instead of a real or even
 * estimated distance. geocode-addresses.js was always the only thing that
 * ever geocoded a site, and it's a separate, manually-triggered admin
 * action -- a placeholder created between manual runs had no coordinates
 * until someone happened to re-run it for that state.
 */

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

async function geocodeOne(address, apiKey) {
  if (!address || address.trim().length < 8) return { error: "address too short" };
  if (/\bTBD\b|PLACEHOLDER|Address TBD/i.test(address)) return { error: "TBD/placeholder" };
  try {
    const url =
      GEOCODE_URL +
      "?address=" +
      encodeURIComponent(address.trim()) +
      "&key=" +
      apiKey;
    const res = await fetch(url);
    if (!res.ok) return { error: "HTTP " + res.status };
    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) return { error: data.status + (data.error_message ? ": " + data.error_message : "") };
    const loc = data.results[0].geometry.location;
    return {
      lat: loc.lat,
      lng: loc.lng,
      formatted: data.results[0].formatted_address,
    };
  } catch (e) {
    return { error: "exception: " + e.message };
  }
}

module.exports = { geocodeOne };
