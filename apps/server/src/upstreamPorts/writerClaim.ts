/**
 * Single-writer claim per repository: one F5 profile on one machine records
 * upstream ops and runs the schedule. The claim lives beside the cross-profile
 * repository locks so every profile sees it.
 *
 * @module upstreamPorts/writerClaim
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { UpstreamWriterClaim } from "@t3tools/contracts";

import { repositoryIdentityHash } from "../project/Layers/WorktreeLifecycleCoordinator.ts";

export interface WriterIdentity {
  readonly profileId: string;
  readonly stateDir: string;
  readonly hostname: string;
}

export interface WriterClaimFile extends WriterIdentity {
  readonly claimedAt: string;
}

export function writerClaimPath(baseDir: string, canonicalCommonDir: string): string {
  return path.join(
    baseDir,
    "upstream-writers",
    `${repositoryIdentityHash(canonicalCommonDir)}.json`,
  );
}

export async function readWriterClaim(file: string): Promise<WriterClaimFile | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<WriterClaimFile>;
    if (
      typeof value.profileId !== "string" ||
      typeof value.stateDir !== "string" ||
      typeof value.hostname !== "string" ||
      typeof value.claimedAt !== "string"
    )
      return null;
    return value as WriterClaimFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export const isSameWriter = (claim: WriterIdentity, me: WriterIdentity) =>
  claim.stateDir === me.stateDir && claim.hostname === me.hostname;

async function writeClaim(
  file: string,
  claim: WriterClaimFile,
  exclusive: boolean,
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  if (exclusive) {
    try {
      await writeFile(file, `${JSON.stringify(claim, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return true;
}

/** Claims the repository when nobody has; returns whether this profile is the writer. */
export async function ensureWriterClaim(
  file: string,
  me: WriterIdentity,
  now: string,
): Promise<boolean> {
  const existing = await readWriterClaim(file);
  if (existing) return isSameWriter(existing, me);
  if (await writeClaim(file, { ...me, claimedAt: now }, true)) return true;
  const raced = await readWriterClaim(file);
  return raced !== null && isSameWriter(raced, me);
}

export async function takeOverWriterClaim(
  file: string,
  me: WriterIdentity,
  now: string,
): Promise<void> {
  await writeClaim(file, { ...me, claimedAt: now }, false);
}

export async function describeWriterClaim(
  file: string,
  me: WriterIdentity,
): Promise<UpstreamWriterClaim> {
  const claim = await readWriterClaim(file);
  return {
    claimed: claim !== null,
    managedByThisProfile: claim !== null && isSameWriter(claim, me),
    profileId: claim?.profileId ?? null,
    hostname: claim?.hostname ?? null,
    claimedAt: claim?.claimedAt ?? null,
  };
}
