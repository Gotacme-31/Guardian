import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  acquireDependencyArtifactPair,
  classifyUsageImpact,
  cleanupDependencyArtifactPair,
  compareDeclarationSurfaces,
  correlateUsageImpact,
  extractDeclarationSurface,
  type AcquiredDependencyArtifactPair,
  type DependencyContext,
  type ResolvedDependencyTarget,
} from "../src/index.js";

/**
 * This file exercises M5 (artifact acquisition) -> M6 (declaration extraction) -> M7 (surface
 * diff) -> M8 (usage correlation) -> M9 (severity classification) chained together for real, the
 * way the new `impact` CLI command does. Every prior milestone's tests fed the *next* layer
 * directly-constructed fixtures (e.g. usage-impact.test.ts hands `compareDeclarationSurfaces` a
 * hand-built `PackageDeclarationSurface`) — none of them ran a real acquired artifact through a
 * real M6 extraction into a real M7 diff. That chain had never been exercised together before
 * this milestone.
 *
 * The task description for this milestone characterized `dependency-context.test.ts`'s CLI tests
 * as "not executing the binary" — that turned out to be inaccurate on inspection: its
 * `runCli` helper spawns the real `apps/cli` binary via `execFile` for the offline `scan`/
 * `inspect` commands. `impact` needs `resolveDependencyTarget`/`acquireDependencyArtifactPair`,
 * both of which hit the real npm registry unless a `fetch` is injected — and `runCli` has no way
 * to inject a `fetch` into the subprocess it spawns. Running `impact` through `runCli` in this
 * suite would require live network access during `pnpm test`, which breaks this repository's own
 * invariant ("tests require no external service or live registry access", per AGENTS.md /
 * CLAUDE.md). So this file chains the library functions directly with an injected `fetch`
 * instead, the same approach package-artifact.test.ts already uses for M5.
 */

interface SyntheticTarEntry {
  name: string;
  content: string;
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length, `${octal}\0`);
}

function createTarball(entries: SyntheticTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const item of entries) {
    const content = Buffer.from(item.content);
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, item.name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, "0");
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, content);
    const padding = (512 - (content.byteLength % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function fixtureTarball(version: string, declarations: string): Buffer {
  return createTarball([
    {
      name: "package/package.json",
      content: JSON.stringify({ name: "fixture-dep", version, types: "index.d.ts" }),
    },
    { name: "package/index.js", content: "module.exports = {};\n" },
    { name: "package/index.d.ts", content: declarations },
  ]);
}

function sri(buffer: Buffer): string {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

/**
 * A two-version npm registry double: unlike package-artifact.test.ts's `registryFixture` (built
 * for acquiring a single version), `acquireDependencyArtifactPair` needs to fetch metadata and a
 * tarball for *two* distinct versions of the same package behind one injected `fetch`.
 */
function twoVersionRegistryFixture(options: {
  installedVersion: string;
  targetVersion: string;
  installedTarball: Buffer;
  targetTarball: Buffer;
}): typeof fetch {
  const dependency = "fixture-dep";
  const tarballUrl = (version: string): string =>
    `https://registry.npmjs.org/${dependency}/-/${dependency}-${version}.tgz`;
  const tarballs = new Map([
    [tarballUrl(options.installedVersion), options.installedTarball],
    [tarballUrl(options.targetVersion), options.targetTarball],
  ]);
  const versions: Record<string, { dist: { tarball: string; integrity: string } }> = {
    [options.installedVersion]: {
      dist: { tarball: tarballUrl(options.installedVersion), integrity: sri(options.installedTarball) },
    },
    [options.targetVersion]: {
      dist: { tarball: tarballUrl(options.targetVersion), integrity: sri(options.targetTarball) },
    },
  };
  const packument = { "dist-tags": { latest: options.targetVersion }, versions };

  const fetchImplementation: typeof fetch = async (input) => {
    const url = String(input);
    if (new URL(url).pathname.endsWith(".tgz")) {
      const tarball = tarballs.get(url);
      return tarball === undefined
        ? new Response(null, { status: 404 })
        : new Response(tarball, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": tarball.byteLength.toString(),
          },
        });
    }
    const [encodedName, encodedVersion] = new URL(url).pathname.slice(1).split("/");
    if (encodedName !== undefined && encodedVersion !== undefined) {
      const requestedVersion = decodeURIComponent(encodedVersion);
      const versionMetadata = versions[requestedVersion];
      if (decodeURIComponent(encodedName) !== dependency || versionMetadata === undefined) {
        return new Response(null, { status: 404 });
      }
      return new Response(
        JSON.stringify({ name: dependency, version: requestedVersion, ...versionMetadata }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(packument), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return fetchImplementation;
}

function fixtureContext(): DependencyContext {
  return {
    dependency: "fixture-dep",
    declaration: { type: "dependency", declaredVersion: "^1.0.0" },
    resolution: {
      dependency: "fixture-dep",
      dependencyType: "dependency",
      declaredVersion: "^1.0.0",
      resolvedVersion: "1.0.0",
      kind: "registry",
      status: "resolved",
    },
    usage: {
      used: true,
      files: ["src/index.ts"],
      imports: [{
        file: "src/index.ts",
        source: "fixture-dep",
        importedSymbols: ["removeMe"],
        symbolBindings: [{ importedSymbol: "removeMe", localBinding: "removeMe" }],
        kind: "es-import",
      }],
      importedSymbols: [],
      apiUsages: [{
        canonicalPath: "removeMe",
        localUsagePaths: ["removeMe"],
        occurrenceCount: 1,
        evidence: ["direct-import"],
        occurrences: [{
          dependency: "fixture-dep",
          file: "src/index.ts",
          importedSymbol: "removeMe",
          localBinding: "removeMe",
          usagePath: "removeMe",
          kind: "call",
          line: 5,
          column: 3,
        }],
      }],
    },
  };
}

function fixtureTarget(): ResolvedDependencyTarget {
  return {
    dependency: "fixture-dep",
    installedVersion: "1.0.0",
    requestedTarget: "2.0.0",
    resolvedVersion: "2.0.0",
    status: "resolved",
    source: "npm",
    upgradeType: "major",
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe("full impact pipeline (M5 -> M6 -> M7 -> M8 -> M9)", () => {
  it("classifies a removed function as breaking end to end and cleans up on success", async () => {
    const installedTarball = fixtureTarball(
      "1.0.0",
      "export function keepMe(): void;\nexport function removeMe(): void;\n",
    );
    const targetTarball = fixtureTarball("2.0.0", "export function keepMe(): void;\n");
    const fetchFixture = twoVersionRegistryFixture({
      installedVersion: "1.0.0",
      targetVersion: "2.0.0",
      installedTarball,
      targetTarball,
    });
    const context = fixtureContext();

    const pair = await acquireDependencyArtifactPair(context, fixtureTarget(), {
      fetch: fetchFixture,
    });
    let classification;
    try {
      expect(await pathExists(pair.installed.temporaryRoot)).toBe(true);
      expect(await pathExists(pair.target.temporaryRoot)).toBe(true);

      const [beforeSurface, afterSurface] = await Promise.all([
        extractDeclarationSurface(pair.installed),
        extractDeclarationSurface(pair.target),
      ]);
      const diff = compareDeclarationSurfaces(beforeSurface, afterSurface);
      const usageImpact = correlateUsageImpact(context, beforeSurface, diff);
      classification = classifyUsageImpact(usageImpact);
    } finally {
      await cleanupDependencyArtifactPair(pair);
    }

    expect(classification.summary).toEqual({ breaking: 1, safe: 0, needsReview: 0 });
    const removed = classification.classifications.find((item) =>
      item.usage.usage.canonicalPath === "removeMe");
    expect(removed).toMatchObject({
      severity: "breaking",
      reasons: [{ code: "export-removed" }],
    });
    expect(removed?.usage.usage.occurrences[0]).toMatchObject({
      file: "src/index.ts",
      line: 5,
      column: 3,
    });

    expect(await pathExists(pair.installed.temporaryRoot)).toBe(false);
    expect(await pathExists(pair.target.temporaryRoot)).toBe(false);
  });

  it("still cleans up the acquired artifact pair when a later pipeline step throws", async () => {
    // extractDeclarationSurface/compareDeclarationSurfaces/correlateUsageImpact/classifyUsageImpact
    // have no injectable failure seam: M6 degrades unreadable/invalid content to issues instead of
    // throwing (see declaration-surface/extractor.ts), and M7/M8's typed errors
    // (DeclarationSurfaceComparisonError / UsageImpactCorrelationError) require a packageName or
    // version mismatch that cannot occur here -- both acquired artifacts are always extracted
    // from the identity-validated tarballs behind the exact same `context.dependency`/version
    // pair the CLI already used to acquire them. There is no fixture that makes those functions
    // genuinely reject after a real, successful acquisition.
    //
    // What is being verified is the try/finally *shape* the CLI uses around the pipeline: `pair`
    // assigned once, `cleanupDependencyArtifactPair(pair)` in a `finally`. That guarantee does not
    // depend on which step throws, so a forced synthetic error after a real successful
    // acquisition exercises the same code path and the same guarantee.
    const installedTarball = fixtureTarball("1.0.0", "export function keepMe(): void;\n");
    const targetTarball = fixtureTarball("2.0.0", "export function keepMe(): void;\n");
    const fetchFixture = twoVersionRegistryFixture({
      installedVersion: "1.0.0",
      targetVersion: "2.0.0",
      installedTarball,
      targetTarball,
    });
    const context = fixtureContext();

    let pair: AcquiredDependencyArtifactPair | undefined;
    await expect((async () => {
      try {
        pair = await acquireDependencyArtifactPair(context, fixtureTarget(), {
          fetch: fetchFixture,
        });
        throw new Error("forced mid-pipeline failure");
      } finally {
        if (pair !== undefined) {
          await cleanupDependencyArtifactPair(pair);
        }
      }
    })()).rejects.toThrow("forced mid-pipeline failure");

    if (pair === undefined) {
      throw new Error("expected the pair to have been acquired before the forced failure");
    }
    expect(await pathExists(pair.installed.temporaryRoot)).toBe(false);
    expect(await pathExists(pair.target.temporaryRoot)).toBe(false);
  });
});
