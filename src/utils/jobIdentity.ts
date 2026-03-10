import { createHash } from "crypto";

export function normalizeJobRef(ref?: string | null): string | undefined {
  const trimmedRef = ref?.trim();
  return trimmedRef ? trimmedRef : undefined;
}

export function getJobId(repo: string, commit: string): string {
  return createHash("sha256")
    .update(`${repo}\n${commit}`)
    .digest("hex");
}

export function getJobPermalink(
  repo: string,
  commit: string,
  ref?: string
): string {
  const params = new URLSearchParams();
  params.set("repo", repo);
  if (ref) {
    params.set("ref", ref);
  }
  params.set("commit", commit);
  return `/?${params.toString()}`;
}
