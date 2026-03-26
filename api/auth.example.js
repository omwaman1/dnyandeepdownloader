// Copy this file as auth.js and fill in your session cookies
// Get these from Chrome DevTools → Network tab → Copy as cURL

const COOKIE = [
  "SESSIONID=YOUR_SESSION_ID_HERE",
  // Add other cookies from your browser
].join("; ");

const BASE_URL = "https://dnyanadeepsaralseva.graphy.com";
const COURSE_ID = "YOUR_COURSE_ID_HERE";

const PAGE_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  cookie: COOKIE,
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

const API_HEADERS = {
  accept: "application/json, text/javascript, */*; q=0.01",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json; charset=utf-8",
  cookie: COOKIE,
  referer: `${BASE_URL}/s/courses/${COURSE_ID}/take`,
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "x-requested-with": "XMLHttpRequest",
};

module.exports = { COOKIE, BASE_URL, COURSE_ID, PAGE_HEADERS, API_HEADERS };
