/**
 * True when the value is an absolute http(s) URL with no embedded credentials.
 * Userinfo is rejected because a repository URL such as https://token@host/org/repo
 * would otherwise be persisted and rendered verbatim, leaking the secret.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const isHttpProtocol = url.protocol === "http:" || url.protocol === "https:";
    if (!isHttpProtocol || url.username !== "" || url.password !== "") return false;
    // URL parsing discards an empty userinfo section, so https://@host and
    // https://:@host would survive the username/password check above.
    return !rawAuthority(value, url.protocol).includes("@");
  } catch {
    return false;
  }
}

/** Authority of the raw input, before URL parsing normalizes empty userinfo away. */
function rawAuthority(value: string, protocol: string): string {
  const afterScheme = value.trim().slice(protocol.length).replace(/^[/\\]*/, "");
  return afterScheme.split(/[/\\?#]/, 1)[0] ?? "";
}
