import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireDependencyArtifactPair,
  acquirePackageArtifact,
  cleanupDependencyArtifactPair,
  cleanupPackageArtifact,
  createDependencyTargetResolver,
  createPackageArtifactAcquirer,
  PackageArtifactError,
  scanProject,
  type AcquiredPackageArtifact,
  type ArtifactAcquisitionOptions,
  type DependencyContext,
  type ResolvedDependencyTarget,
} from "../src/index.js";
import { verifyArtifactIntegrity } from "../src/package-artifact/integrity.js";

interface SyntheticTarEntry {
  name: string;
  type?: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "L" | "S" | "g" | "x";
  content?: string | Buffer;
  linkpath?: string;
}

interface RegistryFixtureOptions {
  dependency?: string;
  version?: string;
  tarball?: Buffer;
  tarballUrl?: string;
  integrity?: string | null;
  shasum?: string | null;
  tarballStatus?: number;
  contentLength?: string | null;
  tarballFetch?: typeof fetch;
  versions?: Record<string, { dist: Record<string, string> }>;
  onRequest?: (url: string, init?: Parameters<typeof fetch>[1]) => void;
}

const acquiredArtifacts: AcquiredPackageArtifact[] = [];
const sampleProjectPath = fileURLToPath(
  new URL("../../../test-projects/sample-typescript-app", import.meta.url),
);

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
    const type = item.type ?? "0";
    const hasContent = type === "0" || type === "L" || type === "g" || type === "x";
    const content = Buffer.isBuffer(item.content)
      ? item.content
      : Buffer.from(item.content ?? "");
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, item.name);
    writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, hasContent ? content.byteLength : 0);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, type);
    writeString(header, 157, 100, item.linkpath ?? "");
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    if (hasContent) {
      blocks.push(content);
      const padding = (512 - (content.byteLength % 512)) % 512;
      if (padding > 0) {
        blocks.push(Buffer.alloc(padding));
      }
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function packageTarball(
  dependency = "fixture-package",
  version = "1.0.0",
  extraEntries: SyntheticTarEntry[] = [],
  manifestOverrides: Record<string, unknown> = {},
): Buffer {
  return createTarball([
    {
      name: "package/package.json",
      content: JSON.stringify({ name: dependency, version, ...manifestOverrides }),
    },
    { name: "package/index.js", content: "module.exports = true;\n" },
    ...extraEntries,
  ]);
}

function sri(buffer: Buffer): string {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

function sha1(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

function paxRecord(name: string, value: string): string {
  const body = ` ${name}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(length)) + Buffer.byteLength(body) !== length) {
    length = Buffer.byteLength(String(length)) + Buffer.byteLength(body);
  }
  return `${length}${body}`;
}

function registryFixture(options: RegistryFixtureOptions = {}): {
  dependency: string;
  version: string;
  tarball: Buffer;
  fetch: typeof fetch;
} {
  const dependency = options.dependency ?? "fixture-package";
  const version = options.version ?? "1.0.0";
  const tarball = options.tarball ?? packageTarball(dependency, version);
  const tarballUrl = options.tarballUrl
    ?? `https://registry.npmjs.org/${encodeURIComponent(dependency)}/-/${dependency.replace("/", "-")}-${version}.tgz`;
  const integrity = options.integrity === undefined ? sri(tarball) : options.integrity;
  const shasum = options.shasum === undefined ? sha1(tarball) : options.shasum;
  const dist = {
    tarball: tarballUrl,
    ...(integrity === null ? {} : { integrity }),
    ...(shasum === null ? {} : { shasum }),
  };
  const versions = options.versions ?? { [version]: { dist } };
  const packument = {
    "dist-tags": { latest: version },
    versions,
  };

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = String(input);
    options.onRequest?.(url, init);
    if (new URL(url).pathname.endsWith(".tgz")) {
      if (options.tarballFetch !== undefined) {
        return options.tarballFetch(input, init);
      }
      const headers = new Headers({ "Content-Type": "application/octet-stream" });
      if (options.contentLength !== null) {
        headers.set("Content-Length", options.contentLength ?? tarball.byteLength.toString());
      }
      return new Response(tarball, {
        status: options.tarballStatus ?? 200,
        headers,
      });
    }
    const [encodedName, encodedVersion] = new URL(url).pathname.slice(1).split("/");
    if (encodedName !== undefined && encodedVersion !== undefined) {
      const requestedName = decodeURIComponent(encodedName);
      const requestedVersion = decodeURIComponent(encodedVersion);
      const versionMetadata = versions[requestedVersion];
      if (requestedName !== dependency || versionMetadata === undefined) {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify({
        name: dependency,
        version: requestedVersion,
        ...versionMetadata,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(packument), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { dependency, version, tarball, fetch: fetchImplementation };
}

async function acquireFixture(
  fixture: ReturnType<typeof registryFixture>,
  options: Omit<ArtifactAcquisitionOptions, "fetch"> = {},
): Promise<AcquiredPackageArtifact> {
  const artifact = await acquirePackageArtifact(fixture.dependency, fixture.version, {
    ...options,
    fetch: fixture.fetch,
  });
  acquiredArtifacts.push(artifact);
  return artifact;
}

function dependencyContext(
  dependency: string,
  installedVersion: string,
): DependencyContext {
  return {
    dependency,
    declaration: { type: "dependency", declaredVersion: `^${installedVersion}` },
    resolution: {
      dependency,
      dependencyType: "dependency",
      declaredVersion: `^${installedVersion}`,
      resolvedVersion: installedVersion,
      kind: "registry",
      status: "resolved",
    },
    usage: {
      used: false,
      files: [],
      imports: [],
      importedSymbols: [],
      apiUsages: [],
    },
  };
}

function resolvedTarget(dependency: string, version: string): ResolvedDependencyTarget {
  return {
    dependency,
    installedVersion: "1.0.0",
    requestedTarget: version,
    resolvedVersion: version,
    status: "resolved",
    source: "npm",
    upgradeType: "major",
  };
}

async function guardianTempRoots(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((entry) => entry.startsWith("guardian-artifact-"))
    .sort();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(acquiredArtifacts.splice(0).map((artifact) =>
    cleanupPackageArtifact(artifact)));
  vi.restoreAllMocks();
});

describe("secure package artifact acquisition", () => {
  it("uses valid normalized artifact metadata", async () => {
    const fixture = registryFixture();
    const artifact = await acquireFixture(fixture);

    expect(artifact).toMatchObject({
      dependency: fixture.dependency,
      version: fixture.version,
      source: "npm",
      tarballUrl: expect.stringContaining("registry.npmjs.org"),
    });
  });

  it("supports scoped package artifact metadata", async () => {
    let metadataPath = "";
    const fixture = registryFixture({
      dependency: "@scope/package",
      onRequest(url) {
        if (!url.endsWith(".tgz")) {
          metadataPath = new URL(url).pathname;
        }
      },
    });
    const artifact = await acquireFixture(fixture);

    expect(artifact.dependency).toBe("@scope/package");
    expect(metadataPath).toBe("/%40scope%2Fpackage/1.0.0");
    expect(JSON.parse(await readFile(path.join(artifact.packagePath, "package.json"), "utf8")))
      .toMatchObject({ name: "@scope/package", version: "1.0.0" });
  });

  it("requests exact-version metadata without depending on the full packument", async () => {
    const dependency = "fixture-package";
    const version = "1.0.0";
    const tarball = packageTarball(dependency, version);
    const requestedPaths: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname.endsWith(".tgz")) {
        return new Response(tarball);
      }
      if (url.pathname === `/${dependency}/${version}`) {
        return new Response(JSON.stringify({
          name: dependency,
          version,
          dist: {
            tarball: `https://registry.npmjs.org/${dependency}/-/${dependency}-${version}.tgz`,
            integrity: sri(tarball),
          },
        }));
      }
      return new Response("full packument should not be requested", { status: 500 });
    };

    const artifact = await acquirePackageArtifact(dependency, version, {
      fetch: fetchImplementation,
    });
    acquiredArtifacts.push(artifact);

    expect(requestedPaths).toEqual([
      `/${dependency}/${version}`,
      `/${dependency}/-/${dependency}-${version}.tgz`,
    ]);
  });

  it("downloads and extracts a valid package artifact", async () => {
    const artifact = await acquireFixture(registryFixture());

    await expect(stat(artifact.archivePath)).resolves.toMatchObject({});
    await expect(stat(artifact.packagePath)).resolves.toMatchObject({});
    expect(await readFile(path.join(artifact.packagePath, "index.js"), "utf8"))
      .toBe("module.exports = true;\n");
  });

  it("streams the complete tarball to disk and counts bytes", async () => {
    const fixture = registryFixture();
    const artifact = await acquireFixture(fixture);

    expect(artifact.downloadedBytes).toBe(fixture.tarball.byteLength);
    expect(await readFile(artifact.archivePath)).toEqual(fixture.tarball);
  });

  it("streams a tarball delivered in multiple chunks", async () => {
    const fixture = registryFixture();
    const midpoint = Math.floor(fixture.tarball.byteLength / 2);
    const chunks = [fixture.tarball.subarray(0, midpoint), fixture.tarball.subarray(midpoint)];
    const chunkedFixture = registryFixture({
      tarball: fixture.tarball,
      tarballFetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) {
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        },
      })),
    });

    const artifact = await acquireFixture(chunkedFixture);

    expect(artifact.downloadedBytes).toBe(fixture.tarball.byteLength);
    expect(await readFile(artifact.archivePath)).toEqual(fixture.tarball);
  });

  it("verifies valid SHA-512 SRI before extraction", async () => {
    const artifact = await acquireFixture(registryFixture());

    expect(artifact.verification).toMatchObject({
      verified: true,
      method: "sri",
      algorithm: "sha512",
    });
  });

  it("uses the strongest supported hash from multiple SRI entries", async () => {
    const source = registryFixture();
    const fixture = registryFixture({
      tarball: source.tarball,
      integrity: [
        `sha256-${Buffer.alloc(32).toString("base64")}`,
        sri(source.tarball),
      ].join(" "),
    });

    const artifact = await acquireFixture(fixture);

    expect(artifact.verification).toMatchObject({
      method: "sri",
      algorithm: "sha512",
    });
  });

  it("rejects an incorrect SRI value", async () => {
    const fixture = registryFixture({
      tarball: gzipSync("not a tar archive"),
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "integrity-verification-failed",
    });
  });

  it("falls back to legacy SHA-1 shasum verification", async () => {
    const fixture = registryFixture({ integrity: null });
    const artifact = await acquireFixture(fixture);

    expect(artifact.verification).toMatchObject({
      verified: true,
      method: "sha1-legacy",
      algorithm: "sha1",
      shasum: sha1(fixture.tarball),
    });
  });

  it("rejects an incorrect legacy shasum", async () => {
    const fixture = registryFixture({ integrity: null, shasum: "0".repeat(40) });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "integrity-verification-failed",
    });
  });

  it("rejects metadata without integrity or shasum before download", async () => {
    let tarballRequests = 0;
    const fixture = registryFixture({
      integrity: null,
      shasum: null,
      onRequest(url) {
        if (url.endsWith(".tgz")) {
          tarballRequests += 1;
        }
      },
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "integrity-metadata-missing",
    });
    expect(tarballRequests).toBe(0);
  });

  it("rejects malformed integrity metadata before download without fallback", async () => {
    let tarballRequests = 0;
    const malformedSri = registryFixture({
      integrity: "sha512-not-valid-base64",
      onRequest(url) {
        if (url.endsWith(".tgz")) {
          tarballRequests += 1;
        }
      },
    });
    await expect(acquireFixture(malformedSri)).rejects.toMatchObject({
      code: "integrity-metadata-invalid",
    });

    const malformedSha1 = registryFixture({
      integrity: null,
      shasum: "not-a-sha1",
      onRequest(url) {
        if (url.endsWith(".tgz")) {
          tarballRequests += 1;
        }
      },
    });
    await expect(acquireFixture(malformedSha1)).rejects.toMatchObject({
      code: "integrity-metadata-invalid",
    });
    expect(tarballRequests).toBe(0);
  });

  it("reports filesystem failures during SRI verification accurately", async () => {
    await expect(verifyArtifactIntegrity(
      path.join(tmpdir(), `guardian-missing-${randomUUID()}.tgz`),
      {
        dependency: "fixture-package",
        version: "1.0.0",
        tarballUrl: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
        integrity: sri(Buffer.from("missing")),
      },
      0,
    )).rejects.toMatchObject({ code: "filesystem-error" });
  });

  it("rejects oversized Content-Length before writing", async () => {
    let bodyCancelled = false;
    const fixture = registryFixture({
      tarballFetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => undefined);
        },
        cancel() {
          bodyCancelled = true;
        },
      }), {
        headers: { "Content-Length": "1000" },
      }),
    });

    await expect(acquireFixture(fixture, {
      limits: { maxCompressedBytes: 999 },
    })).rejects.toMatchObject({ code: "compressed-size-limit-exceeded" });
    expect(bodyCancelled).toBe(true);
  });

  it("rejects a stream exceeding the compressed limit without Content-Length", async () => {
    const fixture = registryFixture({ contentLength: null });

    await expect(acquireFixture(fixture, {
      limits: { maxCompressedBytes: fixture.tarball.byteLength - 1 },
    })).rejects.toMatchObject({ code: "compressed-size-limit-exceeded" });
  });

  it("rejects a response body that ends before its Content-Length", async () => {
    const source = registryFixture();
    const fixture = registryFixture({
      tarball: source.tarball,
      tarballFetch: async () => new Response(
        source.tarball.subarray(0, source.tarball.byteLength - 1),
        { headers: { "Content-Length": source.tarball.byteLength.toString() } },
      ),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "download-response-invalid",
    });

    const overlongFixture = registryFixture({
      tarball: source.tarball,
      tarballFetch: async () => new Response(source.tarball, {
        headers: { "Content-Length": (source.tarball.byteLength - 1).toString() },
      }),
    });
    await expect(acquireFixture(overlongFixture)).rejects.toMatchObject({
      code: "download-response-invalid",
    });

    const zeroChunkFixture = registryFixture({
      tarball: source.tarball,
      tarballFetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(0));
          controller.enqueue(source.tarball);
          controller.close();
        },
      })),
    });
    await expect(acquireFixture(zeroChunkFixture)).rejects.toMatchObject({
      code: "download-response-invalid",
    });
  });

  it("normalizes tarball download timeout", async () => {
    const fixture = registryFixture({
      tarballFetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
    });

    await expect(acquireFixture(fixture, { timeoutMs: 5 })).rejects.toMatchObject({
      code: "download-timeout",
    });
  });

  it("cleans up after a timeout in a non-cooperative body stream", async () => {
    const before = await guardianTempRoots();
    const fixture = registryFixture();
    let bodyCancelled = false;
    const stalledFixture = registryFixture({
      tarball: fixture.tarball,
      tarballFetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fixture.tarball.subarray(0, 16));
        },
        pull() {
          return new Promise(() => undefined);
        },
        cancel() {
          bodyCancelled = true;
        },
      })),
    });

    await expect(acquireFixture(stalledFixture, { timeoutMs: 5 })).rejects.toMatchObject({
      code: "download-timeout",
    });
    expect(await guardianTempRoots()).toEqual(before);
    expect(bodyCancelled).toBe(true);
  });

  it("normalizes metadata and tarball network failures", async () => {
    const metadataBodyFailureFetch: typeof fetch = async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
    );
    await expect(acquirePackageArtifact("fixture-package", "1.0.0", {
      fetch: metadataBodyFailureFetch,
    })).rejects.toMatchObject({ code: "artifact-metadata-network-error" });

    const fixture = registryFixture({
      tarballFetch: async () => {
        throw new Error("network failure");
      },
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "download-network-error",
    });

    const source = registryFixture();
    let pullCount = 0;
    const streamFailureFixture = registryFixture({
      tarball: source.tarball,
      tarballFetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount === 0) {
            pullCount += 1;
            controller.enqueue(source.tarball.subarray(0, 16));
          } else {
            controller.error(new Error("connection reset"));
          }
        },
      })),
    });

    await expect(acquireFixture(streamFailureFixture)).rejects.toMatchObject({
      code: "download-network-error",
    });
  });

  it.each([
    [404, "download-not-found"],
    [429, "download-rate-limited"],
    [500, "download-unavailable"],
  ] as const)("normalizes tarball HTTP %s", async (status, code) => {
    const fixture = registryFixture({ tarballStatus: status });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code, httpStatus: status });
  });

  it("rejects non-HTTPS tarball URLs", async () => {
    const fixture = registryFixture({
      tarballUrl: "http://registry.npmjs.org/package/-/package-1.0.0.tgz",
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code: "tarball-url-invalid" });
  });

  it.each([
    "https://example.com/package-1.0.0.tgz",
    "https://localhost/package-1.0.0.tgz",
    "https://127.0.0.1/package-1.0.0.tgz",
    "https://[::1]/package-1.0.0.tgz",
    "https://10.0.0.1/package-1.0.0.tgz",
    "https://registry.npmjs.org.evil.example/package-1.0.0.tgz",
    "https://registry.npmjs.org:444/package-1.0.0.tgz",
    "https://user:password@registry.npmjs.org/package-1.0.0.tgz",
    "https://registry.npmjs.org@127.0.0.1/package-1.0.0.tgz",
  ])("rejects non-registry tarball URL %s", async (tarballUrl) => {
    const fixture = registryFixture({
      tarballUrl,
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code: "tarball-url-invalid" });
  });

  it("rejects redirects without following them", async () => {
    let redirectMode: NonNullable<Parameters<typeof fetch>[1]>["redirect"];
    const fixture = registryFixture({
      tarballStatus: 302,
      onRequest(url, init) {
        if (url.endsWith(".tgz")) {
          redirectMode = init?.redirect;
        }
      },
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "download-redirect-rejected",
    });
    expect(redirectMode).toBe("manual");
  });

  it("rejects registry metadata redirects without following them", async () => {
    let redirectMode: NonNullable<Parameters<typeof fetch>[1]>["redirect"];
    let accept: string | null = null;
    const redirectingFetch: typeof fetch = async (_input, init) => {
      redirectMode = init?.redirect;
      accept = new Headers(init?.headers).get("Accept");
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/private" },
      });
    };

    await expect(acquirePackageArtifact("fixture-package", "1.0.0", {
      fetch: redirectingFetch,
    })).rejects.toMatchObject({
      code: "artifact-metadata-unavailable",
      httpStatus: 302,
    });
    expect(redirectMode).toBe("manual");
    expect(accept).toBe("application/json");
  });

  it("limits registry metadata before parsing it", async () => {
    const oversizedMetadataFetch: typeof fetch = async () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": (32 * 1024 * 1024 + 1).toString() },
    });

    await expect(acquirePackageArtifact("fixture-package", "1.0.0", {
      fetch: oversizedMetadataFetch,
    })).rejects.toMatchObject({ code: "artifact-metadata-invalid" });
  });

  it("rejects a corrupt archive after integrity verification", async () => {
    const fixture = registryFixture({ tarball: gzipSync("not a tar archive") });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code: "archive-invalid" });
  });

  it.each([
    ["/absolute.txt", "absolute"],
    ["package/../../outside.txt", "traversal"],
    ["C:\\outside.txt", "windows-drive"],
    ["package\\hidden.js", "backslash"],
  ] as const)("rejects %s archive paths", async (entryPath, _caseName) => {
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        { name: entryPath, content: "unsafe" },
      ]),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code: "archive-path-unsafe" });
  });

  it.each([
    ["2", "SymbolicLink", "archive-entry-type-unsupported"],
    ["1", "Link", "archive-entry-type-unsupported"],
    ["3", "CharacterDevice", "archive-entry-type-unsupported"],
    ["4", "BlockDevice", "archive-entry-type-unsupported"],
    ["6", "FIFO", "archive-entry-type-unsupported"],
    ["S", "SparseFile", "archive-entry-type-unsupported"],
  ] as const)("rejects %s entries", async (type, _typeName, expectedCode) => {
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [{
        name: "package/unsafe",
        type,
        ...(type === "1" || type === "2" ? { linkpath: "../outside" } : {}),
      }]),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  it("does not create files outside extraction storage for malicious paths", async () => {
    const outsidePath = path.join(tmpdir(), `guardian-outside-${randomUUID()}`);
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        { name: outsidePath, content: "unsafe" },
      ]),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code: "archive-path-unsafe" });
    expect(await pathExists(outsidePath)).toBe(false);
  });

  it("rejects archives with too many entries", async () => {
    const fixture = registryFixture();

    await expect(acquireFixture(fixture, {
      limits: { maxEntries: 1 },
    })).rejects.toMatchObject({ code: "archive-entry-limit-exceeded" });
  });

  it("counts implicit parent directories before extraction", async () => {
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        { name: "package/a/b/c/deep.txt", content: "deep" },
      ]),
    });

    await expect(acquireFixture(fixture, {
      limits: { maxEntries: 6 },
    })).rejects.toMatchObject({ code: "archive-entry-limit-exceeded" });
  });

  it("counts duplicate archive headers independently from unique paths", async () => {
    const duplicateEntries = Array.from({ length: 5 }, (): SyntheticTarEntry => ({
      name: "package/duplicate.txt",
      content: "",
    }));
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", duplicateEntries),
    });

    await expect(acquireFixture(fixture, {
      limits: { maxEntries: 4 },
    })).rejects.toMatchObject({ code: "archive-entry-limit-exceeded" });
  });

  it("counts PAX metadata headers against the archive entry limit", async () => {
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        { name: "PaxHeader/one", type: "x", content: "13 comment=x\n" },
        { name: "PaxHeader/two", type: "x", content: "13 comment=x\n" },
        { name: "PaxHeader/three", type: "x", content: "13 comment=x\n" },
        { name: "package/extra.txt", content: "extra" },
      ]),
    });

    await expect(acquireFixture(fixture, {
      limits: { maxEntries: 4 },
    })).rejects.toMatchObject({ code: "archive-entry-limit-exceeded" });

    const emptyMetadataFixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        { name: "PaxHeader/one", type: "x", content: "" },
        { name: "PaxHeader/two", type: "x", content: "" },
        { name: "PaxHeader/three", type: "x", content: "" },
      ]),
    });
    await expect(acquireFixture(emptyMetadataFixture, {
      limits: { maxEntries: 4 },
    })).rejects.toMatchObject({ code: "archive-entry-limit-exceeded" });
  });

  it("rejects path traversal supplied by PAX and GNU path overrides", async () => {
    const paxFixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        {
          name: "PaxHeader/path",
          type: "x",
          content: paxRecord("path", "package/../../outside.txt"),
        },
        { name: "package/safe.txt", content: "unsafe" },
      ]),
    });

    await expect(acquireFixture(paxFixture)).rejects.toMatchObject({
      code: "archive-path-unsafe",
    });

    const gnuFixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        {
          name: "LongLink/path",
          type: "L",
          content: "package/../../outside.txt\0",
        },
        { name: "package/safe.txt", content: "unsafe" },
      ]),
    });
    await expect(acquireFixture(gnuFixture)).rejects.toMatchObject({
      code: "archive-path-unsafe",
    });
  });

  it("rejects PAX size overrides to prevent parser ambiguity", async () => {
    const localFixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        {
          name: "PaxHeader/size",
          type: "x",
          content: paxRecord("size", "4"),
        },
        { name: "package/pax-size.txt", content: "data" },
      ]),
    });

    await expect(acquireFixture(localFixture)).rejects.toMatchObject({
      code: "archive-invalid",
    });

    const globalFixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        {
          name: "GlobalPaxHeader/size",
          type: "g",
          content: paxRecord("size", "4"),
        },
        { name: "package/pax-size.txt", content: "data" },
      ]),
    });
    await expect(acquireFixture(globalFixture)).rejects.toMatchObject({
      code: "archive-invalid",
    });
  });

  it("rejects an excessive compression ratio within the byte limits", async () => {
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [{
        name: "package/highly-compressible.txt",
        content: Buffer.alloc(16 * 1024 * 1024),
      }]),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "archive-invalid",
    });
  });

  it("rejects archives exceeding total extracted bytes", async () => {
    const tarball = packageTarball("fixture-package", "1.0.0", [
      { name: "package/large.txt", content: "x".repeat(80) },
    ]);
    const fixture = registryFixture({ tarball });

    await expect(acquireFixture(fixture, {
      limits: { maxExtractedBytes: 100, maxSingleFileBytes: 100 },
    })).rejects.toMatchObject({ code: "archive-size-limit-exceeded" });
  });

  it("rejects an oversized single extracted file", async () => {
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [
        { name: "package/large.txt", content: "x".repeat(80) },
      ]),
    });

    await expect(acquireFixture(fixture, {
      limits: { maxExtractedBytes: 1000, maxSingleFileBytes: 79 },
    })).rejects.toMatchObject({ code: "archive-file-size-limit-exceeded" });
  });

  it("requires package/package.json", async () => {
    const fixture = registryFixture({
      tarball: createTarball([{ name: "package/index.js", content: "export {};" }]),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code: "package-json-missing" });
  });

  it("validates the extracted package name", async () => {
    const fixture = registryFixture({
      tarball: packageTarball("wrong-package", "1.0.0"),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({ code: "package-name-mismatch" });
  });

  it("validates the extracted package version", async () => {
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "2.0.0"),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "package-version-mismatch",
    });
  });

  it("rejects invalid extracted package.json", async () => {
    const fixture = registryFixture({
      tarball: createTarball([
        { name: "package/package.json", content: "{ invalid" },
        { name: "package/index.js", content: "export {};" },
      ]),
    });

    await expect(acquireFixture(fixture)).rejects.toMatchObject({
      code: "package-json-invalid",
    });
  });

  it("never executes package lifecycle scripts", async () => {
    const markerPath = path.join(tmpdir(), `guardian-script-${randomUUID()}`);
    const fixture = registryFixture({
      tarball: packageTarball("fixture-package", "1.0.0", [], {
        scripts: { install: `touch ${markerPath}` },
      }),
    });

    await acquireFixture(fixture);

    expect(await pathExists(markerPath)).toBe(false);
  });

  it("removes archive and extraction paths during cleanup", async () => {
    const artifact = await acquireFixture(registryFixture());
    acquiredArtifacts.splice(acquiredArtifacts.indexOf(artifact), 1);

    await cleanupPackageArtifact(artifact);

    expect(await pathExists(artifact.temporaryRoot)).toBe(false);
  });

  it("allows cleanup when the artifact was already removed", async () => {
    const artifact = await acquireFixture(registryFixture());
    acquiredArtifacts.splice(acquiredArtifacts.indexOf(artifact), 1);

    await cleanupPackageArtifact(artifact);
    await expect(cleanupPackageArtifact(artifact)).resolves.toBeUndefined();
  });

  it("refuses cleanup for a fabricated artifact object", async () => {
    const forgedArtifact = {
      dependency: "fixture-package",
      version: "1.0.0",
      source: "npm",
      tarballUrl: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
      verification: {
        verified: true,
        method: "sri",
        algorithm: "sha512",
        integrity: sri(Buffer.from("forged")),
      },
      temporaryRoot: path.join(tmpdir(), "guardian-artifact-forged"),
      archivePath: "",
      extractionRoot: "",
      packagePath: "",
      downloadedBytes: 0,
    } as const;

    await expect(cleanupPackageArtifact(forgedArtifact)).rejects.toMatchObject({
      code: "cleanup-path-invalid",
    });
  });

  it("cleans temporary storage after acquisition failure", async () => {
    const before = await guardianTempRoots();
    const fixture = registryFixture({
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    });

    await expect(acquireFixture(fixture)).rejects.toBeInstanceOf(PackageArtifactError);

    expect(await guardianTempRoots()).toEqual(before);
  });

  it("acquires installed and target artifacts as a pair", async () => {
    const dependency = "fixture-package";
    const installedTarball = packageTarball(dependency, "1.0.0");
    const targetTarball = packageTarball(dependency, "2.0.0");
    const fixture = registryFixture({
      versions: {
        "1.0.0": {
          dist: {
            tarball: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
            integrity: sri(installedTarball),
          },
        },
        "2.0.0": {
          dist: {
            tarball: "https://registry.npmjs.org/fixture-package/-/fixture-package-2.0.0.tgz",
            integrity: sri(targetTarball),
          },
        },
      },
      tarballFetch: async (input) => new Response(
        String(input).includes("2.0.0") ? targetTarball : installedTarball,
      ),
    });

    const pair = await acquireDependencyArtifactPair(
      dependencyContext(dependency, "1.0.0"),
      resolvedTarget(dependency, "2.0.0"),
      { fetch: fixture.fetch },
    );
    acquiredArtifacts.push(pair.installed, pair.target);

    expect(pair.deduplicated).toBe(false);
    expect(pair.installed.version).toBe("1.0.0");
    expect(pair.target.version).toBe("2.0.0");
    await cleanupDependencyArtifactPair(pair);
    await expect(cleanupDependencyArtifactPair(pair)).resolves.toBeUndefined();
    expect(await pathExists(pair.installed.temporaryRoot)).toBe(false);
    expect(await pathExists(pair.target.temporaryRoot)).toBe(false);
  });

  it("deduplicates pair acquisition when versions are equal", async () => {
    let tarballRequests = 0;
    const fixture = registryFixture({
      onRequest(url) {
        if (url.endsWith(".tgz")) {
          tarballRequests += 1;
        }
      },
    });
    const acquirer = createPackageArtifactAcquirer({ fetch: fixture.fetch });
    const pair = await acquirer.acquirePair(
      dependencyContext(fixture.dependency, fixture.version),
      resolvedTarget(fixture.dependency, fixture.version),
    );
    acquiredArtifacts.push(pair.installed);

    expect(pair.deduplicated).toBe(true);
    expect(pair.installed).toBe(pair.target);
    expect(tarballRequests).toBe(1);
    await cleanupPackageArtifact(pair.installed);
    await cleanupDependencyArtifactPair(pair);
    await expect(cleanupDependencyArtifactPair(pair)).resolves.toBeUndefined();
    expect(await pathExists(pair.installed.temporaryRoot)).toBe(false);
  });

  it("cleans the installed artifact when target acquisition fails", async () => {
    const before = await guardianTempRoots();
    const dependency = "fixture-package";
    const installedTarball = packageTarball(dependency, "1.0.0");
    const targetTarball = packageTarball(dependency, "2.0.0");
    const fixture = registryFixture({
      versions: {
        "1.0.0": {
          dist: {
            tarball: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
            integrity: sri(installedTarball),
          },
        },
        "2.0.0": {
          dist: {
            tarball: "https://registry.npmjs.org/fixture-package/-/fixture-package-2.0.0.tgz",
            integrity: sri(targetTarball),
          },
        },
      },
      tarballFetch: async (input) => String(input).includes("2.0.0")
        ? new Response(null, { status: 500 })
        : new Response(installedTarball),
    });

    await expect(acquireDependencyArtifactPair(
      dependencyContext(dependency, "1.0.0"),
      resolvedTarget(dependency, "2.0.0"),
      { fetch: fixture.fetch },
    )).rejects.toMatchObject({ code: "download-unavailable" });
    expect(await guardianTempRoots()).toEqual(before);
  });

  it("reports all pair cleanup failures", async () => {
    const forgedArtifact = (suffix: string): AcquiredPackageArtifact => ({
      dependency: "fixture-package",
      version: "1.0.0",
      source: "npm",
      tarballUrl: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
      verification: {
        verified: true,
        method: "sri",
        algorithm: "sha512",
        integrity: sri(Buffer.from(suffix)),
      },
      temporaryRoot: path.join(tmpdir(), `guardian-artifact-forged-${suffix}`),
      archivePath: "",
      extractionRoot: "",
      packagePath: "",
      downloadedBytes: 0,
    });

    await expect(cleanupDependencyArtifactPair({
      installed: forgedArtifact("installed"),
      target: forgedArtifact("target"),
      deduplicated: false,
    })).rejects.toMatchObject({
      code: "cleanup-failed",
      cause: expect.objectContaining({ errors: expect.any(Array) }),
    });
  });

  it("rejects a target produced from another installed context", async () => {
    const fixture = registryFixture();
    const mismatchedTarget = {
      ...resolvedTarget(fixture.dependency, "2.0.0"),
      installedVersion: "0.9.0",
    };

    await expect(acquireDependencyArtifactPair(
      dependencyContext(fixture.dependency, fixture.version),
      mismatchedTarget,
      { fetch: fixture.fetch },
    )).rejects.toMatchObject({ code: "target-context-mismatch" });
  });

  it("keeps M4 target resolution compatible with artifact metadata", async () => {
    const fixture = registryFixture();
    const resolver = createDependencyTargetResolver({ fetch: fixture.fetch });

    await expect(resolver.resolve(
      dependencyContext(fixture.dependency, fixture.version),
      "latest",
    )).resolves.toMatchObject({
      status: "resolved",
      resolvedVersion: fixture.version,
    });
  });

  it("keeps M4 resolution independent from malformed artifact fields", async () => {
    const malformedDistFetch: typeof fetch = async () => new Response(JSON.stringify({
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { dist: { tarball: 42 } } },
    }));
    const resolver = createDependencyTargetResolver({ fetch: malformedDistFetch });

    await expect(resolver.resolve(
      dependencyContext("fixture-package", "1.0.0"),
      "latest",
    )).resolves.toMatchObject({ status: "resolved", resolvedVersion: "1.0.0" });
    await expect(acquirePackageArtifact("fixture-package", "1.0.0", {
      fetch: malformedDistFetch,
    })).rejects.toMatchObject({ code: "artifact-metadata-invalid" });
  });

  it("keeps scan offline after adding artifact acquisition", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(scanProject(sampleProjectPath)).resolves.toMatchObject({
      projectName: "sample-typescript-app",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
