/**
 * Lens: OSINT - Infrastructure reconnaissance and digital forensics
 * @version 2.0.0
 */
const URL_RE = /https?:\/\/[^\s"<>]+/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
module.exports = {
  name: "osint",
  description: "Infrastructure reconnaissance and digital forensics",
  analyze(data, meta = {}) {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    const urls = [...text.matchAll(URL_RE)].map((m) => m[0]);
    const emails = [...text.matchAll(EMAIL_RE)].map((m) => m[0]);
    const ips = [...text.matchAll(IP_RE)].map((m) => m[0]);
    return {
      lens: "osint",
      urls_found: [...new Set(urls)],
      emails_found: [...new Set(emails)],
      ips_found: [...new Set(ips)],
      ioc_count: urls.length + emails.length + ips.length,
      confidence: 0.82,
      source: meta.path || "unknown",
    };
  },
};
