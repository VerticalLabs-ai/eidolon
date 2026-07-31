/**
 * True when the value is an absolute http(s) URL with no embedded credentials.
 * Userinfo is rejected because a repository URL such as https://token@host/org/repo
 * would otherwise be persisted and rendered verbatim, leaking the secret.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const isHttpProtocol = url.protocol === "http:" || url.protocol === "https:";
    return isHttpProtocol && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
