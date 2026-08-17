/**
 * Decide whether a DAST target may be scanned.
 *
 * Previously this was a shell `case` comparing the URL prefix, which matched
 * `https://eidolon.verticallabs.ai` and `https://eidolon.verticallabs.ai/...`
 * but not `https://EIDOLON.verticallabs.ai`, `https://eidolon.verticallabs.ai:443/`,
 * or `https://user@eidolon.verticallabs.ai`. An active scan against production is
 * not a mistake worth leaving to string prefixes, so the check now parses the URL
 * and compares the hostname.
 *
 * Usage:
 *   node scripts/validate-dast-target.mjs "$TARGET_URL"
 *
 * Exit codes:
 *   0  scannable, or nothing configured (writes configured=false for the workflow)
 *   1  configured but refused
 *
 * Writes `configured` and `target` to $GITHUB_OUTPUT when present, so a scheduled
 * run with no target configured can skip cleanly instead of failing. An
 * unconfigured schedule is an operator decision, not a broken pipeline.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';

export const PRODUCTION_HOSTNAMES = ['eidolon.verticallabs.ai', 'www.eidolon.verticallabs.ai'];

/**
 * @returns {{ ok: boolean, configured: boolean, target?: string, reason?: string }}
 */
export function validateTarget(raw) {
  const value = (raw ?? '').trim();
  if (!value) {
    return { ok: true, configured: false, reason: 'No DAST target is configured.' };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, configured: true, reason: `Target is not a valid URL: ${value}` };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, configured: true, reason: 'DAST target must use HTTPS.' };
  }

  // Credentials in the target would be written into ZAP's report and the run log.
  if (url.username || url.password) {
    return { ok: false, configured: true, reason: 'DAST target must not embed credentials.' };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (PRODUCTION_HOSTNAMES.includes(hostname)) {
    return {
      ok: false,
      configured: true,
      reason: `DAST refuses to scan the production hostname ${hostname}.`,
    };
  }

  return { ok: true, configured: true, target: url.toString() };
}

function emit(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    appendFileSync(file, `${name}=${value}\n`);
  }
}

function main() {
  const result = validateTarget(process.argv[2]);

  if (!result.configured) {
    emit('configured', 'false');
    console.log(
      `::notice::${result.reason} Set the DAST_TARGET_URL repository variable to enable scheduled scans.`,
    );
    return;
  }

  if (!result.ok) {
    emit('configured', 'false');
    console.log(`::error::${result.reason}`);
    process.exit(1);
  }

  emit('configured', 'true');
  emit('target', result.target);
  console.log(`Target accepted: ${result.target}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
